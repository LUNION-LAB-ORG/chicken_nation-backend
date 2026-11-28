/**
 * REPÈRES DU JOURNAL D'AUDIT (28/11). Règles pures.
 *
 * Le journal ne gardait que l'identifiant technique de la cible
 * (« #a4559e28 ») : taper la référence d'une commande dans « Audits » ne
 * ramenait rien. Chaque ligne garde désormais des repères lisibles, figés à
 * l'écriture comme le nom de l'auteur :
 *
 *  - `target_ref`   : la référence (commande, course, paiement, incident) ;
 *  - `target_name`  : la personne concernée (client, livreur, personnel) ;
 *  - `target_phone` : son numéro ;
 *  - `search_text`  : tout ce qui se cherche, en minuscules et sans accents
 *    (références, noms, numéros en chiffres, adresses électroniques).
 *
 * Ce fichier dit QUOI aller lire (les cibles d'une requête) et COMMENT
 * l'écrire et le chercher. La lecture en base est dans
 * `audit-reperes.lecture.ts`.
 */
import { Prisma } from '@prisma/client';
import { numeroCherche, sansAccents } from 'src/modules/order/helpers/recherche-commande.rules';

/** Ce qu'une ligne du journal peut désigner et que l'on sait relire. */
export type TypeCible =
  | 'order'
  | 'delivery'
  | 'paiement'
  | 'incident'
  | 'customer'
  | 'crmContact'
  | 'deliverer'
  | 'course'
  | 'user';

/** Une chose à relire : par identifiant, ou par référence pour une commande. */
export interface Cible {
  type: TypeCible;
  id?: string;
  reference?: string;
}

/** Ce qu'on a lu d'une cible. */
export interface Fiche {
  ref?: string | null;
  nom?: string | null;
  telephone?: string | null;
  /** Autres textes cherchables : second nom, second numéro, adresse électronique, autre référence. */
  autres?: (string | null | undefined)[];
}

/** Colonnes de repères d'une ligne du journal. */
export interface Reperes {
  target_ref: string | null;
  target_name: string | null;
  target_phone: string | null;
  search_text: string | null;
}

/** Ce que l'intercepteur sait d'une requête, en plus de la ligne elle-même. */
export interface IndicesReperes {
  cibles?: Cible[];
  /** Lu directement dans la requête, sans lecture en base. */
  fiches?: Fiche[];
}

/** Cibles relues pour une ligne, au plus. */
export const CIBLES_MAX = 4;
const CHAMP_MAX = 120;
const RECHERCHE_MAX = 600;
const MOTS_MAX = 4;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Retours privés « Ton avis compte » : rien de personnel n'est copié au
 * journal (droit à l'effacement annoncé sur le site). Aucun repère non plus.
 */
export function sansReperes(chemin: string | null | undefined): boolean {
  return /\/avis-prives(\/|$)/.test(chemin ?? '');
}

// ---------------------------------------------------------------------------
// Quelles cibles relire
// ---------------------------------------------------------------------------

/**
 * Type désigné par un identifiant, d'après le segment qui le précède dans le
 * chemin : `/orders/<id>`, `/orders/relances/<id>/prendre`,
 * `/courses/commandes/<id>/affecter`, `/courses/deliveries/<id>/confirm`,
 * `/crm/contacts/<id>/calls`. Un segment inconnu laisse la main au module
 * (`/customer/admin/<id>`).
 */
const TYPE_PAR_SEGMENT: Record<string, TypeCible> = {
  orders: 'order',
  relances: 'order',
  commandes: 'order',
  deliveries: 'delivery',
  paiements: 'paiement',
  incidents: 'incident',
  customer: 'customer',
  contacts: 'crmContact',
  deliverers: 'deliverer',
  courses: 'course',
  users: 'user',
};

/** Clés d'un corps de requête ou d'un détail d'événement qui désignent une cible. */
const TYPE_PAR_CLE: Record<string, TypeCible> = {
  order_id: 'order',
  orderid: 'order',
  customer_id: 'customer',
  customerid: 'customer',
  client_id: 'customer',
  clientid: 'customer',
  deliverer_id: 'deliverer',
  delivererid: 'deliverer',
  course_id: 'course',
  courseid: 'course',
};

/** Clés qui portent la référence d'une commande (événements de paiement). */
const CLES_REFERENCE_COMMANDE = new Set(['reference_commande', 'order_reference']);

const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Segments du chemin, sans le préfixe `/api/v1` ni la requête. */
export function segmentsDuChemin(chemin: string | null | undefined): string[] {
  return (chemin ?? '')
    .split('?')[0]
    .replace(/^\/api\/v\d+\//, '/')
    .split('/')
    .filter(Boolean);
}

/** Cibles désignées par les identifiants du chemin. */
export function ciblesDuChemin(chemin: string | null | undefined): Cible[] {
  const segments = segmentsDuChemin(chemin);
  const cibles: Cible[] = [];
  segments.forEach((segment, i) => {
    if (!UUID_RE.test(segment)) return;
    const type = TYPE_PAR_SEGMENT[segments[i - 1]] ?? TYPE_PAR_SEGMENT[segments[0]];
    if (type) cibles.push({ type, id: segment });
  });
  return cibles;
}

/** Cibles désignées par les clés d'un objet (`order_id`, `customer_id`, `reference_commande`…). */
export function ciblesDuContenu(contenu: unknown): Cible[] {
  if (!estObjet(contenu)) return [];
  const cibles: Cible[] = [];
  for (const [cle, valeur] of Object.entries(contenu)) {
    const lu = texte(valeur);
    if (!lu) continue;
    const nom = cle.toLowerCase();
    const type = TYPE_PAR_CLE[nom];
    if (type && UUID_RE.test(lu)) cibles.push({ type, id: lu });
    else if (CLES_REFERENCE_COMMANDE.has(nom)) cibles.push({ type: 'order', reference: lu.slice(0, CHAMP_MAX) });
  }
  return cibles;
}

/**
 * Création : le chemin ne porte pas encore d'identifiant, la réponse si
 * (`POST /orders` renvoie la commande créée). Le type vient du chemin.
 */
export function ciblesDeLaReponse(methode: string, chemin: string | null | undefined, reponse: unknown): Cible[] {
  if (!estObjet(reponse)) return [];
  const corps = [reponse, reponse.data, reponse.order].filter(estObjet);
  const cibles: Cible[] = [];
  const segments = segmentsDuChemin(chemin);
  if (methode === 'POST' && !segments.some((s) => UUID_RE.test(s))) {
    const type = TYPE_PAR_SEGMENT[segments[segments.length - 1]] ?? TYPE_PAR_SEGMENT[segments[0]];
    const id = corps.map((c) => texte(c.id)).find((v) => !!v && UUID_RE.test(v));
    if (type && id) cibles.push({ type, id });
  }
  for (const c of corps) cibles.push(...ciblesDuContenu(c));
  return cibles;
}

/** Cibles d'une ligne écrite directement par un module (sans requête) : sa cible et son détail. */
export function ciblesDeLEntree(entree: {
  module?: string | null;
  entity_id?: string | null;
  path?: string | null;
  metadata?: unknown;
}): Cible[] {
  const cibles = ciblesDuChemin(entree.path);
  const type = TYPE_PAR_SEGMENT[entree.module ?? ''];
  if (type && entree.entity_id && UUID_RE.test(entree.entity_id)) cibles.push({ type, id: entree.entity_id });
  cibles.push(...ciblesDuContenu(entree.metadata));
  return cibles;
}

/** Sans doublon, dans l'ordre reçu, `CIBLES_MAX` au plus. */
export function ciblesRetenues(cibles: Cible[]): Cible[] {
  const vues = new Set<string>();
  const retenues: Cible[] = [];
  for (const c of cibles) {
    const cle = `${c.type}:${c.id ?? ''}:${c.reference ?? ''}`;
    if ((!c.id && !c.reference) || vues.has(cle)) continue;
    vues.add(cle);
    retenues.push(c);
    if (retenues.length >= CIBLES_MAX) break;
  }
  return retenues;
}

// ---------------------------------------------------------------------------
// Ce qui se lit sans la base
// ---------------------------------------------------------------------------

/**
 * Repères écrits dans le corps d'une requête : le numéro, le nom ou
 * l'adresse électronique que l'agent vient de saisir (commande au téléphone,
 * connexion refusée…). Seules ces clés sont lues : aucun mot de passe, code
 * ou jeton ne passe par ici.
 */
export function ficheDuCorps(corps: unknown): Fiche | null {
  if (!estObjet(corps)) return null;
  const lire = (...cles: string[]) => cles.map((c) => texte(corps[c])).find(Boolean) ?? null;
  const expurge = (v: string | null) => (v && v !== '***' ? v : null);
  const prenomNom = [lire('first_name', 'firstName'), lire('last_name', 'lastName')].filter(Boolean).join(' ');
  const fiche: Fiche = {
    ref: expurge(lire('reference')),
    nom: expurge(lire('fullname', 'fullName') ?? (prenomNom || null)),
    telephone: expurge(lire('phone', 'telephone', 'phone_number')),
    autres: [expurge(lire('email'))],
  };
  return fiche.ref || fiche.nom || fiche.telephone || fiche.autres?.some(Boolean) ? fiche : null;
}

/** Le compte qui a fait la requête quand ce n'est pas le personnel : un client, un livreur. */
export function ficheDuCompte(compte: unknown): Fiche | null {
  if (!estObjet(compte) || compte.role) return null;
  const nom = [texte(compte.first_name), texte(compte.last_name)].filter(Boolean).join(' ');
  const fiche: Fiche = { nom: nom || null, telephone: texte(compte.phone), autres: [texte(compte.email)] };
  return fiche.nom || fiche.telephone ? fiche : null;
}

// ---------------------------------------------------------------------------
// Écrire
// ---------------------------------------------------------------------------

/** Minuscules, sans accents, espaces resserrés : « Koné » et « kone » se valent. */
export function texteNu(valeur: string | null | undefined): string {
  return sansAccents(valeur ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const chiffres = (valeur: string | null | undefined) => (valeur ?? '').replace(/\D/g, '');
const FORME_NUMERO = /^\+?[\d\s.\-()]{4,}$/;
const court = (valeur: string | null | undefined) => {
  const lu = (valeur ?? '').replace(/\s+/g, ' ').trim();
  return lu ? lu.slice(0, CHAMP_MAX) : null;
};

/**
 * Colonnes de repères à partir des fiches lues, dans l'ordre : la première
 * référence, le premier nom et le premier numéro s'affichent ; tout le reste
 * se cherche. Un numéro est rangé en chiffres : « +225 07 07 07 07 07 »
 * devient « 2250707070707 », que « 0707070707 » ou « 7070 » retrouvent.
 */
export function assemblerReperes(fiches: (Fiche | null | undefined)[]): Reperes | null {
  const lues = fiches.filter((f): f is Fiche => !!f);
  const ref = lues.map((f) => court(f.ref)).find(Boolean) ?? null;
  const nom = lues.map((f) => court(f.nom)).find(Boolean) ?? null;
  const telephone = lues.map((f) => court(f.telephone)).find(Boolean) ?? null;

  const mots: string[] = [];
  const ajouter = (valeur: string | null | undefined) => {
    const lu = texteNu(valeur);
    if (lu && !mots.includes(lu)) mots.push(lu);
  };
  for (const f of lues) {
    ajouter(f.ref);
    ajouter(f.nom);
    ajouter(chiffres(f.telephone));
    // Un second numéro se range en chiffres lui aussi.
    for (const autre of f.autres ?? []) ajouter(autre && FORME_NUMERO.test(autre.trim()) ? chiffres(autre) : autre);
  }
  if (!ref && !nom && !telephone && !mots.length) return null;
  return {
    target_ref: ref,
    target_name: nom,
    target_phone: telephone,
    search_text: mots.join(' ').slice(0, RECHERCHE_MAX) || null,
  };
}

// ---------------------------------------------------------------------------
// Chercher
// ---------------------------------------------------------------------------

const contient = (valeur: string) => ({ contains: valeur, mode: 'insensitive' as const });

/**
 * Condition de recherche du journal pour une saisie. Comme avant : auteur,
 * chemin, résumé, identifiant de la cible. En plus : la référence, le nom de
 * la personne concernée (tous les mots, accents ignorés) et son numéro, entier
 * ou en partie, sous toutes ses écritures.
 */
export function conditionRechercheAudit(saisie: string | null | undefined): Prisma.AuditLogWhereInput | null {
  const q = (saisie ?? '').replace(/\s+/g, ' ').trim().replace(/^#\s*/, '').trim();
  if (!q) return null;

  const ou: Prisma.AuditLogWhereInput[] = [
    { actor_name: contient(q) },
    { path: contient(q) },
    { summary: contient(q) },
    { entity_id: contient(q) },
  ];

  // « +225 07 07 07 07 07 » : un numéro se cherche par ses chiffres, que portent
  // toutes les écritures, jamais mot à mot (« 07 », « 07 »… ramènerait tout).
  // Les chiffres d'une référence (« 00042 ») se retrouvent de la même façon.
  const numero = numeroCherche(q);
  if (numero) {
    ou.push({ search_text: { contains: numero } });
    return { OR: ou };
  }

  const mots = texteNu(q).split(' ').filter(Boolean).slice(0, MOTS_MAX);
  if (mots.length) ou.push({ AND: mots.map((mot) => ({ search_text: { contains: mot } })) });

  return { OR: ou };
}
