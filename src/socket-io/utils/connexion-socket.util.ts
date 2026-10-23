import { Prisma } from '@prisma/client';
import type { ExtendedError } from 'socket.io';

import { ConnectedUser } from '../interfaces/app.gateway.interface';

/**
 * CONNEXION À LA PASSERELLE `/app` : ce que voit l'appli, ce qu'elle peut faire.
 *
 * Le contrôle d'entrée (intergiciel socket.io, `AppGateway.afterInit`) décide
 * AVANT que le client ne reçoive « connect ». Trois issues :
 *
 *  1. Acceptée. Le socket est déjà dans ses salles quand l'appli reçoit
 *     « connect » ; le serveur émet ensuite `connexion:acceptee`
 *     (`{ type, id }`). Pour un livreur, l'offre en attente est renvoyée
 *     juste après (`course:offer:new`).
 *
 *  2. Refusée pour de bon. L'appli reçoit `connect_error` : `err.message` vaut
 *     le motif, `err.data` vaut `{ motif, rafraichir_jeton }`. socket.io ne
 *     relance PAS seul (socket.active passe à false) : à l'appli de relire ou
 *     rafraîchir son jeton, de le reposer dans la requête, puis d'appeler
 *     `socket.connect()` sur la même instance. Motifs :
 *       - `JETON_ABSENT` : aucun jeton dans `auth.token` ni `query.token` ;
 *       - `TYPE_INVALIDE` : `type` absent ou autre que user, customer, deliverer ;
 *       - `JETON_EXPIRE` : jeton bien signé mais périmé ;
 *       - `JETON_INVALIDE` : signature refusée (autre secret, jeton abîmé) ;
 *       - `COMPTE_INCONNU` : compte introuvable ou plus actif. Inutile de
 *         réessayer avec le même compte.
 *
 *  3. Panne passagère (base injoignable, réserve de connexions saturée). Après
 *     quelques essais, le serveur ferme le transport SANS refuser : l'appli voit
 *     « disconnect » de raison « transport close », socket.active reste vrai et
 *     socket.io se reconnecte seul sur la même instance, écouteurs intacts.
 *     Rien à faire côté appli ; les anciennes versions en profitent aussi.
 *
 * Identifiants : `token` et `type` dans `auth` (de préférence une fonction,
 * relue à chaque tentative) ou dans la requête, comme jusqu'ici. `version`
 * (facultative, même endroit) est écrite dans le journal avec la connexion.
 *
 * Vérifier la connexion : `socket.timeout(5000).emitWithAck('ping')` répond
 * `{ connecte: true }` si le serveur connaît ce socket, `{ connecte: false }`
 * sinon (à reconnecter).
 *
 * Avant, les trois cas finissaient de la même façon : « connect », puis
 * coupure décidée par le serveur (« io server disconnect »), sans journal. Une
 * coupure décidée par le serveur n'est jamais relancée par socket.io : sur une
 * simple erreur de base, le livreur restait sans offres jusqu'au redémarrage
 * de son appli.
 */

/** Événement émis au client une fois la connexion acceptée et les salles rejointes. */
export const EVENEMENT_CONNEXION_ACCEPTEE = 'connexion:acceptee';

export type TypeConnexion = ConnectedUser['type'];

const TYPES_CONNEXION: ReadonlySet<string> = new Set<TypeConnexion>(['user', 'customer', 'deliverer']);

export type MotifRefusConnexion =
  | 'JETON_ABSENT'
  | 'TYPE_INVALIDE'
  | 'JETON_EXPIRE'
  | 'JETON_INVALIDE'
  | 'COMPTE_INCONNU';

/** Motifs après lesquels un jeton relu ou rafraîchi peut suffire. */
const MOTIFS_JETON: ReadonlySet<MotifRefusConnexion> = new Set<MotifRefusConnexion>([
  'JETON_ABSENT',
  'JETON_EXPIRE',
  'JETON_INVALIDE',
]);

/** Erreur passée à `next()` : socket.io l'envoie telle quelle dans `connect_error`. */
export function erreurRefus(motif: MotifRefusConnexion): ExtendedError {
  const erreur: ExtendedError = new Error(motif);
  erreur.data = { motif, rafraichir_jeton: MOTIFS_JETON.has(motif) };
  return erreur;
}

/**
 * Jeton, type et version de l'appli. `auth` (porté par le paquet de
 * connexion, relu à chaque tentative quand l'appli passe une fonction)
 * d'abord, puis la requête (`?token=…&type=…`), seule utilisée par les applis
 * jusqu'ici. `version` est facultative et ne sert qu'au journal.
 */
export function lireIdentifiants(handshake: {
  auth?: Record<string, unknown> | null;
  query?: Record<string, unknown> | null;
}): { token: string; type: TypeConnexion | null; version: string | null } {
  const token = texte(handshake.auth?.token) || texte(handshake.query?.token);
  const type = texte(handshake.auth?.type) || texte(handshake.query?.type);
  const version = texte(handshake.auth?.version) || texte(handshake.query?.version);
  return {
    token,
    type: TYPES_CONNEXION.has(type) ? (type as TypeConnexion) : null,
    // Écrite telle quelle dans le journal : caractères sûrs seulement, 40 au plus.
    version: version.replace(/[^\w.+\-/: ]/g, '').slice(0, 40) || null,
  };
}

function texte(valeur: unknown): string {
  return typeof valeur === 'string' ? valeur.trim() : '';
}

/**
 * Erreur de base qui peut passer d'elle-même : on réessaie, et on laisse le
 * client se reconnecter au lieu de le refuser.
 *
 * Seules les erreurs qui se reproduiraient à l'identique sont définitives :
 * requête mal formée (`PrismaClientValidationError`) ou erreur de requête
 * connue hors connexion et réserve (P2xxx, sauf P2024 réserve saturée, P2028
 * transaction, P2034 conflit, P2037 trop de connexions). Le reste (P1xxx,
 * initialisation, moteur, réseau, délai) est passager.
 */
export function estErreurPassagere(erreur: unknown): boolean {
  if (erreur instanceof Prisma.PrismaClientValidationError) return false;
  if (erreur instanceof Prisma.PrismaClientKnownRequestError) {
    return erreur.code.startsWith('P1') || CODES_PASSAGERS.has(erreur.code);
  }
  return true;
}

const CODES_PASSAGERS: ReadonlySet<string> = new Set(['P2024', 'P2028', 'P2034', 'P2037']);

/**
 * Pour le journal : le code Prisma (P1001…), ou le nom et la première ligne
 * du message. Prisma écrit déjà le détail complet (`prisma:error`).
 */
export function codeErreur(erreur: unknown): string {
  const e = erreur as { code?: unknown; errorCode?: unknown; name?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string' && e.code) return e.code;
  if (typeof e?.errorCode === 'string' && e.errorCode) return e.errorCode;
  const nom = typeof e?.name === 'string' && e.name ? e.name : 'Erreur';
  const ligne = typeof e?.message === 'string' ? e.message.split('\n').find((l) => l.trim()) : undefined;
  return ligne ? `${nom} : ${ligne.trim().slice(0, 120)}` : nom;
}

/**
 * Attentes avant chaque nouvel essai d'identification sur une panne passagère.
 * Pas de nouvel essai une fois `BUDGET_IDENTIFICATION_MS` écoulé depuis le
 * premier : une requête qui attend la réserve peut déjà durer plusieurs
 * secondes.
 */
export const ATTENTES_REPRISE_MS: readonly number[] = [400, 1200];
export const BUDGET_IDENTIFICATION_MS = 5000;

/**
 * Sujet d'un jeton, lu SANS vérification, pour le journal seulement. Utilisé
 * pour un jeton périmé : la signature est contrôlée avant l'échéance, le
 * sujet est donc authentique.
 */
export function sujetNonVerifie(token: string): string | null {
  try {
    const charge = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof charge?.sub === 'string' ? charge.sub : null;
  } catch {
    return null;
  }
}

/** Huit premiers caractères d'un identifiant, comme le reste des journaux. */
export const court = (id: string | null | undefined): string => (id ? id.slice(0, 8) : '?');

/** Libellé d'un type de connexion dans le journal. */
export const LIBELLE_TYPE: Record<TypeConnexion, string> = {
  customer: 'client',
  user: 'personnel',
  deliverer: 'livreur',
};
