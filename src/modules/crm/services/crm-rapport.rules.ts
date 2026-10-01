/**
 * Rapport « Où en sommes-nous » : contrat, comparaisons et phrases.
 *
 * Ce fichier ne lit aucune base : il définit la forme du rapport (identique
 * à celle du backoffice, `features/crm/types/analyse.type.ts`), la règle de
 * comparaison avec la période précédente, les formats de nombres à la
 * française et les phrases « À retenir ». Tout est testable à sec.
 */

/** Un chiffre de la période face à celui de la période précédente. */
export interface Compare {
  valeur: number;
  precedent: number;
  ecart: number;
  /**
   * Variation en pourcentage, à 0,1 près, ou `null` quand elle ne veut rien
   * dire (`comparable` à faux) : on écrit alors « 41 avant » plutôt qu'un
   * « +30 000 % » qui ferait douter du reste.
   */
  variation: number | null;
  comparable: boolean;
  /** Un montant en francs, pas un décompte. */
  monnaie?: boolean;
}

/** Un taux de la période face au précédent, l'écart en points. */
export interface Taux {
  valeur: number;
  precedent: number;
  ecart_points: number;
}

/** Un levier de croissance lu en entonnoir : entrés > appelés > joints > coupons > ventes. */
export interface Levier {
  entres: Compare;
  appeles: Compare;
  joints: Compare;
  coupons: Compare;
  ventes: Compare;
  ca: Compare;
  taux_contact: Taux;
  taux_conversion: Taux;
}

export type SegmentCapte = 'GLOVO' | 'YANGO';

export interface IRapport {
  periode: { debut: string; fin: string; jours: number };
  precedente: { debut: string; fin: string };
  edite_le: string;
  filtres: {
    publics: string[];
    campagne: { id: string; nom: string } | null;
    restaurant: { id: string; nom: string } | null;
  };
  a_retenir: string[];
  inscriptions: {
    /** Les inscrits ne sont rattachés à aucun restaurant : tout le réseau, même pour un compte de point de vente. */
    hors_restaurant: boolean;
    /** Le public « inscrits » n'est pas dans le filtre (ou une campagne est filtrée) : section à zéro. */
    hors_filtre: boolean;
    inscrits: Compare;
    ont_commande: Compare;
    sous_7_jours: Compare;
    taux_commande: Taux;
    delai_median_j: number | null;
    ca: Compare;
    sans_commande: number;
    pas: 'jour' | 'semaine';
    serie: { date: string; inscrits: number; premieres_commandes: number }[];
  };
  captes: {
    hors_filtre: boolean;
    total: Levier;
    par_public: ({ segment: SegmentCapte; libelle: string; hors_filtre: boolean } & Levier)[];
  };
  inactifs: Levier & { hors_filtre: boolean; delai_median_j: number | null };
  equipe: {
    appels: Compare;
    /** Contacts distincts appelés : un client rappelé ne compte qu'une fois (base du taux de contact). */
    appeles: Compare;
    joints: Compare;
    coupons: Compare;
    taux_contact: Taux;
    agents: { id: string; nom: string; appels: number; joints: number; coupons: number; ventes: number; ca: number }[];
  };
  resultat: {
    ventes: Compare;
    ca: Compare;
    panier_moyen: Compare;
    par_public: { segment: string; libelle: string; ventes: number; ca: number }[];
  };
  raisons: { raison: string; nombre: number; part: number }[];
}

/** Au-delà, une variation ne se lit plus : on donne le chiffre d'avant. */
const VARIATION_MAX = 1000;
/** Sous ce nombre, un décompte précédent est trop petit pour servir de base. */
const BASE_MIN_DECOMPTE = 10;

const arrondi1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Comparaison d'un chiffre à celui de la période précédente. Comparable
 * quand le précédent porte le calcul : au moins 10 pour un décompte, plus de
 * zéro pour un montant, et une variation sous 1 000 % en valeur absolue.
 */
export function comparer(valeur: number, precedent: number, monnaie = false): Compare {
  const v = Math.round(valeur);
  const p = Math.round(precedent);
  const brute = p > 0 ? arrondi1(((v - p) / p) * 100) : null;
  const base = monnaie ? p > 0 : p >= BASE_MIN_DECOMPTE;
  const comparable = brute !== null && base && Math.abs(brute) < VARIATION_MAX;
  return {
    valeur: v,
    precedent: p,
    ecart: v - p,
    variation: comparable ? brute : null,
    comparable,
    ...(monnaie ? { monnaie: true } : {}),
  };
}

/** Taux (part / total, en %) de la période et du précédent, écart en points. */
export function taux(part: number, total: number, partPrec: number, totalPrec: number): Taux {
  const valeur = total > 0 ? arrondi1((part / total) * 100) : 0;
  const precedent = totalPrec > 0 ? arrondi1((partPrec / totalPrec) * 100) : 0;
  return { valeur, precedent, ecart_points: arrondi1(valeur - precedent) };
}

export const LEVIER_VIDE: Levier = {
  entres: comparer(0, 0),
  appeles: comparer(0, 0),
  joints: comparer(0, 0),
  coupons: comparer(0, 0),
  ventes: comparer(0, 0),
  ca: comparer(0, 0, true),
  taux_contact: taux(0, 0, 0, 0),
  taux_conversion: taux(0, 0, 0, 0),
};

// ---------------------------------------------------------------------------
// Formats à la française
// ---------------------------------------------------------------------------

/** Espace insécable classique : Intl écrit une fine (U+202F) que pdfkit coupe en « 32 /479 ». */
export const INSECABLE = '\u00A0';

/** Remplace toute espace fine insécable par l'insécable classique. */
/**
 * Chaîne prête pour le PDF : l'espace fine insécable d'Intl (U+202F) devient
 * une insécable classique, et les apostrophes typographiques (U+2018, U+2019)
 * une apostrophe droite. Urbanist n'a pas ces glyphes : sans ça, « N’ont »
 * s'imprimait « Nont ».
 */
export const sansFine = (s: string) => s.replace(/\u202f/g, INSECABLE).replace(/[\u2018\u2019]/g, "'");

const formatEntier = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const formatDecimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

/** « 133 070 » */
export const fmtNombre = (n: number | null | undefined) => sansFine(formatEntier.format(Math.round(Number(n ?? 0))));
/** « 133 070 F » */
export const fmtMontant = (n: number | null | undefined) => `${fmtNombre(n)}${INSECABLE}F`;
/** « 2,5 » : une décimale au plus, virgule française. */
export const fmtDecimal = (n: number | null | undefined) => sansFine(formatDecimal.format(Number(n ?? 0)));
/** « 19,4 % » */
export const fmtPct = (n: number | null | undefined) => `${sansFine(formatDecimal.format(Number(n ?? 0)))}${INSECABLE}%`;
/** « +12 % », « -8 % » (signe moins ordinaire, jamais un tiret typographique). */
export const fmtVariation = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmtPct(Math.abs(n))}`;
/** « 2026-10-01 » devient « 01/10/2026 ». */
export const fmtDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/** Nombre suivi de son nom accordé : « 1 inscrit », « 212 inscrits », « 0 inscrit ». */
export function compter(n: number, singulier: string, pluriel = `${singulier}s`): string {
  return `${fmtNombre(n)}${INSECABLE}${Math.abs(n) >= 2 ? pluriel : singulier}`;
}

/** Durée de la période, en mots : « 7 jours », « la journée », « 60 jours ». */
export function libelleDuree(jours: number): string {
  if (jours === 1) return 'la journée';
  return compter(jours, 'jour');
}

/** La période précédente, avec sa préposition : « comparé à la semaine précédente », « aux 30 jours précédents ». */
export function libellePrecedente(jours: number): string {
  if (jours === 1) return 'à la veille';
  if (jours === 7) return 'à la semaine précédente';
  if (jours === 30 || jours === 31) return 'au mois précédent';
  return `aux ${fmtNombre(jours)} jours précédents`;
}

// ---------------------------------------------------------------------------
// Phrases « À retenir »
// ---------------------------------------------------------------------------

type Entree = Pick<IRapport, 'inscriptions' | 'captes' | 'inactifs' | 'resultat' | 'equipe'>;

/**
 * Deux à quatre phrases courtes, calculées ici et non à l'écran, pour que le
 * PDF et le backoffice disent exactement la même chose : une par levier
 * présent dans le filtre, puis UNE phrase de variation, sur le premier
 * chiffre comparable (ventes, puis appels, puis inscrits).
 */
export function phrasesARetenir(r: Entree): string[] {
  const phrases: string[] = [];

  if (!r.inscriptions.hors_filtre) {
    const i = r.inscriptions;
    if (i.inscrits.valeur === 0) phrases.push('Aucun inscrit sur la période.');
    else
      phrases.push(
        `${compter(i.inscrits.valeur, 'inscrit')} sur la période, ` +
          `${i.ont_commande.valeur === 0 ? 'aucun n’a encore commandé' : `${fmtNombre(i.ont_commande.valeur)} ${i.ont_commande.valeur >= 2 ? 'ont' : 'a'} déjà commandé`}` +
          `${i.ont_commande.valeur > 0 ? ` (${fmtPct(i.taux_commande.valeur)})` : ''}.`,
      );
  }

  if (!r.captes.hors_filtre) {
    const c = r.captes.total;
    const nom = nomCaptes(r.captes.par_public.filter((p) => !p.hors_filtre).map((p) => p.segment));
    if (c.entres.valeur + c.appeles.valeur + c.ventes.valeur === 0) phrases.push(`${nom} : rien à signaler sur la période.`);
    else
      phrases.push(
        `${nom} : ${compter(c.appeles.valeur, 'client appelé', 'clients appelés')}, ` +
          `${compter(c.joints.valeur, 'joint')}, ` +
          `${c.ventes.valeur === 0 ? 'aucun passage en direct' : `${compter(c.ventes.valeur, 'passé en direct', 'passés en direct')} pour ${fmtMontant(c.ca.valeur)}`}.`,
      );
  }

  if (!r.inactifs.hors_filtre) {
    const n = r.inactifs;
    if (n.entres.valeur === 0 && n.ventes.valeur === 0) phrases.push('Clients inactifs : aucune entrée ni aucun retour sur la période.');
    else
      phrases.push(
        `Clients inactifs : ${n.ventes.valeur === 0 ? 'aucun client revenu' : compter(n.ventes.valeur, 'client revenu', 'clients revenus')} ` +
          `sur ${compter(n.entres.valeur, 'entré')} en inactivité.`,
      );
  }

  const variation = phraseVariation(r);
  if (variation) phrases.push(variation);

  return phrases.slice(0, 4);
}

function nomCaptes(segments: SegmentCapte[]): string {
  if (segments.length === 1) return segments[0] === 'GLOVO' ? 'Glovo' : 'Yango';
  return 'Glovo et Yango';
}

/** Une seule phrase de variation, sur le premier chiffre vraiment comparable. */
function phraseVariation(r: Entree): string | null {
  const candidats: { c: Compare; sujet: string; feminin: boolean; pluriel: boolean }[] = [
    { c: r.resultat.ventes, sujet: 'Les ventes du CRM', feminin: true, pluriel: true },
    { c: r.equipe.appels, sujet: 'Les appels', feminin: false, pluriel: true },
    ...(r.inscriptions.hors_filtre ? [] : [{ c: r.inscriptions.inscrits, sujet: 'Les inscriptions', feminin: true, pluriel: true }]),
  ];
  const retenu = candidats.find((x) => x.c.comparable && x.c.variation !== null);
  if (!retenu) return null;
  const v = retenu.c.variation as number;
  if (v === 0) return `${retenu.sujet} sont au même niveau que sur la période précédente.`;
  const sens = v > 0 ? 'en hausse' : 'en baisse';
  return `${retenu.sujet} sont ${sens} de ${fmtPct(Math.abs(v))} par rapport à la période précédente (${fmtNombre(retenu.c.precedent)} avant).`;
}
