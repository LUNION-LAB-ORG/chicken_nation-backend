/**
 * FIN DE PRÉPARATION D'UNE COMMANDE : quand sera-t-elle prête ? (conception
 * du regroupement, section 3.2)
 *
 * ⚠️ Règle PURE, sans base ni Redis : elle reçoit la commande, les mesures du
 * restaurant et les réglages. C'est elle qu'on teste ; le service
 * `EstimationPreparationService` lit les mesures et garde la statistique.
 *
 * Sert à une seule décision : une course dont le livreur est au comptoir
 * peut-elle attendre une commande encore EN PRÉPARATION (retenue, 3.5) ?
 * Seules les commandes IN_PROGRESS ont une estimation : « Nouvelle »
 * (ACCEPTED) et « En attente » sont trop incertaines.
 *
 * Trois sources, la première disponible l'emporte :
 *  1. la durée donnée par la cuisine au passage « En préparation »
 *     (`Order.estimated_preparation_time`, heure de fin déjà calculée par le
 *     serveur à partir de `meta.estimated_preparation_time`) ;
 *  2. la statistique du restaurant pour la tranche horaire de la commande,
 *     sur 14 jours : durées `ready_at − prepared_at` entre 60 s et 60 min (les
 *     clics « en préparation » puis « prête » d'affilée sont écartés), au
 *     moins 20 mesures ; médiane pour l'affichage (« prête vers »), 8e décile
 *     pour décider ;
 *  3. les défauts réglés : 12 min (médiane) et 18 min (8e décile).
 *
 * Commande en retard sur son estimation : fin estimée = maintenant + 2 min,
 * toujours soumise aux limites du planificateur.
 *
 * Heure d'Abidjan = UTC : les tranches se lisent en heures UTC.
 */

import { OrderStatus } from '@prisma/client';

// ─── Seuils fixes ────────────────────────────────────────────────────────────

/** Durée la plus courte retenue dans la statistique (clics d'affilée écartés). */
export const DUREE_MESURE_MIN_S = 60;
/** Durée la plus longue retenue dans la statistique (oubli de cliquer « prête »). */
export const DUREE_MESURE_MAX_S = 60 * 60;
/** Nombre minimal de mesures pour croire la statistique d'une tranche. */
export const MESURES_MIN = 20;
/** Commande en retard sur son estimation : prête dans ce délai. */
export const RETARD_PROLONGATION_S = 2 * 60;
/** Durée annoncée par la cuisine au-delà de laquelle on ne la croit plus. */
export const DUREE_CUISINE_MAX_S = 2 * 60 * 60;

// ─── Réglages ────────────────────────────────────────────────────────────────

export interface ReglagesPreparation {
  /** `preparation.duree_defaut_min` : durée médiane quand rien d'autre n'est connu. */
  dureeDefautMin: number;
  /** `preparation.duree_p80_min` : 8e décile quand rien d'autre n'est connu (décision). */
  dureeP80Min: number;
}

export const REGLAGES_PREPARATION_DEFAUT: Readonly<ReglagesPreparation> = Object.freeze({
  dureeDefautMin: 12,
  dureeP80Min: 18,
});

export const CLES_REGLAGES_PREPARATION = {
  dureeDefautMin: 'preparation.duree_defaut_min',
  dureeP80Min: 'preparation.duree_p80_min',
} as const;

export interface ReglagesPreparationLus {
  reglages: ReglagesPreparation;
  /** Valeurs refusées (vides exclues), remplacées par le défaut. */
  refusees: { cle: string; valeur: string }[];
}

/**
 * Lit les deux durées par défaut. Une durée nulle n'a pas de sens (refusée et
 * signalée) ; un 8e décile plus court que la médiane est relevé à la médiane.
 */
export function lireReglagesPreparation(valeurs: Record<string, string | null | undefined>): ReglagesPreparationLus {
  const refusees: { cle: string; valeur: string }[] = [];
  const minutes = (champ: keyof ReglagesPreparation): number => {
    const cle = CLES_REGLAGES_PREPARATION[champ];
    const brut = valeurs[cle];
    if (brut === undefined || brut === null || brut.trim() === '') return REGLAGES_PREPARATION_DEFAUT[champ];
    const n = Number(brut.trim().replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || n > 180) {
      refusees.push({ cle, valeur: brut });
      return REGLAGES_PREPARATION_DEFAUT[champ];
    }
    return n;
  };
  const dureeDefautMin = minutes('dureeDefautMin');
  const dureeP80Min = Math.max(dureeDefautMin, minutes('dureeP80Min'));
  return { reglages: { dureeDefautMin, dureeP80Min }, refusees };
}

// ─── Tranches horaires ───────────────────────────────────────────────────────

/** 11 h-15 h, 15 h-18 h, 18 h-23 h, reste (heure d'Abidjan = UTC). */
export type TrancheHoraire = 'MIDI' | 'APRES_MIDI' | 'SOIR' | 'AUTRE';

export const TRANCHES_HORAIRES: readonly TrancheHoraire[] = ['MIDI', 'APRES_MIDI', 'SOIR', 'AUTRE'];

export function trancheHoraire(date: Date): TrancheHoraire {
  const h = date.getUTCHours();
  if (h >= 11 && h < 15) return 'MIDI';
  if (h >= 15 && h < 18) return 'APRES_MIDI';
  if (h >= 18 && h < 23) return 'SOIR';
  return 'AUTRE';
}

// ─── Statistique du restaurant ───────────────────────────────────────────────

/** Une préparation terminée : passage « En préparation » puis « Prête ». */
export interface MesurePreparation {
  prepared_at: Date;
  ready_at: Date;
}

export interface StatistiquePreparation {
  /** Médiane, en secondes : « prête vers ». */
  medianeS: number;
  /** 8e décile, en secondes : sert aux décisions. */
  p80S: number;
  /** Nombre de mesures retenues. */
  mesures: number;
}

export type StatistiquesParTranche = Partial<Record<TrancheHoraire, StatistiquePreparation | null>>;

/** Durée d'une mesure en secondes, ou `null` si elle est écartée (moins de 60 s, plus de 60 min). */
export function dureeRetenue(m: MesurePreparation): number | null {
  const s = (m.ready_at.getTime() - m.prepared_at.getTime()) / 1000;
  if (!Number.isFinite(s) || s < DUREE_MESURE_MIN_S || s > DUREE_MESURE_MAX_S) return null;
  return s;
}

/** Quantile `q` (0 à 1) par interpolation linéaire ; `null` pour une liste vide. */
export function quantile(valeurs: readonly number[], q: number): number | null {
  if (valeurs.length === 0) return null;
  const triees = [...valeurs].sort((a, b) => a - b);
  const pos = (triees.length - 1) * Math.min(1, Math.max(0, q));
  const bas = Math.floor(pos);
  const haut = Math.ceil(pos);
  return triees[bas] + (triees[haut] - triees[bas]) * (pos - bas);
}

/** Statistique d'une liste de durées (secondes) déjà filtrées, ou `null` sous 20 mesures. */
export function statistiqueDesDurees(dureesS: readonly number[]): StatistiquePreparation | null {
  if (dureesS.length < MESURES_MIN) return null;
  return { medianeS: quantile(dureesS, 0.5)!, p80S: quantile(dureesS, 0.8)!, mesures: dureesS.length };
}

/**
 * Statistique par tranche horaire (tranche du passage « En préparation »),
 * mesures hors bornes écartées. Une tranche sans assez de mesures vaut `null`.
 */
export function statistiquesParTranche(mesures: readonly MesurePreparation[]): Record<TrancheHoraire, StatistiquePreparation | null> {
  const parTranche: Record<TrancheHoraire, number[]> = { MIDI: [], APRES_MIDI: [], SOIR: [], AUTRE: [] };
  for (const m of mesures) {
    const d = dureeRetenue(m);
    if (d !== null) parTranche[trancheHoraire(m.prepared_at)].push(d);
  }
  return {
    MIDI: statistiqueDesDurees(parTranche.MIDI),
    APRES_MIDI: statistiqueDesDurees(parTranche.APRES_MIDI),
    SOIR: statistiqueDesDurees(parTranche.SOIR),
    AUTRE: statistiqueDesDurees(parTranche.AUTRE),
  };
}

// ─── Estimation d'une commande ───────────────────────────────────────────────

export type SourceEstimation = 'CUISINE' | 'STATISTIQUE' | 'DEFAUT';

export interface EstimationPreparation {
  /** Début de la préparation (`prepared_at`, ou maintenant s'il manque). */
  debut: Date;
  /** Fin estimée, médiane : « prête vers ». */
  finMediane: Date;
  /** Fin estimée pour DÉCIDER (8e décile, ou durée de la cuisine). */
  finDecision: Date;
  source: SourceEstimation;
  /** L'estimation de décision était déjà dépassée : prolongée de 2 min. */
  enRetard: boolean;
}

/** Ce que l'estimation lit d'une commande. */
export interface CommandeEnPreparation {
  status: OrderStatus;
  prepared_at: Date | null;
  /** Heure de fin donnée par la cuisine (`Order.estimated_preparation_time`). */
  estimated_preparation_time?: Date | null;
}

/**
 * Fin de préparation estimée d'une commande EN PRÉPARATION, ou `null` pour
 * toute autre commande (elle ne peut pas retenir une course).
 *
 * - Durée de la cuisine : retenue si elle tombe après le début et dans les
 *   2 heures ; elle sert à la fois de médiane et de décision.
 * - Statistique : celle de la tranche horaire du début.
 * - Sinon les défauts.
 * - Fin dépassée : maintenant + 2 min (médiane et décision).
 */
export function estimerFinPreparation(
  commande: CommandeEnPreparation,
  statistiques: StatistiquesParTranche | null | undefined,
  maintenant: Date,
  reglages: ReglagesPreparation = REGLAGES_PREPARATION_DEFAUT,
): EstimationPreparation | null {
  if (commande.status !== OrderStatus.IN_PROGRESS) return null;
  const debut = commande.prepared_at ?? maintenant;
  const t0 = debut.getTime();

  let medianeMs: number;
  let decisionMs: number;
  let source: SourceEstimation;

  const cuisine = commande.estimated_preparation_time ?? null;
  const dureeCuisineMs = cuisine ? cuisine.getTime() - t0 : NaN;
  const stat = statistiques?.[trancheHoraire(debut)] ?? null;

  if (cuisine && dureeCuisineMs > 0 && dureeCuisineMs <= DUREE_CUISINE_MAX_S * 1000) {
    medianeMs = cuisine.getTime();
    decisionMs = cuisine.getTime();
    source = 'CUISINE';
  } else if (stat && stat.mesures >= MESURES_MIN) {
    medianeMs = t0 + stat.medianeS * 1000;
    decisionMs = t0 + Math.max(stat.p80S, stat.medianeS) * 1000;
    source = 'STATISTIQUE';
  } else {
    medianeMs = t0 + reglages.dureeDefautMin * 60_000;
    decisionMs = t0 + Math.max(reglages.dureeP80Min, reglages.dureeDefautMin) * 60_000;
    source = 'DEFAUT';
  }

  const plusTot = maintenant.getTime() + RETARD_PROLONGATION_S * 1000;
  const enRetard = decisionMs <= maintenant.getTime();
  if (medianeMs <= maintenant.getTime()) medianeMs = plusTot;
  if (enRetard) decisionMs = plusTot;
  decisionMs = Math.max(decisionMs, medianeMs);

  return { debut, finMediane: new Date(medianeMs), finDecision: new Date(decisionMs), source, enRetard };
}

/** Écart entre l'estimation et la réalité, en minutes arrondies (positif = plus tard que prévu). */
export function ecartEstimationMinutes(estimee: Date, reelle: Date): number {
  return Math.round((reelle.getTime() - estimee.getTime()) / 60_000);
}
