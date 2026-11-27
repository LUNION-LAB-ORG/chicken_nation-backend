/**
 * RECHERCHE D'UNE COMMANDE (27/11). Règles pures.
 *
 * Le champ de recherche de l'écran « Commandes » ne lisait que la référence.
 * Le personnel cherche d'abord par le client : son numéro (celui qui appelle),
 * son nom, puis seulement la référence. Une seule saisie interroge donc :
 *
 *  - la référence de la commande (en partie) ;
 *  - le nom du client : celui de son compte, celui inscrit sur la commande,
 *    et la note (« Commande pour Awa Koné, 07 07 07 07 07 » quand le client
 *    commande pour une autre personne) ;
 *  - le numéro du client, en entier ou en partie : compte, commande, note ;
 *  - l'adresse électronique, quand la saisie contient « @ » ;
 *  - le code promo utilisé et la référence d'un paiement (en entier).
 *
 * Un rôle aux coordonnées masquées (marketing) ne cherche ni par numéro ni
 * par adresse électronique : la réponse dirait si des chiffres figurent dans
 * un numéro qu'il ne doit pas lire.
 */
import { Prisma } from '@prisma/client';

/** En dessous, la saisie ne filtre rien. */
export const RECHERCHE_MIN = 2;
export const RECHERCHE_MAX = 80;
/** Mots lus dans un nom : au-delà, le reste de la saisie est ignoré. */
const MOTS_MAX = 4;
/** En dessous, des chiffres ne désignent pas un numéro. */
const CHIFFRES_MIN = 4;
const INDICATIF_CI = '225';

/** Saisie resserrée (« # » de tête retiré), ou `null` si elle est trop courte. */
export function lireRecherche(saisie: unknown): string | null {
  if (typeof saisie !== 'string') return null;
  const texte = saisie
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#\s*/, '')
    .slice(0, RECHERCHE_MAX)
    .trim();
  return texte.length >= RECHERCHE_MIN ? texte : null;
}

export function sansAccents(texte: string): string {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Chiffres d'une saisie qui a la forme d'un numéro (chiffres, espaces,
 * points, tirets, parenthèses, « + »), sinon `null`.
 *
 * Les numéros sont rangés au format `+225XXXXXXXXXX` : un numéro ivoirien
 * complet écrit avec son indicatif (+225, 00225, 225) est ramené à ses dix
 * chiffres, qui se retrouvent dans toutes les écritures.
 */
export function numeroCherche(texte: string): string | null {
  if (!/^\+?[\d\s.\-()]+$/.test(texte)) return null;
  let chiffres = texte.replace(/\D/g, '');
  if (chiffres.startsWith('00')) chiffres = chiffres.slice(2);
  if (chiffres.startsWith(INDICATIF_CI) && chiffres.length === 13) {
    chiffres = chiffres.slice(INDICATIF_CI.length);
  }
  return chiffres.length >= CHIFFRES_MIN ? chiffres : null;
}

/** « 0707070707 » devient « 07 07 07 07 07 », l'écriture de la note. */
function numeroLisible(chiffres: string): string {
  return chiffres.replace(/(\d{2})(?=\d)/g, '$1 ');
}

/** Mots d'un nom : aucun quand la saisie ne contient pas de lettre. */
export function motsDeRecherche(texte: string): string[] {
  if (!/\p{L}/u.test(texte)) return [];
  return texte.split(' ').filter(Boolean).slice(0, MOTS_MAX);
}

/** Un mot tel que saisi, et sans ses accents (« Koné » trouve aussi « Kone »). */
function formes(mot: string): string[] {
  const nu = sansAccents(mot);
  return nu === mot ? [mot] : [mot, nu];
}

const contient = (valeur: string) => ({ contains: valeur, mode: 'insensitive' as const });

export interface OptionsRecherche {
  /** Rôle aux coordonnées masquées : ni numéro, ni adresse électronique, ni note. */
  sansCoordonnees?: boolean;
  /**
   * Clients dont le nom porte tous les mots, accents ignorés (lus à part par
   * le service : « Kone » y trouve « Koné »). Absent : le nom du compte est
   * comparé tel qu'il est écrit.
   */
  clientsAuNom?: string[] | null;
}

/** Condition à ajouter au filtre des commandes pour une saisie déjà lue. */
export function conditionRecherche(
  texte: string,
  { sansCoordonnees = false, clientsAuNom = null }: OptionsRecherche = {},
): Prisma.OrderWhereInput {
  const ou: Prisma.OrderWhereInput[] = [{ reference: contient(texte) }];

  // Code promo et référence de paiement : en entier, pour ne pas ramener
  // toutes les commandes dont le code ressemble à un nom.
  if (!texte.includes(' ')) {
    ou.push({ code_promo: { equals: texte, mode: 'insensitive' } });
    ou.push({ paiements: { some: { reference: { equals: texte, mode: 'insensitive' } } } });
  }

  const mots = motsDeRecherche(texte);
  if (mots.length) {
    const tousLesMots = (champ: 'fullname' | 'note'): Prisma.OrderWhereInput => ({
      AND: mots.map((mot) => ({ OR: formes(mot).map((forme) => ({ [champ]: contient(forme) })) })),
    });
    ou.push(tousLesMots('fullname'));
    if (!sansCoordonnees) ou.push(tousLesMots('note'));

    if (clientsAuNom) {
      if (clientsAuNom.length) ou.push({ customer_id: { in: clientsAuNom } });
    } else {
      ou.push({
        customer: {
          AND: mots.map((mot) => ({
            OR: formes(mot).flatMap((forme) => [
              { first_name: contient(forme) },
              { last_name: contient(forme) },
            ]),
          })),
        },
      });
    }
  }

  if (!sansCoordonnees) {
    const numero = numeroCherche(texte);
    if (numero) {
      ou.push({ phone: { contains: numero } });
      ou.push({ customer: { phone: { contains: numero } } });
      ou.push({ note: { contains: numero } });
      if (numero.length === 10) ou.push({ note: { contains: numeroLisible(numero) } });
    }
    if (texte.includes('@')) {
      ou.push({ email: contient(texte) });
      ou.push({ customer: { email: contient(texte) } });
    }
  }

  return { OR: ou };
}

/** Lettres accentuées que la base ramène à leur lettre nue pour comparer un nom. */
export const LETTRES_ACCENTUEES = 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ';
export const LETTRES_NUES = 'aaaaaaceeeeiiiinooooouuuuyy';

/**
 * Motifs `LIKE` des mots d'un nom, pour la lecture des clients accents
 * ignorés : minuscules, sans accents, caractères jokers neutralisés.
 */
export function motifsDuNom(mots: string[]): string[] {
  return mots.map((mot) => `%${sansAccents(mot).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}
