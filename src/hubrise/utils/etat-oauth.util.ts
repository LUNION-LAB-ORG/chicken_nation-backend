/**
 * Paramètre `state` du flux OAuth HubRise : signé, lié à l'utilisateur, expirant.
 *
 * ⚠️ Avant ce correctif, `state` valait l'identifiant du restaurant EN CLAIR et
 * le retour OAuth (sans garde, par nature) le croyait sur parole. Or les
 * identifiants de restaurant sont publics : n'importe qui pouvait forger une
 * URL d'autorisation avec le restaurant X, autoriser avec SON compte HubRise,
 * et relier X à sa propre location (jeton légitime écrasé, commandes et
 * clients créés dans X par ses webhooks).
 *
 * Désormais le serveur signe, au moment où un ADMIN authentifié demande la
 * connexion, le restaurant, l'utilisateur, une expiration courte et un nonce à
 * usage unique. Le retour vérifie cette signature à temps constant AVANT tout
 * échange de code.
 *
 * Format : `v1.<restaurantId>.<userId>.<exp>.<nonce>.<sig>`
 * - `exp` : secondes depuis l'époque Unix ;
 * - `nonce` : 16 octets aléatoires en base64url (22 caractères) ;
 * - `sig` : HMAC-SHA256 en base64url (43 caractères) des cinq premières parties.
 *
 * Aucune partie ne contient de point (UUID, entier, base64url), le découpage
 * est donc sans ambiguïté.
 *
 * Fonctions pures (horloge et clé passées en paramètre) : testées dans
 * `etat-oauth.util.spec.ts`.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { estUuid } from 'src/common/utils/identifiant.util';

export const VERSION_ETAT = 'v1';

/** Durée de validité d'un lien de connexion : dix minutes. */
export const DUREE_ETAT_SECONDES = 600;

/** Longueur minimale d'une clé dédiée (`HUBRISE_STATE_SECRET`). */
export const LONGUEUR_MIN_CLE_ETAT = 32;

/** Séparation de domaine pour la clé dérivée de `TOKEN_SECRET`. */
export const DOMAINE_CLE_ETAT = 'hubrise-oauth-state:v1';

/** Tolérance d'horloge sur une expiration « trop lointaine ». */
const TOLERANCE_SECONDES = 60;

const NONCE = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const EXPIRATION = /^\d{1,12}$/;

/** Borne la taille lue : un `state` légitime fait environ 150 caractères. */
const LONGUEUR_MAX_ETAT = 256;

export type MotifRefusEtat = 'lien_invalide' | 'lien_expire';

export type ResultatEtat =
  | { ok: true; restaurantId: string; userId: string; nonce: string; expiration: number }
  | { ok: false; motif: MotifRefusEtat };

/** Nonce à usage unique : 16 octets aléatoires en base64url. */
export function nouveauNonce(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Choisit la clé de signature.
 * 1. `HUBRISE_STATE_SECRET` si elle fait au moins 32 caractères ;
 * 2. sinon une clé dérivée de `TOKEN_SECRET` par HMAC avec une étiquette de
 *    domaine : la clé des jetons n'est jamais réutilisée telle quelle ;
 * 3. sinon une erreur : jamais de signature avec une clé vide.
 *
 * `dedieeIgnoree` signale une clé dédiée présente mais trop courte, pour que
 * l'appelant le dise dans les journaux.
 */
export function cleEtatDepuis(
  secretDedie: string | undefined,
  tokenSecret: string | undefined,
): { cle: Buffer; source: 'dediee' | 'derivee'; dedieeIgnoree: boolean } {
  const dediee = (secretDedie ?? '').trim();
  if (dediee.length >= LONGUEUR_MIN_CLE_ETAT) {
    return { cle: Buffer.from(dediee, 'utf8'), source: 'dediee', dedieeIgnoree: false };
  }

  const base = (tokenSecret ?? '').trim();
  if (!base) {
    throw new Error(
      'Aucune clé pour signer la connexion HubRise : renseignez HUBRISE_STATE_SECRET (32 caractères au moins) ou TOKEN_SECRET.',
    );
  }

  return {
    cle: createHmac('sha256', base).update(DOMAINE_CLE_ETAT).digest(),
    source: 'derivee',
    dedieeIgnoree: dediee.length > 0,
  };
}

/** Clé de cache du nonce. */
export function cleCacheNonce(nonce: string): string {
  return `hubrise:etat:${nonce}`;
}

/**
 * Valeur posée en cache pour un nonce : relie le nonce au restaurant ET à
 * l'utilisateur qui a demandé la connexion.
 */
export function valeurNonce(restaurantId: string, userId: string): string {
  return `${restaurantId.toLowerCase()}:${userId.toLowerCase()}`;
}

function controlerCle(cle: Buffer): void {
  if (!Buffer.isBuffer(cle) || cle.length < LONGUEUR_MIN_CLE_ETAT) {
    throw new Error('Clé de signature de la connexion HubRise absente ou trop courte.');
  }
}

function signature(charge: string, cle: Buffer): Buffer {
  return createHmac('sha256', cle).update(charge).digest();
}

/**
 * Signe un `state`. Refuse (exception) des entrées mal formées : on ne signe
 * jamais n'importe quoi.
 *
 * @param maintenant - horloge en millisecondes (`Date.now()`)
 */
export function signerEtat(
  p: { restaurantId: string; userId: string; maintenant: number; nonce: string },
  cle: Buffer,
): string {
  controlerCle(cle);
  if (!estUuid(p.restaurantId) || !estUuid(p.userId)) {
    throw new Error('Identifiant de restaurant ou d’utilisateur invalide.');
  }
  if (!NONCE.test(p.nonce)) {
    throw new Error('Nonce de connexion HubRise invalide.');
  }

  const expiration = Math.floor(p.maintenant / 1000) + DUREE_ETAT_SECONDES;
  const charge = [
    VERSION_ETAT,
    p.restaurantId.toLowerCase(),
    p.userId.toLowerCase(),
    String(expiration),
    p.nonce,
  ].join('.');

  return `${charge}.${signature(charge, cle).toString('base64url')}`;
}

/**
 * Vérifie un `state` reçu au retour OAuth.
 * La signature est comparée à temps constant ; l'expiration n'est jugée
 * qu'une fois la signature établie (un lien falsifié est « invalide », pas
 * « expiré »).
 *
 * @param maintenant - horloge en millisecondes (`Date.now()`)
 */
export function verifierEtat(state: unknown, cle: Buffer, maintenant: number): ResultatEtat {
  controlerCle(cle);
  const invalide: ResultatEtat = { ok: false, motif: 'lien_invalide' };

  if (typeof state !== 'string' || state.length === 0 || state.length > LONGUEUR_MAX_ETAT) {
    return invalide;
  }

  const parties = state.split('.');
  if (parties.length !== 6) return invalide;

  const [version, restaurantId, userId, exp, nonce, sig] = parties;
  if (version !== VERSION_ETAT) return invalide;
  if (!estUuid(restaurantId) || !estUuid(userId)) return invalide;
  if (!EXPIRATION.test(exp) || !NONCE.test(nonce) || !SIGNATURE.test(sig)) return invalide;

  const attendue = signature(parties.slice(0, 5).join('.'), cle);
  const recue = Buffer.from(sig, 'base64url');
  // Écriture canonique exigée : le dernier caractère base64url porte deux bits
  // ignorés au décodage, donc plusieurs chaînes donnent la même signature.
  // Un seul `state` accepté par signature.
  if (recue.toString('base64url') !== sig) return invalide;
  if (recue.length !== attendue.length || !timingSafeEqual(recue, attendue)) {
    return invalide;
  }

  const expiration = Number(exp);
  const secondes = Math.floor(maintenant / 1000);
  // Signée par nous mais trop lointaine : jamais émise par `signerEtat`.
  if (expiration > secondes + DUREE_ETAT_SECONDES + TOLERANCE_SECONDES) return invalide;
  if (expiration < secondes) return { ok: false, motif: 'lien_expire' };

  return {
    ok: true,
    restaurantId: restaurantId.toLowerCase(),
    userId: userId.toLowerCase(),
    nonce,
    expiration,
  };
}
