/**
 * PLANIFICATEUR v2 : que faire, maintenant, des commandes et des courses d'un
 * restaurant ? (conception du regroupement, sections 3 et 4.2, et demande 4
 * du 22/10 au soir)
 *
 * ⚠️ Règle PURE, sans base, sans Google, sans horloge : elle reçoit un
 * INSTANTANÉ du restaurant (commandes, courses ouvertes, livreurs) et rend
 * une liste d'ACTIONS idempotentes. `CoursePlanificateurService` lit
 * l'instantané sous verrou consultatif par restaurant
 * (`CLASSE_VERROU_PLANIFICATEUR`), applique les actions par des mises à jour
 * conditionnelles et journalise chacune avec son motif. Une action dont la
 * condition échoue est abandonnée : le passage suivant (10 s, ou le prochain
 * événement) la recalcule. Aucun état propre : deux serveurs peuvent tourner.
 *
 * Ce que veut le client :
 *  - regrouper les commandes qui vont dans la MÊME DIRECTION (même trajet ou
 *    même zone, jamais « même rayon ») : règle `direction.rules.ts` ;
 *  - une commande prête peut attendre, au comptoir et dans des LIMITES dures,
 *    une commande de la même direction encore en préparation ; celle-ci est
 *    ajoutée automatiquement dès qu'elle est prête. 5 min au plus si le
 *    livreur peut aller livrer et revenir la prendre avec un petit retard ;
 *    toute sa préparation si le trajet est long et qu'il reviendrait tard
 *    (demande du 24/10) ;
 *  - un livreur qui a récupéré sa course mais est encore au restaurant
 *    reçoit sans attendre la commande compatible qui devient prête (nouvelle
 *    appli seulement, protocole 3) ;
 *  - les courses prêtes, créées mais pas encore affectées, de la même
 *    direction sont FUSIONNÉES automatiquement et proposées aussitôt au
 *    livreur disponible ;
 *  - zéro temps mort : dès qu'un livreur est libre, la course la plus
 *    urgente lui est proposée.
 *
 * Un passage, dans l'ordre (les actions sortent dans cet ordre, qui est
 * aussi l'ordre d'application) :
 *  0. COURSE VIDE : une course sans livreur dont toutes les commandes ont été
 *     annulées est annulée (commandes intouchées, offre close sans pénalité) ;
 *     elle n'est jamais la cible d'un ajout.
 *  1. DÉPARTS : une course récupérée dont le livreur est parti (position,
 *     première livraison commencée, fenêtre écoulée, ancienne appli) est
 *     marquée partie ; une commande ajoutée après le retrait mais pas encore
 *     remise en est DÉTACHÉE et repart dans ce même passage.
 *  2. COMMANDES PRÊTES sans course, de la plus ancienne à la plus récente :
 *     AJOUTÉE à la meilleure course ouverte compatible (celle qui l'attendait
 *     d'abord ; puis livreur encore au restaurant après le retrait, au
 *     comptoir, en route, puis course sans livreur ; à égalité le plus petit
 *     détour), sinon regroupement glouton des restantes et CRÉATION de course.
 *     Jamais vers une course sans livreur qu'un livreur libre a refusée (la
 *     commande seule lui est proposée), ni vers une course récupérée à
 *     moins de 90 s (ou d'une demi-fenêtre si elle est plus courte que
 *     3 min) de la fin de sa fenêtre. Personne de libre : le départ
 *     est le premier retour estimé d'un livreur en course qui n'a pas refusé
 *     la course (le retard toléré joue), et regrouper n'avance pas la bascule
 *     vers Turbo d'une commande.
 *  3. FUSIONS (demande 4) : une course sans livreur rejoint une course ouverte
 *     avec livreur, ou une autre course sans livreur, de la même direction et
 *     dans les limites ; l'offre en attente de la course absorbée est close
 *     sans pénalité. Jamais si un livreur qui pourrait prendre la course
 *     fusionnée (ou le livreur de la cible) en a refusé une, jamais une
 *     course dont l'offre a été forcée par l'administrateur, et jamais une
 *     course dont l'offre en attente partirait plus tôt que la cible.
 *  4. ORDRE des arrêts de chaque course modifiée.
 *  5. OFFRES : les courses sans livreur et sans offre sont proposées par
 *     urgence croissante, chacune au meilleur livreur libre (au comptoir
 *     d'abord, puis en minutes, 4.2). Un livreur qui a laissé expirer l'offre
 *     d'une course redevient candidat dès qu'il donne signe de vie (une seule
 *     fois par course). Une offre
 *     en attente qui vise un livreur à plus de 5 min de plus qu'un livreur
 *     libre (2 min s'il est au comptoir) est reprise sans pénalité et proposée
 *     à ce dernier (zéro temps mort), sauf une offre forcée. Livreur sollicité
 *     sans position récente : reprise seulement au profit d'un livreur au
 *     comptoir (son temps par défaut compte).
 *  6. RETENUES au comptoir (3.5) : posées, réduites ou levées. Une retenue ne
 *     peut que diminuer ; levée, elle ne revient jamais sur la même course.
 *     Remise ou non, elle ne dépend pas de la fenêtre d'ajout après le
 *     retrait : c'est la fenêtre qui court depuis sa fin (essai du 25/10, la
 *     caisse remet dès le code).
 *     ATTENTE COURTE : la commande en préparation est prête dans l'horizon
 *     (7 min) et aucune commande prête n'attend plus de 5 min. TRAJET LONG
 *     (demande du 24/10) : partir sans elle ferait revenir le livreur plus de
 *     5 min (`petitRetardRetourMin`) après sa fin estimée ; la course l'attend
 *     alors jusqu'à sa fin estimée, sans qu'une commande prête attende plus
 *     de 20 min (`attenteMaxTrajetLongS`), promesses, autres livreurs et
 *     limites de 3.6 compris.
 *  7. TURBO (3.11) : dernier recours, compté depuis la plus ancienne commande
 *     prête de la course (6 min sous v2), jamais pendant une offre en attente ;
 *     différé d'au plus 4 min quand un livreur interne revient au restaurant
 *     dans ce délai et que les promesses tiennent avec lui.
 *
 * Jamais d'ajout ni de fusion avec une course confiée à Turbo (ou Turbo
 * d'origine) ni avec la course d'un livreur en pause ; jamais d'offre à un
 * livreur qui ne peut pas la recevoir (`peutRecevoirOffre`) ; jamais de
 * mélange entre mètres routiers et vol d'oiseau dans une comparaison ; une
 * commande ne s'annule jamais ici.
 *
 * Heure d'Abidjan = UTC.
 */

import { CourseStatut, DeliveryService, DeliveryStatut, OrderStatus } from '@prisma/client';

import {
  EtatLivreur,
  estEnPause,
  estEnPauseAuto,
  heureLisible,
  peutRecevoirOffre,
} from 'src/modules/deliverers/helpers/disponibilite.rules';

import {
  ClassementDistance,
  ClientDirection,
  estimerTrajets,
  evaluerGroupe,
  evaluerPaire,
  FACTEUR_ROUTE_VOL_OISEAU,
  libelleDirection,
  lireReglagesDirection,
  ModeGroupe,
  MotifDirection,
  ordonnerArrets,
  REGLAGES_DIRECTION_DEFAUT,
  ReglagesDirection,
  VerdictGroupe,
  VerdictPaire,
} from './direction.rules';
import { haversineMeters, ILatLng } from './geo.helper';
import { estCourseTurboDOrigine } from './offres.rules';
import { EstimationPreparation } from './preparation.rules';

// ─── Constantes ──────────────────────────────────────────────────────────────

/**
 * Classe du verrou consultatif du planificateur (`hashtext(restaurant_id)`).
 * 727224 à 727226 : CRM ; 727227 : code de retrait ; 727228 : offre d'un
 * livreur (offres.rules.ts).
 */
export const CLASSE_VERROU_PLANIFICATEUR = 727229;

/** Remise au client : 3 minutes par arrêt précédent (conception 3.3). */
export const ARRET_CLIENT_S = 180;
/** Commande programmée : promesse = heure convenue + 10 min. */
export const MARGE_PROGRAMMEE_MIN = 10;
/** Ajout après le retrait : réservé aux applis qui savent l'afficher. */
export const PROTOCOLE_AJOUT_APRES_RETRAIT = 3;
/** Approche d'un livreur sans Google : vol d'oiseau × 1,3 (conception 4.2). */
export const FACTEUR_APPROCHE_LIVREUR = 1.3;
/** « Autre livreur libre à temps » : au restaurant au plus tard 3 min après la fin estimée (3.5). */
export const MARGE_AUTRE_LIVREUR_S = 180;
/** Bonus de file en minutes : rang 1, rang 2 (4.2). */
export const BONUS_FILE_MIN: readonly number[] = [3, 1.5];
/** Une place de pénalité de refus active coûte une minute (4.2). */
export const PENALITE_PAR_PLACE_MIN = 1;
/** Équité : une demi-minute par course du jour au-dessus de la moyenne (4.2). */
export const EQUITE_PAR_COURSE_MIN = 0.5;
/** Heures de pointe (minutes depuis minuit, UTC) : 11 h 30 à 14 h 30, 18 h 30 à 22 h. */
export const HEURES_DE_POINTE: readonly [number, number][] = [
  [11 * 60 + 30, 14 * 60 + 30],
  [18 * 60 + 30, 22 * 60],
];
/**
 * Ajout après le retrait : jamais à moins de 90 s de la fin de la fenêtre
 * (le temps que la caisse remette le sac). La retenue au comptoir n'y est
 * plus bornée (essai du 25/10) : la fenêtre court depuis sa fin
 * (`debutFenetreApresRetraitMs`), la commande attendue peut toujours être
 * ajoutée puis remise.
 */
export const MARGE_REMISE_APRES_RETRAIT_S = 90;

/**
 * Marge de remise appliquée : 90 s, ou la moitié de la fenêtre réglée quand
 * elle est plus courte que 3 min. Une fenêtre réglée sous 90 s ne coupe plus
 * en silence tout ajout après le retrait (banc du 23/10 : 60 s, aucun ajout).
 */
export function margeRemiseApresRetraitMs(r: Pick<ReglagesPlanification, 'ajoutApresRetraitMaxS'>): number {
  return Math.min(MARGE_REMISE_APRES_RETRAIT_S, Math.max(0, r.ajoutApresRetraitMaxS) / 2) * 1000;
}
/**
 * Fin de la fenêtre repoussée d'au plus 2 min tant qu'une commande ajoutée
 * reste à remettre et que le livreur est encore au comptoir : sa dernière
 * position est dans le rayon de départ, et il n'a rien envoyé de plus loin
 * depuis (le suivi de l'appli n'envoie rien tant qu'il ne bouge pas de
 * 25 m : un livreur immobile qui attend son sac n'envoie plus de position).
 * La position doit avoir moins de `deliverer.au_restaurant_fraicheur_min`
 * (15 min), comme pour « au comptoir » (4.2).
 */
export const PROLONGATION_REMISE_S = 120;
/**
 * Turbo (3.11) : regrouper des commandes qui attendent un livreur n'avance
 * pas de plus d'une minute la bascule vers Turbo d'aucune d'elles.
 */
export const TOLERANCE_AVANCE_TURBO_S = 60;
/**
 * Offre en attente reprise sans pénalité et reproposée quand un livreur libre
 * serait au restaurant plus de 5 min plus tôt que le livreur sollicité ; 2 min
 * quand le livreur libre est AU COMPTOIR (son temps vaut 0 et il est sûr :
 * le seuil de 5 min ne sert qu'à éviter le va-et-vient entre deux estimations).
 */
export const ECART_REPRISE_OFFRE_S = 300;
export const ECART_REPRISE_OFFRE_COMPTOIR_S = 120;

// ─── Réglages ────────────────────────────────────────────────────────────────

export interface ReglagesPlanification {
  /** `course.attente_max_commande_prete_s` : jamais de retenue au-delà de `ready_at` + ce délai (attente courte). */
  attenteMaxCommandePreteS: number;
  /** `course.horizon_preparation_s` : on n'attend pas une commande prête dans plus de ce délai (attente courte). */
  horizonPreparationS: number;
  /**
   * `course.petit_retard_retour_min` : retard toléré au retour du livreur
   * (trajet long, demande du 24/10). Partir sans la commande en préparation
   * le ferait revenir au restaurant plus de ce délai après qu'elle est prête :
   * le trajet est « long ». 0 = toute attente un peu plus longue que
   * l'aller-retour passe en trajet long.
   */
  petitRetardRetourMin: number;
  /**
   * `course.attente_max_trajet_long_s` : trajet long, la course attend la
   * commande en préparation jusqu'à sa fin estimée, au-delà de l'horizon et de
   * l'attente courte, mais aucune commande prête de la course n'attend plus
   * de ce délai depuis `ready_at`. 0 = cas du trajet long coupé (attente
   * courte seule).
   */
  attenteMaxTrajetLongS: number;
  /** `course.retenue_meme_si_livreur_libre` : retenir même si un autre livreur pourrait la prendre. */
  retenueMemeSiLivreurLibre: boolean;
  /** `course.max_orders_per_course` : taille maximale d'une course (annulées non comptées). */
  maxCommandesParCourse: number;
  /** `course.max_route_duration_min` : restaurant → dernier client, arrêts compris. */
  dureeTourneeMaxMin: number;
  /** `course.promesse_client_min` : délai promis depuis `created_at`. */
  promesseClientMin: number;
  /** `course.retard_max_client_min` : retard toléré sur la promesse. */
  retardMaxClientMin: number;
  /** `course.detour_max_ajout_min` : retard maximal qu'un ajout impose à une commande déjà prévue. */
  detourMaxAjoutMin: number;
  /** `course.ajout_apres_retrait` : ajouter à un livreur encore au restaurant après le retrait. */
  ajoutApresRetrait: boolean;
  /** `course.ajout_apres_retrait_max_s` : au-delà, la course est réputée partie. */
  ajoutApresRetraitMaxS: number;
  /** `course.depart_rayon_m` : une position plus loin du restaurant après le retrait = départ. */
  departRayonM: number;
  /** `course.vitesse_moyenne_kmh` et `course.vitesse_pointe_kmh`. */
  vitesseMoyenneKmh: number;
  vitessePointeKmh: number;
  /** `course.turbo_fallback_enabled` (existant). */
  turboActif: boolean;
  /** `course.turbo_fallback_after_min_v2` : depuis la plus ancienne commande prête de la course. */
  turboApresMinV2: number;
  /**
   * `course.turbo_attente_retour_max_min` : Turbo attend au plus ce délai de
   * plus quand un livreur interne revient au restaurant dans ce délai et que
   * les promesses tiennent avec lui (0 = jamais d'attente, Turbo à l'heure).
   */
  turboAttenteRetourMaxMin: number;
  /**
   * `course.trajet_sans_coordonnees_min` : durée supposée d'un trajet vers un
   * client sans coordonnées (aller, ou retour depuis lui). Une durée, jamais
   * une distance : rien n'est mêlé au vol d'oiseau.
   */
  trajetSansCoordonneesMin: number;
  /** `deliverer.au_restaurant_rayon_m` et `deliverer.au_restaurant_fraicheur_min`. */
  auRestaurantRayonM: number;
  auRestaurantFraicheurMin: number;
  /** `deliverer.eta_par_defaut_min` : position inconnue ou périmée. */
  etaParDefautMin: number;
  /** `deliverer.gps_expiration_minutes` (existant) : au-delà, la position ne dit plus où il est. */
  positionExpirationMin: number;
  /** `course.planificateur_tache_s` : cadence de la tâche du planificateur. */
  intervalleTacheS: number;
  /** Règle « même direction » (direction.rules.ts). */
  direction: ReglagesDirection;
}

export const REGLAGES_PLANIFICATION_DEFAUT: Readonly<ReglagesPlanification> = Object.freeze({
  attenteMaxCommandePreteS: 300,
  horizonPreparationS: 420,
  petitRetardRetourMin: 5,
  attenteMaxTrajetLongS: 1200,
  retenueMemeSiLivreurLibre: false,
  maxCommandesParCourse: 3,
  dureeTourneeMaxMin: 25,
  promesseClientMin: 35,
  retardMaxClientMin: 5,
  detourMaxAjoutMin: 8,
  ajoutApresRetrait: true,
  ajoutApresRetraitMaxS: 240,
  departRayonM: 250,
  vitesseMoyenneKmh: 22,
  vitessePointeKmh: 16,
  turboActif: true,
  turboApresMinV2: 6,
  turboAttenteRetourMaxMin: 4,
  trajetSansCoordonneesMin: 12,
  auRestaurantRayonM: 200,
  auRestaurantFraicheurMin: 15,
  etaParDefautMin: 8,
  positionExpirationMin: 5,
  intervalleTacheS: 10,
  direction: REGLAGES_DIRECTION_DEFAUT,
});

type CleNombre = Exclude<
  keyof ReglagesPlanification,
  'retenueMemeSiLivreurLibre' | 'ajoutApresRetrait' | 'turboActif' | 'direction'
>;
type CleBooleen = 'retenueMemeSiLivreurLibre' | 'ajoutApresRetrait' | 'turboActif';

/** Clé du réglage, minimum (0 permis là où il a un sens), maximum, entier ou non. */
const BORNES: Record<CleNombre, { cle: string; min: number; max: number; zero: boolean; entier?: boolean }> = {
  attenteMaxCommandePreteS: { cle: 'course.attente_max_commande_prete_s', min: 0, max: 3600, zero: true },
  horizonPreparationS: { cle: 'course.horizon_preparation_s', min: 0, max: 3600, zero: true },
  petitRetardRetourMin: { cle: 'course.petit_retard_retour_min', min: 0, max: 120, zero: true },
  attenteMaxTrajetLongS: { cle: 'course.attente_max_trajet_long_s', min: 0, max: 3600, zero: true },
  maxCommandesParCourse: { cle: 'course.max_orders_per_course', min: 1, max: 10, zero: false, entier: true },
  dureeTourneeMaxMin: { cle: 'course.max_route_duration_min', min: 1, max: 240, zero: false },
  promesseClientMin: { cle: 'course.promesse_client_min', min: 1, max: 240, zero: false },
  retardMaxClientMin: { cle: 'course.retard_max_client_min', min: 0, max: 120, zero: true },
  detourMaxAjoutMin: { cle: 'course.detour_max_ajout_min', min: 0, max: 120, zero: true },
  ajoutApresRetraitMaxS: { cle: 'course.ajout_apres_retrait_max_s', min: 0, max: 3600, zero: true },
  departRayonM: { cle: 'course.depart_rayon_m', min: 1, max: 5000, zero: false },
  vitesseMoyenneKmh: { cle: 'course.vitesse_moyenne_kmh', min: 1, max: 120, zero: false },
  vitessePointeKmh: { cle: 'course.vitesse_pointe_kmh', min: 1, max: 120, zero: false },
  turboApresMinV2: { cle: 'course.turbo_fallback_after_min_v2', min: 0, max: 240, zero: true },
  turboAttenteRetourMaxMin: { cle: 'course.turbo_attente_retour_max_min', min: 0, max: 30, zero: true },
  trajetSansCoordonneesMin: { cle: 'course.trajet_sans_coordonnees_min', min: 1, max: 120, zero: false },
  auRestaurantRayonM: { cle: 'deliverer.au_restaurant_rayon_m', min: 1, max: 5000, zero: false },
  auRestaurantFraicheurMin: { cle: 'deliverer.au_restaurant_fraicheur_min', min: 1, max: 240, zero: false },
  etaParDefautMin: { cle: 'deliverer.eta_par_defaut_min', min: 1, max: 120, zero: false },
  positionExpirationMin: { cle: 'deliverer.gps_expiration_minutes', min: 1, max: 240, zero: false },
  intervalleTacheS: { cle: 'course.planificateur_tache_s', min: 5, max: 300, zero: false, entier: true },
};

const CLES_BOOLEENS: Record<CleBooleen, string> = {
  retenueMemeSiLivreurLibre: 'course.retenue_meme_si_livreur_libre',
  ajoutApresRetrait: 'course.ajout_apres_retrait',
  turboActif: 'course.turbo_fallback_enabled',
};

/** Toutes les clés lues par `lireReglagesPlanification` (direction comprise), pour un seul `getMany`. */
export const CLES_REGLAGES_PLANIFICATION: readonly string[] = [
  ...Object.values(BORNES).map((b) => b.cle),
  ...Object.values(CLES_BOOLEENS),
  'course.direction_couloir_m',
  'course.direction_zone_rayon_m',
  'course.direction_angle_max_deg',
  'course.direction_detour_max_min',
  'course.direction_detour_max_pct',
  'course.direction_google',
];

export interface ReglagesPlanificationLus {
  reglages: ReglagesPlanification;
  /** `course.direction_google` (trajets Google pour la direction). */
  google: boolean;
  /** Valeurs refusées, remplacées par le défaut, à signaler au backoffice. */
  refusees: { cle: string; valeur: string }[];
}

function lireBooleen(brut: string): boolean | null {
  const v = brut.trim().toLowerCase();
  if (['1', 'true', 'on', 'oui', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'non', 'no'].includes(v)) return false;
  return null;
}

/**
 * Lit les réglages du planificateur depuis les valeurs brutes de la table des
 * réglages. Contrairement au `toNumber` historique du module course (qui
 * refuse 0), 0 est accepté là où il a un sens : attente maximale 0 = jamais
 * de retenue courte, horizon 0 = jamais d'attente courte d'une commande en
 * préparation, petit retard au retour 0 = toute attente un peu plus longue
 * que l'aller-retour est un trajet long, attente d'un trajet long 0 = cas du
 * trajet long coupé, fenêtre 0 = jamais d'ajout après le retrait, retard ou
 * détour 0 = aucun toléré, Turbo 0 = dès qu'aucun livreur n'est libre. Une
 * valeur hors bornes ou illisible est remplacée par le défaut et SIGNALÉE.
 */
export function lireReglagesPlanification(valeurs: Record<string, string | null | undefined>): ReglagesPlanificationLus {
  const refusees: { cle: string; valeur: string }[] = [];
  const defaut = REGLAGES_PLANIFICATION_DEFAUT;
  const reglages = { ...defaut } as ReglagesPlanification;

  for (const champ of Object.keys(BORNES) as CleNombre[]) {
    const { cle, min, max, entier } = BORNES[champ];
    const brut = valeurs[cle];
    if (brut === undefined || brut === null || brut.trim() === '') continue;
    const n = Number(brut.trim().replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > max || (entier && !Number.isInteger(n))) {
      refusees.push({ cle, valeur: brut });
      continue;
    }
    reglages[champ] = n;
  }
  for (const champ of Object.keys(CLES_BOOLEENS) as CleBooleen[]) {
    const cle = CLES_BOOLEENS[champ];
    const brut = valeurs[cle];
    if (brut === undefined || brut === null || brut.trim() === '') continue;
    const b = lireBooleen(brut);
    if (b === null) refusees.push({ cle, valeur: brut });
    else reglages[champ] = b;
  }

  const direction = lireReglagesDirection(valeurs);
  reglages.direction = direction.reglages;
  return { reglages, google: direction.google, refusees: [...refusees, ...direction.refusees] };
}

// ─── Choix du planificateur (v2 par défaut, v1 en repli) ─────────────────────

export type VersionPlanificateur = 'v1' | 'v2';

export const CLE_PLANIFICATEUR = 'course.planificateur';
export const CLE_PLANIFICATEUR_RESTAURANTS = 'course.planificateur_restaurants';

export interface PlanificateurLu {
  version: VersionPlanificateur;
  /** Restaurants passés en v2 ; vide = tous. */
  restaurants: string[];
  refusees: { cle: string; valeur: string }[];
}

/**
 * `course.planificateur` : `v2` (défaut) ou `v1` (repli : exactement le
 * regroupement d'avant, par lots). `course.planificateur_restaurants` :
 * identifiants séparés par des virgules, espaces ou points-virgules, ou
 * tableau JSON ; vide = tous les restaurants.
 */
export function lirePlanificateur(valeurs: Record<string, string | null | undefined>): PlanificateurLu {
  const refusees: { cle: string; valeur: string }[] = [];
  let version: VersionPlanificateur = 'v2';
  const brut = valeurs[CLE_PLANIFICATEUR];
  if (brut !== undefined && brut !== null && brut.trim() !== '') {
    const v = brut.trim().toLowerCase();
    if (v === 'v1' || v === '1') version = 'v1';
    else if (v === 'v2' || v === '2') version = 'v2';
    else refusees.push({ cle: CLE_PLANIFICATEUR, valeur: brut });
  }

  let restaurants: string[] = [];
  const liste = valeurs[CLE_PLANIFICATEUR_RESTAURANTS];
  if (liste !== undefined && liste !== null && liste.trim() !== '') {
    const texte = liste.trim();
    if (texte.startsWith('[')) {
      try {
        const tableau: unknown = JSON.parse(texte);
        if (Array.isArray(tableau) && tableau.every((x) => typeof x === 'string')) restaurants = tableau.map((x) => x.trim()).filter(Boolean);
        else refusees.push({ cle: CLE_PLANIFICATEUR_RESTAURANTS, valeur: liste });
      } catch {
        refusees.push({ cle: CLE_PLANIFICATEUR_RESTAURANTS, valeur: liste });
      }
    } else {
      restaurants = texte.split(/[\s,;]+/).filter(Boolean);
    }
  }
  return { version, restaurants, refusees };
}

/** Planificateur d'un restaurant : v2 si activé et (liste vide ou restaurant listé), sinon v1. */
export function planificateurDuRestaurant(lu: Pick<PlanificateurLu, 'version' | 'restaurants'>, restaurantId: string): VersionPlanificateur {
  if (lu.version === 'v1') return 'v1';
  return lu.restaurants.length === 0 || lu.restaurants.includes(restaurantId) ? 'v2' : 'v1';
}

// ─── Instantané (lu par le service) ──────────────────────────────────────────

/** Une commande vue par le planificateur. */
export interface CommandePlanif {
  id: string;
  reference: string;
  statut: OrderStatus;
  delivery_service: DeliveryService;
  /** Client (direction) : `id` = identifiant de la commande. */
  client: ClientDirection;
  created_at: Date;
  ready_at: Date | null;
  /** Heure convenue d'une commande programmée (`heureProgrammee`), sinon `null`. */
  heure_programmee?: Date | null;
  /** Fin de préparation estimée (preparation.rules.ts), commandes IN_PROGRESS seulement. */
  preparation?: EstimationPreparation | null;
}

export interface OffrePlanif {
  id: string;
  deliverer_id: string;
  expires_at: Date;
  /**
   * Offre posée par l'affectation forcée de l'administrateur : jamais
   * reprise pour un autre livreur, jamais close par une fusion.
   */
  forcee?: boolean;
}

/** Offre de la course laissée expirer par un livreur (sans réponse). */
export interface ExpirationPlanif {
  deliverer_id: string;
  /** Heure de l'expiration (`responded_at`, sinon `expires_at`). */
  a: Date;
}

export interface LivraisonPlanif {
  id: string;
  statut: DeliveryStatut;
  sequence_order: number;
  ajoutee_apres_retrait?: boolean;
  commande: CommandePlanif;
}

/** Une course du restaurant : PENDING_ASSIGNMENT, ACCEPTED, AT_RESTAURANT ou IN_DELIVERY. */
export interface CoursePlanif {
  id: string;
  reference: string;
  statut: CourseStatut;
  deliverer_id: string | null;
  turbo_escalated_at: Date | null;
  created_at: Date;
  assigned_at?: Date | null;
  at_restaurant_at?: Date | null;
  picked_up_at: Date | null;
  /** Départ réel du restaurant (nouvelle colonne). */
  parti_at: Date | null;
  /** Retenue au comptoir : active si dans le futur ; passée = retenue terminée, jamais reposée. */
  retenue_jusqua: Date | null;
  /** Commandes attendues par la retenue (identifiants). */
  commandes_attendues: string[];
  /** Offre en attente (PENDING), s'il y en a une. */
  offre: OffrePlanif | null;
  /**
   * Livreurs qui ne recevront plus CETTE course : refus (définitif, 4.4). Les
   * offres closes sans pénalité n'y sont jamais. L'instantané y met les refus
   * et donne les expirations à part (`expirees`).
   */
  deja_sollicites: string[];
  /**
   * Offres de cette course laissées expirer : le livreur est exclu jusqu'à
   * un signe de vie POSTÉRIEUR (position, requête de l'appli), puis la course
   * peut lui être reproposée (il avait le téléphone en poche).
   */
  expirees?: ExpirationPlanif[];
  livraisons: LivraisonPlanif[];
}

/** Un livreur actif du restaurant. */
export interface LivreurPlanif {
  id: string;
  /** État pour la règle unique `peutRecevoirOffre` (en_course et offre_en_attente compris). */
  etat: EtatLivreur;
  /** Dernière position reçue, précise ou non (temps de trajet, retour estimé). */
  position: ILatLng | null;
  position_at: Date | null;
  /**
   * Dernière position ASSEZ PRÉCISE (80 m au plus) et son heure : seule à
   * décider un départ, la présence au comptoir et le sac attendu. Un relevé
   * imprécis (150 m, dans le restaurant) ne fait jamais partir la course.
   * `null` : aucune connue ; absente : la position elle-même (ancienne
   * écriture sans précision, tests).
   */
  position_sure?: { position: ILatLng; position_at: Date } | null;
  /** En-tête `x-deli-protocole` : 3 = appli qui sait recevoir un ajout après le retrait. */
  protocole_appli: number | null;
  queue_penalty_until?: Date | null;
  queue_penalty_positions?: number | null;
  /** Courses du jour (équité, 4.2). */
  courses_du_jour: number;
  /** Temps jusqu'au restaurant donné par Google (secondes), position fraîche seulement ; sinon absent. */
  secondes_google?: number | null;
  /** Dernier signe de vie de l'appli (requête authentifiée ou position), écrit au plus une fois par minute. */
  dernier_signal_at?: Date | null;
}

export interface InstantanePlanification {
  maintenant: Date;
  restaurant: { id: string; position: ILatLng | null };
  /** Commandes à livrer de la flotte interne SANS course : READY et IN_PROGRESS. */
  commandes: CommandePlanif[];
  /** Courses du restaurant non terminées. */
  courses: CoursePlanif[];
  /** Livreurs actifs du restaurant. */
  livreurs: LivreurPlanif[];
}

export interface OptionsPlanification {
  /**
   * Verdicts de direction déjà mesurés (Google compris) par le service, clé
   * `clePaire`. Une paire absente est jugée sans Google (repli, jamais de
   * blocage). Voir `pairesAEvaluer`.
   */
  verdicts?: ReadonlyMap<string, VerdictPaire>;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/** Pourquoi la course est réputée partie du restaurant. */
export type MotifDepart =
  | 'DEJA_PARTI'
  | 'AJOUT_COUPE'
  | 'ANCIENNE_APPLI'
  | 'SANS_RETRAIT'
  | 'LIVRAISON_DEMARREE'
  | 'POSITION'
  | 'FENETRE_ECHUE'
  | 'REPLI_V1';

/** Pourquoi une retenue est levée. */
export type MotifLiberation = 'TOUT_PRET' | 'ECHEANCE' | 'PLUS_RIEN_A_ATTENDRE' | 'PARTI' | 'REPLI_V1';

/** Pourquoi un ajout, une fusion ou une retenue est refusé (journal, tests). */
export type MotifRefusPlanification =
  | 'TAILLE'
  | 'DIRECTION'
  | 'DUREE_TOURNEE'
  | 'DETOUR_AJOUT'
  | 'RETARD_CLIENT'
  | 'ATTENTE_COMMANDE_PRETE'
  | 'HORIZON'
  | 'LIMITE_RETENUE'
  | 'AUTRE_LIVREUR_LIBRE'
  /** Course récupérée : moins de 90 s avant la fin de sa fenêtre d'ajout. */
  | 'FIN_DE_FENETRE'
  /**
   * Refusée par un livreur qui pourrait la prendre maintenant (libre, ou
   * sollicité par l'une des deux courses d'une fusion), ou par le livreur de
   * la course cible : ses commandes ne lui reviennent pas par un ajout ou une
   * fusion, et une commande neuve ne s'y colle pas (elle lui est proposée seule).
   */
  | 'DEJA_REFUSEE'
  /** Regrouper avancerait la bascule vers Turbo d'une commande. */
  | 'AVANCE_TURBO'
  /** La course absorbée a une offre en attente et partirait plus tôt seule : l'offre n'est pas reprise. */
  | 'OFFRE_EN_COURS'
  /** Turbo différé : un livreur interne revient au restaurant très bientôt (essai `TURBO`). */
  | 'RETOUR_ATTENDU';

export interface ActionMarquerParti {
  type: 'MARQUER_PARTI';
  course_id: string;
  deliverer_id: string | null;
  motif: MotifDepart;
  libelle: string;
}

export interface ActionDetacher {
  type: 'DETACHER';
  course_id: string;
  order_id: string;
  reference: string;
  motif: 'LIVREUR_PARTI' | 'REPLI_V1';
  libelle: string;
}

export interface ActionAjouter {
  type: 'AJOUTER';
  course_id: string;
  order_id: string;
  reference: string;
  statut_course: CourseStatut;
  deliverer_id: string | null;
  /** Course IN_DELIVERY, livreur encore au restaurant : la commande sera remise avec le même code. */
  apres_retrait: boolean;
  /** La course attendait cette commande (retenue). */
  attendue: boolean;
  /** Offre en attente sur la course : la réémettre à jour, même échéance. */
  offre: OffrePlanif | null;
  motif: MotifDirection | null;
  libelle: string;
  /** Allongement de la tournée, en secondes. */
  detour_s: number;
}

export interface ActionCreerCourse {
  type: 'CREER_COURSE';
  /** Clé de la future course dans ce plan (`nouvelle-1`…), reprise par OFFRIR. */
  cle: string;
  order_ids: string[];
  /** Ordre des arrêts (identifiants de commandes). */
  sequence: string[];
  motif: MotifDirection | null;
  libelle: string;
}

export interface ActionFusionner {
  type: 'FUSIONNER';
  cible_id: string;
  absorbee_id: string;
  /** Commandes déplacées de la course absorbée vers la cible. */
  order_ids: string[];
  statut_cible: CourseStatut;
  deliverer_id: string | null;
  /** Offre en attente sur la cible, gardée : la réémettre à jour. */
  offre_cible: OffrePlanif | null;
  /** Offres en attente de la course absorbée : closes sans pénalité (COURSE_FUSIONNEE). */
  offres_a_clore: OffrePlanif[];
  apres_retrait: boolean;
  motif: MotifDirection | null;
  libelle: string;
  detour_s: number;
}

export interface ActionOrdonner {
  type: 'ORDONNER';
  course_id: string;
  /** Identifiants de commandes, dans l'ordre de la tournée. */
  sequence: string[];
}

export interface CoutLivreur {
  deliverer_id: string;
  au_comptoir: boolean;
  eta_s: number;
  source_eta: SourceEta;
  rang_file: number;
  bonus_file_min: number;
  penalite_min: number;
  equite_min: number;
  /** Coût total en minutes équivalentes (plus petit = meilleur). */
  cout_min: number;
}

export interface ActionOffrir {
  type: 'OFFRIR';
  /** Identifiant, ou clé `nouvelle-N` d'une course créée dans ce plan. */
  course_cle: string;
  course_id: string | null;
  deliverer_id: string;
  /** Marge (secondes) entre promesse et arrivée estimée, départ immédiat : plus petite = plus urgente. */
  marge_s: number;
  cout: CoutLivreur;
  libelle: string;
}

/**
 * Offre en attente reprise sans pénalité (zéro temps mort, demande 4) : un
 * livreur libre serait au restaurant bien plus tôt que le livreur sollicité.
 * Suivie, dans le même plan, de l'OFFRIR au livreur libre. Si le livreur
 * sollicité accepte au même instant, son acceptation l'emporte : la reprise
 * et la nouvelle offre sont abandonnées.
 */
export interface ActionReprendreOffre {
  type: 'REPRENDRE_OFFRE';
  course_id: string;
  offre: OffrePlanif;
  /** Livreur libre qui reçoit la course à la place. */
  pour_deliverer_id: string;
  libelle: string;
}

/**
 * Pourquoi la course attend une commande en préparation (3.5) :
 *  - `ATTENTE_COURTE` : dans la règle d'avant, la commande est prête dans
 *    l'horizon (7 min) et aucune commande prête n'attend plus de 5 min ;
 *  - `TRAJET_LONG` : au-delà (demande du 24/10). Partir sans elle ferait
 *    revenir le livreur trop tard pour la prendre ; la course l'attend
 *    jusqu'à sa fin estimée, dans la limite `attenteMaxTrajetLongS`.
 */
export type MotifRetenue = 'ATTENTE_COURTE' | 'TRAJET_LONG';

export interface CommandeAttendue {
  order_id: string;
  reference: string;
  /** Fin estimée, médiane : « prête vers ». */
  prete_vers: Date;
  /** Fin estimée pour décider (8e décile ou cuisine). */
  prete_au_plus_tard: Date;
  /** Attente courte ou trajet long : écrit dans `Course.commandes_attendues`, lu par les écrans. */
  motif: MotifRetenue;
}

export interface ActionRetenir {
  type: 'RETENIR';
  course_id: string;
  deliverer_id: string | null;
  /** Départ retenu jusqu'à : ne peut que diminuer. */
  jusqua: Date;
  attendues: CommandeAttendue[];
  /** `TRAJET_LONG` dès qu'une commande attendue l'est pour un trajet long, sinon `ATTENTE_COURTE`. */
  motif: MotifRetenue;
  /**
   * Aller-retour estimé de la course sans les commandes attendues, depuis son
   * départ possible (secondes, journal) ; `null` s'il n'a pas eu à être estimé.
   */
  aller_retour_s: number | null;
  libelle: string;
}

export interface ActionLiberer {
  type: 'LIBERER';
  course_id: string;
  deliverer_id: string | null;
  motif: MotifLiberation;
  /** À écrire dans `retenue_jusqua` (maintenant) : la retenue ne reviendra plus sur cette course. */
  jusqua: Date;
  libelle: string;
}

export interface ActionConfierTurbo {
  type: 'CONFIER_TURBO';
  course_id: string;
  /** Minutes depuis la plus ancienne commande prête. */
  minutes: number;
  libelle: string;
}

/**
 * Course sans livreur dont toutes les commandes ont été annulées : annulée
 * par le système (les commandes ne sont pas touchées), son offre en attente
 * close sans pénalité. Elle n'est plus jamais la cible d'un ajout.
 */
export interface ActionAnnulerCourseVide {
  type: 'ANNULER_COURSE_VIDE';
  course_id: string;
  /** Offre en attente à clore sans pénalité, s'il y en a une. */
  offre: OffrePlanif | null;
  libelle: string;
}

export type ActionPlanification =
  | ActionAnnulerCourseVide
  | ActionMarquerParti
  | ActionDetacher
  | ActionAjouter
  | ActionCreerCourse
  | ActionFusionner
  | ActionOrdonner
  | ActionOffrir
  | ActionReprendreOffre
  | ActionRetenir
  | ActionLiberer
  | ActionConfierTurbo;

export type TypeActionPlanification = ActionPlanification['type'];

/** Un essai refusé (journal, tests une limite à la fois). */
export interface RefusPlanification {
  /** `TURBO` : bascule différée (retour d'un livreur interne attendu). */
  essai: 'AJOUT' | 'CREATION' | 'FUSION' | 'RETENUE' | 'TURBO';
  /** Commande essayée (ajout, création, retenue). */
  order_id: string | null;
  /** Course absorbée essayée (fusion). */
  source_id: string | null;
  /** Course cible essayée (identifiant ou clé). */
  course_cle: string;
  refus: MotifRefusPlanification;
  libelle: string;
}

export interface PlanRestaurant {
  restaurant_id: string;
  maintenant: Date;
  actions: ActionPlanification[];
  refus: RefusPlanification[];
}

// ─── Petites règles ──────────────────────────────────────────────────────────

/** Clé d'une paire de commandes, dans un sens comme dans l'autre. */
export function clePaire(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Heure convenue d'une commande programmée (`Order.date` + `Order.time`
 * « HH:mm » ou « HHhmm »), heure d'Abidjan = UTC ; `null` si incomplète.
 */
export function heureProgrammee(date: Date | null | undefined, time: string | null | undefined): Date | null {
  if (!date || !time) return null;
  const m = /^\s*(\d{1,2})\s*[:hH]\s*(\d{2})/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, min));
}

/**
 * Promesse au client (3.3) : `created_at` + délai promis ; pour une commande
 * programmée plus tard, l'heure convenue + 10 min.
 */
export function promesseCommande(
  c: Pick<CommandePlanif, 'created_at' | 'heure_programmee'>,
  r: Pick<ReglagesPlanification, 'promesseClientMin'>,
): Date {
  const base = c.created_at.getTime() + r.promesseClientMin * 60_000;
  const prog = c.heure_programmee ? c.heure_programmee.getTime() + MARGE_PROGRAMMEE_MIN * 60_000 : null;
  return new Date(prog !== null && prog > base ? prog : base);
}

export function estHeureDePointe(date: Date): boolean {
  const m = date.getUTCHours() * 60 + date.getUTCMinutes();
  return HEURES_DE_POINTE.some(([debut, fin]) => m >= debut && m < fin);
}

/** Vitesse moyenne d'un livreur au départ donné (pointe ou non). */
export function vitesseKmh(depart: Date, r: Pick<ReglagesPlanification, 'vitesseMoyenneKmh' | 'vitessePointeKmh'>): number {
  return estHeureDePointe(depart) ? r.vitessePointeKmh : r.vitesseMoyenneKmh;
}

/**
 * Position qui peut DÉCIDER (départ du restaurant, présence au comptoir, sac
 * attendu) : la dernière assez précise (`position_sure`), sinon rien. Sans
 * ce champ (ancienne écriture, tests), la position elle-même.
 */
export function positionPourDecider(
  l: Pick<LivreurPlanif, 'position' | 'position_at' | 'position_sure'>,
): { position: ILatLng | null; position_at: Date | null } {
  if (l.position_sure === undefined) return { position: l.position, position_at: l.position_at };
  return l.position_sure ? { ...l.position_sure } : { position: null, position_at: null };
}

/**
 * Le livreur est-il au restaurant ? Dernière position PRÉCISE proche et de
 * moins de 15 min (4.2) : un relevé grossier qui tombe près du restaurant ne
 * met pas au comptoir un livreur qui en est loin.
 */
export function estAuRestaurant(
  l: Pick<LivreurPlanif, 'position' | 'position_at' | 'position_sure'>,
  restaurant: ILatLng | null,
  r: Pick<ReglagesPlanification, 'auRestaurantRayonM' | 'auRestaurantFraicheurMin'>,
  maintenant: Date,
): boolean {
  const { position, position_at } = positionPourDecider(l);
  if (!restaurant || !position || !position_at) return false;
  if (maintenant.getTime() - position_at.getTime() > r.auRestaurantFraicheurMin * 60_000) return false;
  return haversineMeters(position, restaurant) <= r.auRestaurantRayonM;
}

export type SourceEta = 'COMPTOIR' | 'GOOGLE' | 'VOL_OISEAU' | 'DEFAUT';

export interface EtaLivreur {
  secondes: number;
  source: SourceEta;
  au_comptoir: boolean;
}

/** Position connue de moins de `positionExpirationMin` (et restaurant situé). */
function positionFraiche(
  l: Pick<LivreurPlanif, 'position' | 'position_at'>,
  restaurant: ILatLng | null,
  r: Pick<ReglagesPlanification, 'positionExpirationMin'>,
  maintenant: Date,
): boolean {
  return (
    !!restaurant &&
    !!l.position &&
    !!l.position_at &&
    maintenant.getTime() - l.position_at.getTime() <= r.positionExpirationMin * 60_000
  );
}

/**
 * Livreurs dont le temps jusqu'au comptoir se mesure (position fraîche, hors
 * du comptoir), libres ou non : `etasLivreurs` exige un temps Google pour
 * TOUS ceux-là, sinon tout le monde est au vol d'oiseau. Le service demande
 * donc les temps Google de toute cette liste en un seul appel.
 */
export function livreursAMesurer<T extends LivreurPlanif>(
  livreurs: readonly T[],
  restaurant: ILatLng | null,
  r: ReglagesPlanification,
  maintenant: Date,
): T[] {
  return livreurs.filter((l) => !estAuRestaurant(l, restaurant, r, maintenant) && positionFraiche(l, restaurant, r, maintenant));
}

/**
 * Temps jusqu'au comptoir de chaque livreur (4.2) :
 *  - 0 s'il est au restaurant ;
 *  - position fraîche (moins de `positionExpirationMin`) : temps Google si
 *    TOUS les livreurs à position fraîche (hors comptoir) en ont un, sinon vol
 *    d'oiseau × 1,3 à la vitesse du moment pour tous (jamais de mélange) ;
 *  - position inconnue ou périmée : le défaut réglé (8 min).
 */
export function etasLivreurs(
  livreurs: readonly LivreurPlanif[],
  restaurant: ILatLng | null,
  r: ReglagesPlanification,
  maintenant: Date,
): Map<string, EtaLivreur> {
  const res = new Map<string, EtaLivreur>();
  const fraiche = (l: LivreurPlanif) => positionFraiche(l, restaurant, r, maintenant);
  const aMesurer = livreursAMesurer(livreurs, restaurant, r, maintenant);
  const googlePourTous =
    aMesurer.length > 0 &&
    aMesurer.every((l) => typeof l.secondes_google === 'number' && Number.isFinite(l.secondes_google) && l.secondes_google >= 0);
  const metresParSeconde = vitesseKmh(maintenant, r) / 3.6;

  for (const l of livreurs) {
    if (estAuRestaurant(l, restaurant, r, maintenant)) {
      res.set(l.id, { secondes: 0, source: 'COMPTOIR', au_comptoir: true });
    } else if (fraiche(l)) {
      if (googlePourTous) res.set(l.id, { secondes: l.secondes_google as number, source: 'GOOGLE', au_comptoir: false });
      else
        res.set(l.id, {
          secondes: (haversineMeters(l.position!, restaurant!) * FACTEUR_APPROCHE_LIVREUR) / metresParSeconde,
          source: 'VOL_OISEAU',
          au_comptoir: false,
        });
    } else {
      res.set(l.id, { secondes: r.etaParDefautMin * 60, source: 'DEFAUT', au_comptoir: false });
    }
  }
  return res;
}

/**
 * Classement des candidats, en minutes équivalentes (4.2) : au comptoir
 * d'abord, puis le plus petit coût, puis la file (FIFO).
 *
 *   coût = minutes jusqu'au comptoir − bonus de file (rang 1 : 3, rang 2 : 1,5)
 *          + 1 par place de pénalité de refus active
 *          + 0,5 × (courses du jour − moyenne des livreurs du restaurant)
 */
export function classerLivreurs(
  candidats: readonly LivreurPlanif[],
  tous: readonly LivreurPlanif[],
  etas: ReadonlyMap<string, EtaLivreur>,
  maintenant: Date,
): CoutLivreur[] {
  const file = [...candidats].sort((a, b) => ordreFile(a, b));
  const rang = new Map(file.map((l, i) => [l.id, i + 1]));
  const reference = tous.length ? tous : candidats;
  const moyenne = reference.length ? reference.reduce((s, l) => s + (l.courses_du_jour ?? 0), 0) / reference.length : 0;

  const couts = candidats.map((l): CoutLivreur => {
    const eta = etas.get(l.id) ?? { secondes: 8 * 60, source: 'DEFAUT' as const, au_comptoir: false };
    const r = rang.get(l.id)!;
    const bonus = BONUS_FILE_MIN[r - 1] ?? 0;
    const penalite =
      l.queue_penalty_until && l.queue_penalty_until.getTime() > maintenant.getTime()
        ? Math.max(0, l.queue_penalty_positions ?? 0) * PENALITE_PAR_PLACE_MIN
        : 0;
    const equite = EQUITE_PAR_COURSE_MIN * ((l.courses_du_jour ?? 0) - moyenne);
    return {
      deliverer_id: l.id,
      au_comptoir: eta.au_comptoir,
      eta_s: eta.secondes,
      source_eta: eta.source,
      rang_file: r,
      bonus_file_min: bonus,
      penalite_min: penalite,
      equite_min: equite,
      cout_min: eta.secondes / 60 - bonus + penalite + equite,
    };
  });
  const parId = new Map(candidats.map((l) => [l.id, l]));
  return couts.sort(
    (a, b) =>
      Number(b.au_comptoir) - Number(a.au_comptoir) ||
      a.cout_min - b.cout_min ||
      ordreFile(parId.get(a.deliverer_id)!, parId.get(b.deliverer_id)!),
  );
}

function ordreFile(a: LivreurPlanif, b: LivreurPlanif): number {
  const ta = a.etat.last_available_at?.getTime() ?? Number.POSITIVE_INFINITY;
  const tb = b.etat.last_available_at?.getTime() ?? Number.POSITIVE_INFINITY;
  return ta - tb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * `prolongee` : la fenêtre est échue mais une commande ajoutée reste à
 * remettre au livreur, encore au comptoir ; la course attend son sac (plus
 * aucun ajout ni retenue).
 */
export type FenetreApresRetrait =
  | { ouverte: true; ferme_a: Date; prolongee?: boolean }
  | { ouverte: false; motif: MotifDepart };

const STATUTS_LIVRAISON_TERMINEE: DeliveryStatut[] = [
  DeliveryStatut.DELIVERED,
  DeliveryStatut.FAILED,
  DeliveryStatut.CANCELLED,
];

/**
 * Ajout après le retrait (3.8) : la course récupérée peut-elle encore grossir ?
 * Toutes les conditions sont requises ; la première qui manque dit pourquoi
 * la course est réputée partie (motif du départ) :
 *  - réglage actif, appli du livreur au protocole 3 ou plus (l'ancienne
 *    traite toute livraison comme récupérée : le livreur partirait sans le
 *    plat), retrait daté ;
 *  - aucune livraison commencée (avec la nouvelle appli, la première ne
 *    démarre qu'au départ) ;
 *  - aucune position PRÉCISE (80 m au plus), reçue après le retrait, à
 *    plus du rayon de départ (un relevé imprécis ne décide rien, comme pour
 *    l'écouteur des positions) ;
 *  - retrait il y a moins de la fenêtre (240 s), comptée depuis la fin de la
 *    retenue si elle finit après le retrait (`debutFenetreApresRetraitMs`) ;
 *    au-delà, la course reste au comptoir au plus 2 min de plus si un sac de
 *    la course n'est pas encore remis (commande ajoutée, ou commande
 *    d'origine remise une par une au bouton de la caisse) et que le livreur
 *    y est encore (dernière position dans le rayon de départ) : sinon elle
 *    lui serait retirée sous les yeux pendant qu'il attend son sac.
 */
export function fenetreApresRetrait(
  course: Pick<CoursePlanif, 'statut' | 'parti_at' | 'picked_up_at' | 'livraisons'> & Partial<Pick<CoursePlanif, 'retenue_jusqua'>>,
  livreur: Pick<LivreurPlanif, 'protocole_appli' | 'position' | 'position_at' | 'position_sure'> | null,
  restaurant: ILatLng | null,
  r: Pick<ReglagesPlanification, 'ajoutApresRetrait' | 'ajoutApresRetraitMaxS' | 'departRayonM'>,
  maintenant: Date,
): FenetreApresRetrait {
  if (course.statut !== CourseStatut.IN_DELIVERY || course.parti_at) return { ouverte: false, motif: 'DEJA_PARTI' };
  if (!r.ajoutApresRetrait) return { ouverte: false, motif: 'AJOUT_COUPE' };
  if (!livreur || (livreur.protocole_appli ?? 0) < PROTOCOLE_AJOUT_APRES_RETRAIT) return { ouverte: false, motif: 'ANCIENNE_APPLI' };
  if (!course.picked_up_at) return { ouverte: false, motif: 'SANS_RETRAIT' };
  const commencee = course.livraisons.some(
    (l) => l.statut !== DeliveryStatut.PENDING && l.statut !== DeliveryStatut.CANCELLED,
  );
  if (commencee) return { ouverte: false, motif: 'LIVRAISON_DEMARREE' };
  const sure = positionPourDecider(livreur);
  if (
    restaurant &&
    sure.position &&
    sure.position_at &&
    sure.position_at.getTime() > course.picked_up_at.getTime() &&
    haversineMeters(sure.position, restaurant) > r.departRayonM
  ) {
    return { ouverte: false, motif: 'POSITION' };
  }
  const fermeA = debutFenetreApresRetraitMs(course)! + r.ajoutApresRetraitMaxS * 1000;
  if (fermeA <= maintenant.getTime()) {
    const prolongee = attendSonSac({
      fermeAMs: fermeA,
      maintenant,
      sacAttendu: course.livraisons.some(estSacAuComptoir),
      position: sure.position,
      position_at: sure.position_at,
      restaurant,
      departRayonM: r.departRayonM,
    });
    return prolongee ? { ouverte: true, ferme_a: new Date(fermeA), prolongee: true } : { ouverte: false, motif: 'FENETRE_ECHUE' };
  }
  return { ouverte: true, ferme_a: new Date(fermeA) };
}

/**
 * Début de la fenêtre d'ajout après le retrait (essai du 25/10) : la fin de
 * la retenue si elle tombe après le retrait (retenue en cours, ou levée
 * après la remise : la levée écrit son heure dans `retenue_jusqua`), sinon
 * le retrait. La caisse remet dès le code, même pendant une retenue : la
 * fenêtre comptée depuis la remise faisait partir la course 4 min après,
 * livreur au comptoir, et la commande attendue partait seule. `null` sans
 * retrait. Règle partagée avec l'écran Opérations (`fenetre_ajout_ferme_a`).
 */
export function debutFenetreApresRetraitMs(course: {
  picked_up_at: Date | null;
  retenue_jusqua?: Date | null;
}): number | null {
  if (!course.picked_up_at) return null;
  const retrait = course.picked_up_at.getTime();
  const retenue = course.retenue_jusqua?.getTime() ?? null;
  return retenue !== null && retenue > retrait ? retenue : retrait;
}

/**
 * Fenêtre d'ajout échue (`fermeAMs`), mais la course attend encore son sac :
 * une commande de la course reste à remettre (`estSacAuComptoir`) et le
 * livreur est encore au comptoir : sa DERNIÈRE position connue est dans le
 * rayon de départ. Son âge ne compte pas : une position plus loin reçue
 * après le retrait aurait déjà fait partir la course, et le livreur était au
 * comptoir au retrait, il y a 6 min au plus. Seule une position PRÉCISE
 * compte (`positionPourDecider`). Un téléphone sans la permission
 * « Toujours », appli en arrière-plan, n'envoie plus rien : exiger une
 * position récente retirait la commande au livreur qui attendait son sac
 * (seconde passe du 23/10). Elle reste au comptoir au plus
 * `PROLONGATION_REMISE_S` de plus. Règle partagée avec l'écran Opérations
 * (`fenetre_ajout_ferme_a`).
 */
export function attendSonSac(p: {
  fermeAMs: number;
  maintenant: Date;
  sacAttendu: boolean;
  position: ILatLng | null;
  position_at: Date | null;
  restaurant: ILatLng | null;
  departRayonM: number;
}): boolean {
  const t = p.maintenant.getTime();
  if (!p.sacAttendu || t < p.fermeAMs || t >= p.fermeAMs + PROLONGATION_REMISE_S * 1000) return false;
  if (!p.restaurant || !p.position || !p.position_at) return false;
  return haversineMeters(p.position, p.restaurant) <= p.departRayonM;
}

export interface DecisionTurbo {
  basculer: boolean;
  /** Minutes depuis la plus ancienne commande prête (ou la création de la course). */
  minutes: number;
  depuis: Date;
}

/**
 * Turbo sous v2 (3.11) : dernier recours pour une course sans livreur
 * interne, compté depuis la plus ancienne `ready_at` de ses commandes (la
 * course naît maintenant à `ready_at` et non 2 à 3 min plus tard, d'où le
 * défaut de 6 min qui garde l'instant effectif d'avant). Jamais pendant une
 * offre en attente, jamais sur une course Turbo d'origine ou déjà confiée.
 */
export function decisionTurboV2(
  course: Pick<CoursePlanif, 'statut' | 'deliverer_id' | 'turbo_escalated_at' | 'created_at' | 'offre' | 'livraisons'>,
  r: Pick<ReglagesPlanification, 'turboActif' | 'turboApresMinV2'>,
  maintenant: Date,
): DecisionTurbo {
  const actives = livraisonsActives(course.livraisons);
  const pretes = actives.map((l) => l.commande.ready_at?.getTime()).filter((t): t is number => typeof t === 'number');
  const depuis = new Date(pretes.length ? Math.min(...pretes) : course.created_at.getTime());
  const minutes = (maintenant.getTime() - depuis.getTime()) / 60_000;
  const basculer =
    r.turboActif &&
    course.statut === CourseStatut.PENDING_ASSIGNMENT &&
    !course.deliverer_id &&
    !course.turbo_escalated_at &&
    !course.offre &&
    actives.length > 0 &&
    !estCourseTurboDOrigine(actives.map((l) => ({ order: { delivery_service: l.commande.delivery_service } }))) &&
    minutes >= r.turboApresMinV2;
  return { basculer, minutes, depuis };
}

/**
 * Commande ajoutée après le retrait et pas encore remise au livreur : la
 * seule qu'un départ détache. Une commande de la course d'origine encore
 * prête (bouton de la caisse « Livreur a récupéré » commande par commande)
 * reste dans la course : la caissière la remet par le même bouton.
 */
function estAjoutNonRemis(l: LivraisonPlanif): boolean {
  return l.ajoutee_apres_retrait === true && l.commande.statut === OrderStatus.READY && l.statut === DeliveryStatut.PENDING;
}

/**
 * Sac encore au comptoir : commande de la course prête et pas remise, ajoutée
 * après le retrait ou d'origine (remise une par une au bouton de la caisse).
 * Le livreur qui l'attend garde sa course au comptoir (`attendSonSac`).
 */
function estSacAuComptoir(l: LivraisonPlanif): boolean {
  return l.commande.statut === OrderStatus.READY && l.statut === DeliveryStatut.PENDING;
}

/** Livraisons qui comptent : ni annulées, ni échouées, ni livrées, commande non annulée. */
function livraisonsActives(livraisons: readonly LivraisonPlanif[]): LivraisonPlanif[] {
  return [...livraisons]
    .filter((l) => !STATUTS_LIVRAISON_TERMINEE.includes(l.statut) && l.commande.statut !== OrderStatus.CANCELLED)
    .sort((a, b) => a.sequence_order - b.sequence_order);
}

/**
 * Course qui cherche un livreur (sans livreur, pas chez Turbo) dont toutes
 * les commandes ont été annulées ou les livraisons closes : elle n'a plus
 * rien à livrer. Il faut au moins une livraison : une course en train de
 * naître (création suivie du déplacement des livraisons) n'est jamais vue
 * comme vide.
 */
export function estCourseVideSansLivreur(
  k: Pick<CoursePlanif, 'statut' | 'deliverer_id' | 'turbo_escalated_at' | 'livraisons'>,
): boolean {
  return (
    k.statut === CourseStatut.PENDING_ASSIGNMENT &&
    !k.deliverer_id &&
    !k.turbo_escalated_at &&
    k.livraisons.length > 0 &&
    livraisonsActives(k.livraisons).length === 0
  );
}

/**
 * Paires de commandes dont le planificateur peut avoir besoin, pour que le
 * service mesure leur verdict de direction (Google compris, cache 30 jours)
 * avant d'appeler `planifier` : toutes les paires entre commandes « mobiles »
 * (prêtes ou en préparation sans course, courses sans livreur, commandes
 * détachables), entre une mobile et une commande d'une course ouverte, et au
 * sein de chaque course ouverte. Jamais entre deux courses déjà affectées.
 * Les commandes sans coordonnées sont omises (elles partent seules).
 */
export function pairesAEvaluer(
  instantane: InstantanePlanification,
  r: Pick<ReglagesPlanification, 'horizonPreparationS' | 'attenteMaxTrajetLongS'> = REGLAGES_PLANIFICATION_DEFAUT,
): [ClientDirection, ClientDirection][] {
  const t = instantane.maintenant.getTime();
  const mobiles: ClientDirection[] = [];
  const groupes: ClientDirection[][] = [];
  // Une commande en préparation peut retenir une course si elle est prête dans
  // l'horizon (attente courte) ou, pour un trajet long, avant que la commande
  // prête n'ait attendu `attenteMaxTrajetLongS` (prête au plus tard d'ici là).
  const fenetreS = Math.max(r.horizonPreparationS, r.attenteMaxTrajetLongS);

  for (const c of instantane.commandes) {
    if (c.delivery_service !== DeliveryService.CHICKEN_NATION) continue;
    if (c.statut === OrderStatus.READY) mobiles.push(c.client);
    else if (
      c.statut === OrderStatus.IN_PROGRESS &&
      c.preparation &&
      c.preparation.finDecision.getTime() - t <= fenetreS * 1000
    )
      mobiles.push(c.client);
  }
  for (const k of instantane.courses) {
    if (k.statut === CourseStatut.IN_DELIVERY && k.parti_at) continue;
    if (k.turbo_escalated_at) continue;
    const actives = livraisonsActives(k.livraisons);
    if (estCourseTurboDOrigine(actives.map((l) => ({ order: { delivery_service: l.commande.delivery_service } })))) continue;
    const clients = actives.map((l) => l.commande.client);
    if (k.statut === CourseStatut.PENDING_ASSIGNMENT && !k.deliverer_id) mobiles.push(...clients);
    else {
      groupes.push(clients);
      if (k.statut === CourseStatut.IN_DELIVERY)
        mobiles.push(...actives.filter((l) => l.commande.statut === OrderStatus.READY).map((l) => l.commande.client));
    }
  }

  const vues = new Set<string>();
  const paires: [ClientDirection, ClientDirection][] = [];
  const ajouter = (a: ClientDirection, b: ClientDirection) => {
    if (a.id === b.id || !a.position || !b.position) return;
    const cle = clePaire(a.id, b.id);
    if (vues.has(cle)) return;
    vues.add(cle);
    paires.push([a, b]);
  };
  for (let i = 0; i < mobiles.length; i++) for (let j = i + 1; j < mobiles.length; j++) ajouter(mobiles[i], mobiles[j]);
  for (const g of groupes) {
    for (const m of mobiles) for (const c of g) ajouter(m, c);
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) ajouter(g[i], g[j]);
  }
  return paires;
}

// ─── Moteur ──────────────────────────────────────────────────────────────────

/** Une commande dans une tournée en cours de calcul. */
interface Arret {
  id: string;
  reference: string;
  client: ClientDirection;
  promesseMs: number;
  /** Promesse + retard toléré. */
  limiteMs: number;
  readyMs: number | null;
  statut: OrderStatus;
}

/**
 * Rang d'une course comme cible d'un ajout ou d'une fusion (3.4) :
 * 0 = récupérée, livreur encore au restaurant ; 1 = au comptoir ;
 * 2 = livreur en route ; 3 = sans livreur. `null` : pas une cible (Turbo,
 * livreur en pause, partie).
 */
type CategorieCible = 0 | 1 | 2 | 3;

interface CourseTravail {
  cle: string;
  id: string | null;
  reference: string;
  source: CoursePlanif | null;
  statut: CourseStatut;
  delivererId: string | null;
  arrets: Arret[];
  offre: OffrePlanif | null;
  categorie: CategorieCible | null;
  fenetreFermeMs: number | null;
  modifiee: boolean;
  absorbee: boolean;
  nouvelle: boolean;
  dejaSollicites: Set<string>;
}

interface EstimationGroupe {
  valide: boolean;
  verdict: VerdictGroupe | null;
  ordre: string[];
  base: ClassementDistance;
  arriveesMs: Map<string, number>;
  /** Restaurant → dernier client, arrêts compris. */
  dureeS: number;
}

type ResultatAjout =
  | { ok: true; estimation: EstimationGroupe; detourS: number; motif: MotifDirection | null; libelle: string }
  | { ok: false; refus: MotifRefusPlanification; libelle: string };

interface Contexte {
  instantane: InstantanePlanification;
  maintenant: Date;
  t: number;
  r: ReglagesPlanification;
  restaurant: ILatLng | null;
  livreurs: Map<string, LivreurPlanif>;
  etas: Map<string, EtaLivreur>;
  /** Livreurs pouvant recevoir une offre maintenant (mis à jour au fil du passage). */
  libres: Set<string>;
  clients: Map<string, ClientDirection>;
  verdicts: Map<string, VerdictPaire>;
  verdictDe: (a: ClientDirection, b: ClientDirection) => VerdictPaire;
  /** Retours estimés des livreurs en course, du plus proche au plus lointain (calculés une fois par passage). */
  retours?: RetourLivreur[];
}

/** Retour estimé au restaurant d'un livreur en course. */
interface RetourLivreur {
  id: string;
  ms: number;
}

function creerContexte(inst: InstantanePlanification, r: ReglagesPlanification, options: OptionsPlanification): Contexte {
  const maintenant = inst.maintenant;
  const restaurant = inst.restaurant.position;
  const livreurs = new Map(inst.livreurs.map((l) => [l.id, l]));
  const clients = new Map<string, ClientDirection>();
  for (const c of inst.commandes) clients.set(c.id, c.client);
  for (const k of inst.courses) for (const l of k.livraisons) clients.set(l.commande.id, l.commande.client);

  const verdicts = new Map<string, VerdictPaire>(options.verdicts ?? []);
  const verdictDe = (a: ClientDirection, b: ClientDirection): VerdictPaire => {
    const cle = clePaire(a.id, b.id);
    const connu = verdicts.get(cle);
    if (connu) return connu;
    const v = evaluerPaire(restaurant, clients.get(a.id) ?? a, clients.get(b.id) ?? b, r.direction, null) as VerdictPaire;
    verdicts.set(cle, v);
    return v;
  };

  const libres = new Set(inst.livreurs.filter((l) => peutRecevoirOffre(l.etat, maintenant).ok).map((l) => l.id));
  return {
    instantane: inst,
    maintenant,
    t: maintenant.getTime(),
    r,
    restaurant,
    livreurs,
    etas: etasLivreurs(inst.livreurs, restaurant, r, maintenant),
    libres,
    clients,
    verdicts,
    verdictDe,
  };
}

function arretDe(ctx: Contexte, c: CommandePlanif): Arret {
  const promesseMs = promesseCommande(c, ctx.r).getTime();
  return {
    id: c.id,
    reference: c.reference,
    client: c.client,
    promesseMs,
    limiteMs: promesseMs + ctx.r.retardMaxClientMin * 60_000,
    readyMs: c.ready_at?.getTime() ?? null,
    statut: c.statut,
  };
}

const sansCarte = (c: ClientDirection): ClientDirection => ({ ...c, trace: null, routeMetres: null });

/** Au-delà de 3 arrêts placés, l'ordre de la direction seul (6 ordres au plus à essayer). */
export const ARRETS_MAX_ORDRE_PAR_PROMESSE = 3;

interface OptionsEstimation {
  /** Sans tracé ni distance routière, pour comparer deux estimations sur la même base. */
  volOiseau?: boolean;
  /** L'ordre de la direction seul, sans essayer les autres (repli de `evaluerAjout`). */
  geographique?: boolean;
}

/** Toutes les permutations d'une petite liste (3 éléments au plus ici). */
function permutations<T>(liste: readonly T[]): T[][] {
  if (liste.length <= 1) return [[...liste]];
  return liste.flatMap((x, i) => permutations([...liste.slice(0, i), ...liste.slice(i + 1)]).map((reste) => [x, ...reste]));
}

/**
 * Tournée d'un groupe partant à `departMs` : validité de la direction, ordre
 * des arrêts, arrivée estimée de chaque client (trajets + 3 min par arrêt
 * précédent), durée. Groupe invalide (ancienne course) : estimé en « même
 * zone » pour comparer, jamais accepté comme nouveau groupe.
 *
 * ORDRE DES ARRÊTS : celui de la direction (le long du trajet, ou au plus
 * proche voisin dans la zone). Quand un client y arriverait après sa LIMITE
 * (promesse + retard toléré), les autres ordres des 2 ou 3 arrêts sont
 * essayés (aucun appel Google, même base) : celui qui réduit le plus le
 * retard au-delà des limites, puis au-delà des promesses, puis la tournée la
 * plus courte, sans dépasser la durée de tournée maximale, l'emporte
 * (relecture du 24/10 : le client le plus pressé passait après un client plus
 * récent du même trajet, d'où un regroupement refusé ou un client en retard).
 * Un retard dans le délai toléré ne change pas l'ordre : revenir sur ses pas
 * allongerait la tournée pour quelques secondes.
 */
function estimer(ctx: Contexte, arrets: readonly Arret[], departMs: number, options: OptionsEstimation = {}): EstimationGroupe {
  const arriveesMs = new Map<string, number>();
  if (arrets.length === 0) return { valide: true, verdict: null, ordre: [], base: 'vol_oiseau', arriveesMs, dureeS: 0 };
  const R = ctx.restaurant;
  const clients = arrets.map((a) => (options.volOiseau ? sansCarte(a.client) : a.client));
  // Client sans coordonnées (ou restaurant sans coordonnées) : trajet supposé
  // (`trajetSansCoordonneesMin`), jamais « arrivé au départ ». Sinon une telle
  // commande paraissait la moins urgente de toutes.
  const sansPositionMs = departMs + ctx.r.trajetSansCoordonneesMin * 60_000;
  if (!R) {
    for (const a of arrets) arriveesMs.set(a.id, sansPositionMs);
    return { valide: arrets.length === 1, verdict: null, ordre: arrets.map((a) => a.id), base: 'vol_oiseau', arriveesMs, dureeS: 0 };
  }
  const verdict = evaluerGroupe(R, clients, ctx.verdictDe);
  const mode: ModeGroupe = verdict.valide && verdict.mode ? verdict.mode : clients.length === 1 ? 'seul' : 'zone';
  const ordreDirection = verdict.valide ? verdict.ordre : ordonnerArrets(R, clients, { mode });
  const parId = new Map(clients.map((c) => [c.id, c]));
  const lointain = verdict.valide && verdict.lointainId ? parId.get(verdict.lointainId) ?? null : null;
  const vitesse = vitesseKmh(new Date(departMs), ctx.r);

  const tournee = (ordre: readonly string[]) => {
    const ordonnes = ordre.map((id) => parId.get(id)!).filter(Boolean);
    const est = estimerTrajets(R, ordonnes, { mode, lointain, vitesseKmh: vitesse });
    const places = ordonnes.filter((c) => c.position);
    const arrivees = new Map<string, number>();
    places.forEach((c, i) => arrivees.set(c.id, departMs + (est.secondesCumulees[i] + i * ARRET_CLIENT_S) * 1000));
    for (const c of ordonnes) if (!arrivees.has(c.id)) arrivees.set(c.id, sansPositionMs);
    const dureeS = places.length ? est.secondesCumulees[places.length - 1] + (places.length - 1) * ARRET_CLIENT_S : 0;
    return { ordre: [...ordre], base: est.base, arrivees, dureeS };
  };
  /** Retards cumulés au-delà des limites et au-delà des promesses (ms). */
  const retards = (arrivees: ReadonlyMap<string, number>) => {
    let limite = 0;
    let promesse = 0;
    for (const a of arrets) {
      const arrivee = arrivees.get(a.id) ?? departMs;
      limite += Math.max(0, arrivee - a.limiteMs);
      promesse += Math.max(0, arrivee - a.promesseMs);
    }
    return { limite, promesse };
  };

  const direction = tournee(ordreDirection);
  let choix = direction;
  const places = ordreDirection.filter((id) => parId.get(id)?.position);
  const retardDirection = retards(direction.arrivees);
  if (!options.geographique && retardDirection.limite > 0 && places.length >= 2 && places.length <= ARRETS_MAX_ORDRE_PAR_PROMESSE) {
    const sansPosition = ordreDirection.filter((id) => !parId.get(id)?.position);
    const dureeMaxS = Math.max(direction.dureeS, ctx.r.dureeTourneeMaxMin * 60);
    // Clé lexicographique : retard au-delà des limites, au-delà des promesses, durée (à la seconde près).
    const cle = (t: ReturnType<typeof tournee>) => {
      const r = retards(t.arrivees);
      return [Math.round(r.limite / 1000), Math.round(r.promesse / 1000), Math.round(t.dureeS)];
    };
    const cleDirection = cle(direction);
    let meilleure = cleDirection;
    for (const ordre of permutations(places)) {
      const essai = tournee([...ordre, ...sansPosition]);
      if (essai.dureeS > dureeMaxS) continue;
      const c = cle(essai);
      // Il faut faire mieux que l'ordre de la direction sur le retard au-delà des limites.
      if (c[0] >= cleDirection[0]) continue;
      if (comparerCles(c, meilleure) < 0) {
        choix = essai;
        meilleure = c;
      }
    }
  }
  for (const [id, a] of choix.arrivees) arriveesMs.set(id, a);
  return { valide: verdict.valide, verdict, ordre: choix.ordre, base: choix.base, arriveesMs, dureeS: choix.dureeS };
}

/** Comparer deux estimations sur la même base : vol d'oiseau pour les deux si elles diffèrent. */
function memeBase(
  ctx: Contexte,
  a: { arrets: readonly Arret[]; departMs: number; est: EstimationGroupe },
  b: { arrets: readonly Arret[]; departMs: number; est: EstimationGroupe },
  geographique = false,
): [EstimationGroupe, EstimationGroupe] {
  if (a.est.base === b.est.base || a.arrets.length === 0 || b.arrets.length === 0) return [a.est, b.est];
  return [
    estimer(ctx, a.arrets, a.departMs, { volOiseau: true, geographique }),
    estimer(ctx, b.arrets, b.departMs, { volOiseau: true, geographique }),
  ];
}

/**
 * Aller-retour estimé d'une course qui part du restaurant à `departMs`
 * (trajet long, demande du 24/10) : la tournée de `estimer` (ordre des
 * arrêts, trajets, remise de 3 min à chaque arrêt précédent), la remise au
 * dernier client, puis son retour au restaurant. Retour estimé sans Google
 * comme l'aller (`estimerTrajets`) : distance routière connue du dernier
 * client, sinon vol d'oiseau × 1,4, à la vitesse du départ (pointe ou non).
 * Jamais de mélange : si l'aller et le retour ne sont pas sur la même base,
 * les deux sont repris au vol d'oiseau. Client (ou restaurant) sans
 * coordonnées : trajet supposé `trajetSansCoordonneesMin`, comme pour le
 * retour d'un livreur en course.
 */
function allerRetourMs(ctx: Contexte, arrets: readonly Arret[], departMs: number): number {
  if (arrets.length === 0) return 0;
  const R = ctx.restaurant;
  const vitesse = vitesseKmh(new Date(departMs), ctx.r);
  const tournee = (volOiseau: boolean) => {
    const est = estimer(ctx, arrets, departMs, { volOiseau });
    // Dernier arrêt de la tournée : la plus tardive des arrivées estimées.
    let dernier: Arret = arrets[0];
    let arriveeMs = Number.NEGATIVE_INFINITY;
    for (const id of est.ordre) {
      const a = est.arriveesMs.get(id);
      if (a !== undefined && a >= arriveeMs) {
        arriveeMs = a;
        dernier = arrets.find((x) => x.id === id) ?? dernier;
      }
    }
    const client = volOiseau ? sansCarte(dernier.client) : dernier.client;
    const retour =
      R && client.position ? estimerTrajets(R, [client], { mode: 'seul', vitesseKmh: vitesse }) : null;
    return { est, arriveeMs, retour };
  };
  let choix = tournee(false);
  if (choix.retour && choix.retour.base !== choix.est.base) choix = tournee(true);
  const retourMs = choix.retour ? choix.retour.secondesTotal * 1000 : ctx.r.trajetSansCoordonneesMin * 60_000;
  // À la milliseconde : la frontière « petit retard » se compare à des heures entières.
  return Math.round(choix.arriveeMs - departMs + ARRET_CLIENT_S * 1000 + retourMs);
}

/**
 * Aller-retour estimé (millisecondes) d'une course de l'instantané qui part du
 * restaurant à `depart` : la mesure qui sépare l'attente courte du trajet
 * long (3.5). Exposée pour les tests et l'analyse des retenues.
 */
export function allerRetourCourseMs(
  instantane: InstantanePlanification,
  course: Pick<CoursePlanif, 'livraisons'>,
  depart: Date,
  reglages: ReglagesPlanification = REGLAGES_PLANIFICATION_DEFAUT,
  options: OptionsPlanification = {},
): number {
  const ctx = creerContexte(instantane, reglages, options);
  return allerRetourMs(ctx, livraisonsActives(course.livraisons).map((l) => arretDe(ctx, l.commande)), depart.getTime());
}

const minutesTexte = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

/**
 * Le cœur des limites (3.6) : ajouter `nouveaux` à `existants`.
 *  - TAILLE : au plus `maxCommandesParCourse` ;
 *  - ATTENTE_COMMANDE_PRETE (si `attente`) : une commande prête n'attend pas
 *    au comptoir plus de l'attente maximale à cause d'un regroupement quand
 *    un livreur libre pourrait partir plus tôt avec elle ;
 *  - DIRECTION : le groupe entier va dans la même direction ;
 *  - DUREE_TOURNEE : restaurant → dernier client, arrêts compris ;
 *  - DETOUR_AJOUT : aucune commande déjà prévue n'est retardée de plus du
 *    détour maximal par la tournée (attente au comptoir à part) ;
 *  - RETARD_CLIENT : aucune commande déjà prévue n'est poussée au-delà de
 *    sa promesse + retard toléré (départ connu seulement) ; une commande
 *    ajoutée n'arrive pas après sa limite, sauf si elle n'arriverait pas
 *    plus tôt seule (ou si aucun livreur ne pourrait la prendre seule).
 * Toute comparaison entre deux estimations se fait sur la même base (vol
 * d'oiseau pour les deux si l'une n'a pas de tracé).
 *
 * L'ordre des arrêts tient compte des promesses (`estimer`). Un refus qui
 * dépend de l'ordre (durée, détour, retard) est réessayé dans l'ordre de la
 * direction seul : tout ce qui passait avant passe encore.
 */
function evaluerAjout(ctx: Contexte, p: ParametresAjout): ResultatAjout {
  const res = evaluerAjoutSelonOrdre(ctx, p, false);
  if (res.ok || !REFUS_SELON_ORDRE.includes(res.refus)) return res;
  const direction = evaluerAjoutSelonOrdre(ctx, p, true);
  return direction.ok ? direction : res;
}

const REFUS_SELON_ORDRE: readonly MotifRefusPlanification[] = ['DUREE_TOURNEE', 'DETOUR_AJOUT', 'RETARD_CLIENT'];

interface ParametresAjout {
  existants: readonly Arret[];
  nouveaux: readonly Arret[];
  departAvantMs: number;
  departApresMs: number;
  /** Départ des nouvelles commandes si elles partaient seules ; `null` = aucun livreur pour elles. */
  departSeulMs: number | null;
  attente: { premierePreteMs: number } | null;
  /**
   * Le départ de la course est connu (livreur affecté, offre en attente,
   * livreur libre) ou estimé (premier retour d'un livreur en course). Faux :
   * personne ne peut la prendre et aucun retour n'est estimable, le départ
   * n'est qu'une supposition ; toutes ses commandes attendent un livreur et
   * la regrouper ne fait que mieux employer le premier qui se libère. Le
   * détour maximal joue toujours, le retard des commandes déjà prévues non.
   */
  departConnu: boolean;
  /**
   * Le groupe attendra un livreur (personne de libre ne peut le prendre) :
   * le regrouper ne doit pas avancer la bascule vers Turbo (3.11) d'une
   * partie du groupe de plus d'une minute, sauf si le premier livreur
   * attendu (`retourMs`) revient avant cette bascule. Turbo dégroupe (une
   * course par commande) : le regroupement n'y gagne rien.
   */
  attendLivreur?: { retourMs: number | null } | null;
}

function evaluerAjoutSelonOrdre(ctx: Contexte, p: ParametresAjout, geographique: boolean): ResultatAjout {
  const r = ctx.r;
  const opt: OptionsEstimation = { geographique };
  const tous = [...p.existants, ...p.nouveaux];
  if (tous.length > r.maxCommandesParCourse) return { ok: false, refus: 'TAILLE', libelle: 'course pleine' };
  if (p.attendLivreur && r.turboActif && p.existants.length > 0 && p.nouveaux.length > 0) {
    const bascule = (arrets: readonly Arret[]) => plusAnciennePrete(ctx, arrets) + r.turboApresMinV2 * 60_000;
    const [bE, bN] = [bascule(p.existants), bascule(p.nouveaux)];
    const groupe = Math.min(bE, bN);
    const retour = p.attendLivreur.retourMs;
    if (
      Math.max(bE, bN) - groupe > TOLERANCE_AVANCE_TURBO_S * 1000 &&
      (retour === null || retour > groupe + attenteRetourMs(ctx))
    ) {
      return { ok: false, refus: 'AVANCE_TURBO', libelle: 'partirait plus tôt chez Turbo' };
    }
  }
  if (
    p.attente &&
    p.departSeulMs !== null &&
    p.departApresMs > p.attente.premierePreteMs + r.attenteMaxCommandePreteS * 1000 &&
    p.departSeulMs < p.departApresMs
  ) {
    return { ok: false, refus: 'ATTENTE_COMMANDE_PRETE', libelle: 'attente trop longue au restaurant' };
  }

  const apres = estimer(ctx, tous, p.departApresMs, opt);
  if (!apres.valide) {
    return { ok: false, refus: 'DIRECTION', libelle: apres.verdict?.refus?.libelle || libelleDirection('DIRECTION_DIFFERENTE') };
  }
  if (tous.length >= 2 && apres.dureeS > r.dureeTourneeMaxMin * 60) {
    return { ok: false, refus: 'DUREE_TOURNEE', libelle: `tournée de ${minutesTexte(apres.dureeS * 1000)}, trop longue` };
  }

  const avant0 = estimer(ctx, p.existants, p.departAvantMs, opt);
  const [avant, apresCmp] = memeBase(
    ctx,
    { arrets: p.existants, departMs: p.departAvantMs, est: avant0 },
    { arrets: tous, departMs: p.departApresMs, est: apres },
    geographique,
  );
  for (const o of p.existants) {
    const a0 = avant.arriveesMs.get(o.id)!;
    const a1 = apresCmp.arriveesMs.get(o.id)!;
    const retardTournee = a1 - p.departApresMs - (a0 - p.departAvantMs);
    if (retardTournee > r.detourMaxAjoutMin * 60_000) {
      return { ok: false, refus: 'DETOUR_AJOUT', libelle: `retarderait ${o.reference} de ${minutesTexte(retardTournee)}` };
    }
    if (p.departConnu && a1 > o.limiteMs && a1 > a0) {
      return { ok: false, refus: 'RETARD_CLIENT', libelle: `${o.reference} arriverait en retard` };
    }
  }
  if (p.departSeulMs !== null) {
    for (const q of p.nouveaux) {
      const seul0 = estimer(ctx, [q], p.departSeulMs, opt);
      const [groupe, seul] = memeBase(
        ctx,
        { arrets: tous, departMs: p.departApresMs, est: apres },
        { arrets: [q], departMs: p.departSeulMs, est: seul0 },
        geographique,
      );
      const aq = groupe.arriveesMs.get(q.id)!;
      if (aq > Math.max(q.limiteMs, seul.arriveesMs.get(q.id)!)) {
        return { ok: false, refus: 'RETARD_CLIENT', libelle: `${q.reference} arriverait en retard` };
      }
    }
  }
  const detourS = p.existants.length ? Math.max(0, apresCmp.dureeS - avant.dureeS) : 0;
  const motif = tous.length >= 2 ? apres.verdict?.motif ?? null : null;
  return { ok: true, estimation: apres, detourS, motif, libelle: motif ? apres.verdict!.libelle : '' };
}

/** Course de travail depuis l'instantané ; `categorie` nulle si elle ne peut pas grossir. */
function courseTravail(ctx: Contexte, k: CoursePlanif, fenetreFermeMs: number | null): CourseTravail {
  const actives = livraisonsActives(k.livraisons);
  const turbo =
    !!k.turbo_escalated_at ||
    estCourseTurboDOrigine(actives.map((l) => ({ order: { delivery_service: l.commande.delivery_service } })));
  const livreur = k.deliverer_id ? ctx.livreurs.get(k.deliverer_id) ?? null : null;
  const enPause = !!livreur && (estEnPause(livreur.etat, ctx.maintenant) || estEnPauseAuto(livreur.etat, ctx.maintenant));

  let categorie: CategorieCible | null = null;
  // Course vide (toutes ses commandes annulées) : jamais une cible. Sinon la
  // commande prête suivante s'y collait et héritait de son âge (expiration,
  // cloche déjà sonnée) et de ses refus.
  if (!turbo && actives.length > 0) {
    if (k.statut === CourseStatut.PENDING_ASSIGNMENT && !k.deliverer_id) categorie = 3;
    else if (k.deliverer_id && !enPause) {
      if (k.statut === CourseStatut.ACCEPTED) categorie = 2;
      else if (k.statut === CourseStatut.AT_RESTAURANT) categorie = 1;
      else if (k.statut === CourseStatut.IN_DELIVERY && fenetreFermeMs !== null) categorie = 0;
    }
  }
  return {
    cle: k.id,
    id: k.id,
    reference: k.reference,
    source: k,
    statut: k.statut,
    delivererId: k.deliverer_id,
    arrets: actives.map((l) => arretDe(ctx, l.commande)),
    offre: k.offre,
    categorie,
    fenetreFermeMs,
    modifiee: false,
    absorbee: false,
    nouvelle: false,
    dejaSollicites: exclusDeLaCourse(ctx, k),
  };
}

/**
 * Livreurs à qui la course n'est plus proposée : ceux qui l'ont refusée
 * (définitif, 4.4), et ceux qui ont laissé expirer son offre SANS signe de
 * vie depuis (position ou requête de l'appli postérieure à l'expiration). Un
 * livreur qui avait le téléphone en poche et rouvre l'appli au comptoir
 * redevient candidat : sinon, à deux livreurs, la course partait chez Turbo
 * alors qu'il attendait au comptoir. Sa pénalité de file reste due. Une
 * seule seconde chance par course : deux expirations l'en excluent.
 */
function exclusDeLaCourse(ctx: Contexte, k: Pick<CoursePlanif, 'deja_sollicites' | 'expirees'>): Set<string> {
  const exclus = new Set(k.deja_sollicites);
  const parLivreur = new Map<string, Date[]>();
  for (const e of k.expirees ?? []) parLivreur.set(e.deliverer_id, [...(parLivreur.get(e.deliverer_id) ?? []), e.a]);
  for (const [id, expirations] of parLivreur) {
    if (exclus.has(id)) continue;
    // Une seule seconde chance : laissée expirer deux fois, la course ne lui
    // revient plus (chaque expiration compte un refus sur la course).
    if (expirations.length >= EXPIRATIONS_MAX_PAR_LIVREUR) {
      exclus.add(id);
      continue;
    }
    const derniere = new Date(Math.max(...expirations.map((a) => a.getTime())));
    if (!signeDeVieApres(ctx.livreurs.get(id), derniere)) exclus.add(id);
  }
  return exclus;
}

/** Expirations d'une même course au-delà desquelles le livreur n'en reçoit plus l'offre. */
export const EXPIRATIONS_MAX_PAR_LIVREUR = 2;

/** Le livreur a-t-il donné signe de vie (position, requête de l'appli) après cet instant ? */
export function signeDeVieApres(l: Pick<LivreurPlanif, 'position_at' | 'dernier_signal_at'> | undefined, a: Date): boolean {
  if (!l) return false;
  const t = a.getTime();
  return (!!l.position_at && l.position_at.getTime() > t) || (!!l.dernier_signal_at && l.dernier_signal_at.getTime() > t);
}

function etaMs(ctx: Contexte, delivererId: string | null): number {
  const eta = delivererId ? ctx.etas.get(delivererId) : undefined;
  return (eta?.secondes ?? ctx.r.etaParDefautMin * 60) * 1000;
}

/**
 * Départ au plus tôt avec un livreur libre (le plus proche), ou `null` sans
 * livreur libre. `exclus` : livreurs qui ont déjà refusé ou laissé expirer
 * la course (ils ne la recevront plus).
 */
function departLibreMs(ctx: Contexte, enPlus: readonly string[] = [], exclus: ReadonlySet<string> = new Set()): number | null {
  const ids = [...new Set([...ctx.libres, ...enPlus])].filter((id) => !exclus.has(id));
  if (ids.length === 0) return null;
  return ctx.t + Math.min(...ids.map((id) => etaMs(ctx, id)));
}

const AUCUN_EXCLU: ReadonlySet<string> = new Set();

/**
 * Personne de libre : retour au restaurant le plus proche d'un livreur en
 * course (ni en pause, ni hors service), estimé sans Google
 * (`retourAuRestaurantMs`). `exclus` : livreurs qui ont refusé la course (ou
 * laissé expirer son offre) ; ils ne la recevront plus, leur retour ne
 * justifie rien pour elle. `null` si aucun retour n'est estimable.
 */
function retourEstimeMs(ctx: Contexte, exclus: ReadonlySet<string> = AUCUN_EXCLU): number | null {
  return retoursEstimes(ctx).find((x) => !exclus.has(x.id))?.ms ?? null;
}

/** Tous les retours estimés des livreurs en course (ni en pause, ni hors service), du plus proche au plus lointain. */
function retoursEstimes(ctx: Contexte): RetourLivreur[] {
  if (ctx.retours) return ctx.retours;
  const retours: RetourLivreur[] = [];
  for (const l of ctx.instantane.livreurs) {
    if (ctx.libres.has(l.id)) continue;
    if (estEnPause(l.etat, ctx.maintenant) || estEnPauseAuto(l.etat, ctx.maintenant)) continue;
    const sa = ctx.instantane.courses.find(
      (c) =>
        c.deliverer_id === l.id &&
        (c.statut === CourseStatut.ACCEPTED || c.statut === CourseStatut.AT_RESTAURANT || c.statut === CourseStatut.IN_DELIVERY),
    );
    if (!sa) continue;
    const retour = retourAuRestaurantMs(sa, l, ctx.restaurant, ctx.r, ctx.maintenant, etaMs(ctx, l.id));
    if (retour !== null) retours.push({ id: l.id, ms: retour });
  }
  retours.sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  ctx.retours = retours;
  return retours;
}

/** Délai dont Turbo peut attendre le retour d'un livreur interne (`course.turbo_attente_retour_max_min`). */
const attenteRetourMs = (ctx: Contexte) => (ctx.r.turboActif ? ctx.r.turboAttenteRetourMaxMin * 60_000 : 0);

/**
 * Premier retour estimé d'un livreur en course, s'il arrive avant que ces
 * commandes ne partent chez Turbo (plus ancienne prête + 6 min, plus
 * l'attente d'un retour : Turbo attend un livreur qui revient dans ce délai) ;
 * sinon `null` : Turbo les prendra (une course par commande), leur départ
 * interne n'est qu'une supposition.
 *
 * `exclus` : les livreurs qui ont refusé la course (`dejaSollicites`), comme
 * au moment de Turbo (`retourAttenduAvantTurbo`). Sinon le retour d'un
 * livreur qui a refusé la course justifiait d'y coller une commande neuve,
 * puis Turbo prenait le tout (relecture du 24/10). Une commande neuve, seule,
 * n'a été refusée par personne : aucun exclu.
 */
function retourAvantTurbo(ctx: Contexte, arrets: readonly Arret[], exclus: ReadonlySet<string> = AUCUN_EXCLU): number | null {
  const retour = retourEstimeMs(ctx, exclus);
  if (retour === null || arrets.length === 0) return retour;
  if (ctx.r.turboActif && retour > plusAnciennePrete(ctx, arrets) + ctx.r.turboApresMinV2 * 60_000 + attenteRetourMs(ctx)) return null;
  return retour;
}

/**
 * Turbo (3.11) : la course attend-elle le retour d'un livreur interne au lieu
 * de partir chez Turbo ? Oui si un livreur en course (pas encore retenu pour
 * une autre course, ne l'ayant pas refusée) revient au restaurant dans
 * `course.turbo_attente_retour_max_min`, que chaque commande arrive encore
 * avant sa promesse + le retard toléré en partant avec lui, et sans dépasser
 * la bascule + ce délai : au pire, Turbo est appelé ce délai plus tard.
 */
function retourAttenduAvantTurbo(
  ctx: Contexte,
  k: CourseTravail,
  d: DecisionTurbo,
  pris: ReadonlySet<string>,
): RetourLivreur | null {
  const attenteMin = ctx.r.turboAttenteRetourMaxMin;
  if (attenteMin <= 0 || d.minutes >= ctx.r.turboApresMinV2 + attenteMin) return null;
  for (const retour of retoursEstimes(ctx)) {
    if (pris.has(retour.id) || k.dejaSollicites.has(retour.id)) continue;
    if (retour.ms > ctx.t + attenteMin * 60_000) return null; // les suivants reviennent plus tard encore
    const est = estimer(ctx, k.arrets, retour.ms);
    const tiennent = k.arrets.every((a) => (est.arriveesMs.get(a.id) ?? retour.ms) <= a.limiteMs);
    return tiennent ? retour : null;
  }
  return null;
}

/**
 * Départ estimé d'une course. Sans livreur ni offre : le livreur libre le
 * plus proche qui ne l'a pas déjà refusée ; personne de libre : le premier
 * retour estimé d'un livreur en course, s'il précède la bascule vers Turbo
 * (le retard toléré joue alors aussi, 3.6). `null` = personne ne peut la
 * prendre avant Turbo, ou aucun retour n'est estimable.
 */
function departCourse(ctx: Contexte, k: CourseTravail, enPlus: readonly string[] = []): number | null {
  if (k.statut === CourseStatut.IN_DELIVERY || k.statut === CourseStatut.AT_RESTAURANT) return ctx.t;
  if (k.statut === CourseStatut.ACCEPTED) return ctx.t + etaMs(ctx, k.delivererId);
  if (k.offre) return ctx.t + etaMs(ctx, k.offre.deliverer_id);
  return departLibreMs(ctx, enPlus, k.dejaSollicites) ?? retourAvantTurbo(ctx, k.arrets, k.dejaSollicites);
}

/**
 * Course sans livreur ni offre qui attend un livreur : aucun livreur libre
 * (hors ceux qui l'ont déjà refusée) ne peut la prendre maintenant.
 */
function attendUnLivreur(ctx: Contexte, k: CourseTravail, enPlus: readonly string[] = []): boolean {
  return k.categorie === 3 && !k.offre && departLibreMs(ctx, enPlus, k.dejaSollicites) === null;
}

/**
 * Course (ou paire de courses d'une fusion) refusée, ou laissée expirer sans
 * signe de vie, par un livreur qui pourrait la prendre MAINTENANT : un
 * livreur libre, ou un livreur `enPlus` (sollicité par l'une des courses de
 * la fusion, qui recevrait la course fusionnée). Elle n'est la cible d'aucun
 * ajout ni d'aucune fusion : la commande ou la course neuve, elle, peut lui
 * être proposée tout de suite. Sinon la commande collée héritait des refus de
 * la course et n'était jamais proposée à ce livreur, qui l'attendait au
 * comptoir sans jamais l'avoir refusée ; Turbo la prenait.
 */
function refuseeParUnDisponible(ctx: Contexte, exclus: ReadonlySet<string>, enPlus: readonly string[] = []): boolean {
  for (const id of exclus) if (ctx.libres.has(id) || enPlus.includes(id)) return true;
  return false;
}

/** Course récupérée (catégorie 0) à moins de 90 s (ou d'une demi-fenêtre) de la fin de sa fenêtre : elle ne grossit plus. */
function finDeFenetreProche(ctx: Contexte, k: CourseTravail): boolean {
  return k.categorie === 0 && (k.fenetreFermeMs === null || k.fenetreFermeMs - ctx.t < margeRemiseApresRetraitMs(ctx.r));
}

const departOuDefaut = (ctx: Contexte, d: number | null) => d ?? ctx.t + ctx.r.etaParDefautMin * 60_000;

function plusAnciennePrete(ctx: Contexte, arrets: readonly Arret[]): number {
  const t = arrets.map((a) => a.readyMs).filter((x): x is number => x !== null);
  return t.length ? Math.min(...t) : ctx.t;
}

/** Remplace l'ordre des arrêts par celui de l'estimation. */
function reordonner(arrets: readonly Arret[], ordre: readonly string[]): Arret[] {
  const parId = new Map(arrets.map((a) => [a.id, a]));
  const res = ordre.map((id) => parId.get(id)).filter((a): a is Arret => !!a);
  for (const a of arrets) if (!res.includes(a)) res.push(a);
  return res;
}

/** Libère le livreur d'une offre close dans ce passage, s'il peut en recevoir une autre. */
function libererOffre(ctx: Contexte, offre: OffrePlanif | null): void {
  if (!offre) return;
  const l = ctx.livreurs.get(offre.deliverer_id);
  if (l && peutRecevoirOffre({ ...l.etat, offre_en_attente: false }, ctx.maintenant).ok) ctx.libres.add(l.id);
}

const LIBELLES_DEPART: Record<MotifDepart, string> = {
  DEJA_PARTI: 'déjà parti',
  AJOUT_COUPE: 'ajout après retrait coupé',
  ANCIENNE_APPLI: 'ancienne appli',
  SANS_RETRAIT: 'retrait non daté',
  LIVRAISON_DEMARREE: 'première livraison commencée',
  POSITION: 'sorti du restaurant',
  FENETRE_ECHUE: 'fenêtre d’ajout écoulée',
  REPLI_V1: 'retour à l’ancienne méthode',
};

const LIBELLES_LIBERATION: Record<MotifLiberation, string> = {
  TOUT_PRET: 'Tout est prêt',
  ECHEANCE: 'Attente terminée',
  PLUS_RIEN_A_ATTENDRE: 'Plus rien à attendre',
  PARTI: 'Livreur parti',
  REPLI_V1: 'Ancienne méthode',
};

/**
 * Le planificateur : un passage sur un restaurant. Voir l'en-tête du fichier
 * pour l'ordre des étapes et les règles.
 */
export function planifier(
  instantane: InstantanePlanification,
  reglages: ReglagesPlanification = REGLAGES_PLANIFICATION_DEFAUT,
  options: OptionsPlanification = {},
): PlanRestaurant {
  const ctx = creerContexte(instantane, reglages, options);
  const r = reglages;
  const { t, maintenant } = ctx;
  const actions: ActionPlanification[] = [];
  const refus: RefusPlanification[] = [];
  const parties = new Set<string>();

  // ── 1. Départs et détachements.
  const ouvertes: CourseTravail[] = [];
  const detachees: CommandePlanif[] = [];
  const detacherNonRemises = (k: CoursePlanif) => {
    for (const l of livraisonsActives(k.livraisons)) {
      if (!estAjoutNonRemis(l)) continue;
      actions.push({
        type: 'DETACHER',
        course_id: k.id,
        order_id: l.commande.id,
        reference: l.commande.reference,
        motif: 'LIVREUR_PARTI',
        libelle: `${l.commande.reference} pas remise : repart seule`,
      });
      detachees.push(l.commande);
    }
  };
  for (const k of instantane.courses) {
    if (estCourseVideSansLivreur(k)) {
      actions.push({
        type: 'ANNULER_COURSE_VIDE',
        course_id: k.id,
        offre: k.offre,
        libelle: 'Plus aucune commande à livrer',
      });
      // Son livreur sollicité est libéré : une autre course peut lui être proposée dans ce passage.
      libererOffre(ctx, k.offre);
      continue;
    }
    if (k.statut === CourseStatut.IN_DELIVERY) {
      // Déjà partie (bouton « Je pars », passage précédent) : une commande
      // ajoutée après le retrait et pas remise ne part pas avec le livreur.
      if (k.parti_at) {
        detacherNonRemises(k);
        continue;
      }
      const livreur = k.deliverer_id ? ctx.livreurs.get(k.deliverer_id) ?? null : null;
      const f = fenetreApresRetrait(k, livreur, ctx.restaurant, r, maintenant);
      if (!f.ouverte) {
        parties.add(k.id);
        actions.push({
          type: 'MARQUER_PARTI',
          course_id: k.id,
          deliverer_id: k.deliverer_id,
          motif: f.motif,
          libelle: `Parti : ${LIBELLES_DEPART[f.motif]}`,
        });
        detacherNonRemises(k);
        continue;
      }
      ouvertes.push(courseTravail(ctx, k, f.ferme_a.getTime()));
    } else if (
      k.statut === CourseStatut.PENDING_ASSIGNMENT ||
      k.statut === CourseStatut.ACCEPTED ||
      k.statut === CourseStatut.AT_RESTAURANT
    ) {
      ouvertes.push(courseTravail(ctx, k, null));
    }
  }

  // ── 2. Commandes prêtes sans course : ajout, sinon création.
  const dejaEnCourse = new Set(ouvertes.flatMap((k) => k.arrets.map((a) => a.id)));
  const vues = new Set<string>();
  const pretes = [
    ...instantane.commandes.filter(
      (c) => c.statut === OrderStatus.READY && c.delivery_service === DeliveryService.CHICKEN_NATION,
    ),
    ...detachees,
  ]
    .filter((c) => !dejaEnCourse.has(c.id) && !vues.has(c.id) && vues.add(c.id))
    .map((c) => arretDe(ctx, c))
    .sort((a, b) => (a.readyMs ?? t) - (b.readyMs ?? t) || (a.id < b.id ? -1 : 1));

  const restantes: Arret[] = [];
  for (const q of pretes) {
    const departSeul = departLibreMs(ctx) ?? retourAvantTurbo(ctx, [q]);
    let meilleur: { k: CourseTravail; res: Extract<ResultatAjout, { ok: true }>; cle: number[]; attendue: boolean } | null = null;
    for (const k of ouvertes) {
      if (k.categorie === null || k.absorbee) continue;
      if (finDeFenetreProche(ctx, k)) {
        refus.push({ essai: 'AJOUT', order_id: q.id, source_id: null, course_cle: k.cle, refus: 'FIN_DE_FENETRE', libelle: 'fenêtre d’ajout presque finie' });
        continue;
      }
      if (k.categorie === 3 && refuseeParUnDisponible(ctx, k.dejaSollicites)) {
        refus.push({ essai: 'AJOUT', order_id: q.id, source_id: null, course_cle: k.cle, refus: 'DEJA_REFUSEE', libelle: 'refusée par un livreur libre' });
        continue;
      }
      const attendue = !!k.source?.commandes_attendues.includes(q.id);
      const dk = departCourse(ctx, k);
      const depart = departOuDefaut(ctx, dk);
      const res = evaluerAjout(ctx, {
        existants: k.arrets,
        nouveaux: [q],
        departAvantMs: depart,
        departApresMs: depart,
        departSeulMs: departSeul,
        attente: { premierePreteMs: q.readyMs ?? t },
        departConnu: dk !== null,
        attendLivreur: attendUnLivreur(ctx, k) ? { retourMs: retourAvantTurbo(ctx, k.arrets, k.dejaSollicites) } : null,
      });
      if (!res.ok) {
        refus.push({ essai: 'AJOUT', order_id: q.id, source_id: null, course_cle: k.cle, refus: res.refus, libelle: res.libelle });
        continue;
      }
      const cle = [attendue ? 0 : 1, k.categorie, k.categorie === 2 ? depart : 0, res.detourS];
      if (!meilleur || comparerCles(cle, meilleur.cle) < 0) meilleur = { k, res, cle, attendue };
    }
    if (!meilleur) {
      restantes.push(q);
      continue;
    }
    const { k, res, attendue } = meilleur;
    k.arrets = reordonner([...k.arrets, q], res.estimation.ordre);
    k.modifiee = true;
    actions.push({
      type: 'AJOUTER',
      course_id: k.id!,
      order_id: q.id,
      reference: q.reference,
      statut_course: k.statut,
      deliverer_id: k.delivererId,
      apres_retrait: k.categorie === 0,
      attendue,
      offre: k.offre,
      motif: res.motif,
      libelle: `Ajoutée à ${k.reference}${res.libelle ? ` : ${res.libelle}` : ''}`,
      detour_s: Math.round(res.detourS),
    });
  }

  // Regroupement glouton des restantes, graine la plus ancienne.
  const nouvelles: CourseTravail[] = [];
  while (restantes.length) {
    const graine = restantes.shift()!;
    const cle = `nouvelle-${nouvelles.length + 1}`;
    const departLibre = departLibreMs(ctx);
    const retour = departLibre === null ? retourAvantTurbo(ctx, [graine]) : null;
    const departEstime = departLibre ?? retour;
    const depart = departOuDefaut(ctx, departEstime);
    let arrets: Arret[] = [graine];
    let derniere: Extract<ResultatAjout, { ok: true }> | null = null;
    for (let i = 0; i < restantes.length && arrets.length < r.maxCommandesParCourse; ) {
      const res = evaluerAjout(ctx, {
        existants: arrets,
        nouveaux: [restantes[i]],
        departAvantMs: depart,
        departApresMs: depart,
        departSeulMs: departEstime === null ? null : depart,
        attente: null,
        departConnu: departEstime !== null,
        attendLivreur: departLibre === null ? { retourMs: retour } : null,
      });
      if (res.ok) {
        arrets = reordonner([...arrets, restantes[i]], res.estimation.ordre);
        derniere = res;
        restantes.splice(i, 1);
      } else {
        refus.push({ essai: 'CREATION', order_id: restantes[i].id, source_id: null, course_cle: cle, refus: res.refus, libelle: res.libelle });
        i++;
      }
    }
    const k: CourseTravail = {
      cle,
      id: null,
      reference: cle,
      source: null,
      statut: CourseStatut.PENDING_ASSIGNMENT,
      delivererId: null,
      arrets,
      offre: null,
      categorie: 3,
      fenetreFermeMs: null,
      modifiee: true,
      absorbee: false,
      nouvelle: true,
      dejaSollicites: new Set(),
    };
    nouvelles.push(k);
    actions.push({
      type: 'CREER_COURSE',
      cle,
      order_ids: arrets.map((a) => a.id),
      sequence: arrets.map((a) => a.id),
      motif: derniere?.motif ?? null,
      libelle: arrets.length > 1 && derniere ? `${arrets.length} commandes : ${derniere.libelle}` : 'Commande seule',
    });
  }

  // ── 3. Fusions des courses sans livreur (demande 4).
  const sansLivreur = () =>
    ouvertes
      .filter((k) => k.categorie === 3 && !k.absorbee && k.arrets.length > 0)
      .sort((a, b) => plusAnciennePrete(ctx, a.arrets) - plusAnciennePrete(ctx, b.arrets) || (a.cle < b.cle ? -1 : 1));

  const fusionner = (cible: CourseTravail, absorbee: CourseTravail, res: Extract<ResultatAjout, { ok: true }>) => {
    const deplacees = absorbee.arrets.map((a) => a.id);
    cible.arrets = reordonner([...cible.arrets, ...absorbee.arrets], res.estimation.ordre);
    cible.modifiee = true;
    absorbee.absorbee = true;
    absorbee.arrets = [];
    const aClore = absorbee.offre ? [absorbee.offre] : [];
    actions.push({
      type: 'FUSIONNER',
      cible_id: cible.id!,
      absorbee_id: absorbee.id!,
      order_ids: deplacees,
      statut_cible: cible.statut,
      deliverer_id: cible.delivererId,
      offre_cible: cible.offre,
      offres_a_clore: aClore,
      apres_retrait: cible.categorie === 0,
      motif: res.motif,
      libelle: `${absorbee.reference} fusionnée dans ${cible.reference}${res.libelle ? ` : ${res.libelle}` : ''}`,
      detour_s: Math.round(res.detourS),
    });
    absorbee.offre = null;
    libererOffre(ctx, aClore[0] ?? null);
  };

  let tours = 0;
  let change = true;
  while (change && tours++ < 20) {
    change = false;
    for (const u of sansLivreur()) {
      if (u.absorbee) continue;
      const departU = departCourse(ctx, u);
      const premiere = plusAnciennePrete(ctx, u.arrets);

      // (a) Vers une course qui a déjà son livreur. Jamais une course dont
      // l'offre a été forcée par l'administrateur (son geste n'est pas défait).
      let meilleureA: { k: CourseTravail; res: Extract<ResultatAjout, { ok: true }>; cle: number[] } | null = null;
      for (const k of u.offre?.forcee ? [] : ouvertes) {
        if (k === u || k.absorbee || k.categorie === null || k.categorie === 3) continue;
        if (finDeFenetreProche(ctx, k)) {
          refus.push({ essai: 'FUSION', order_id: null, source_id: u.cle, course_cle: k.cle, refus: 'FIN_DE_FENETRE', libelle: 'fenêtre d’ajout presque finie' });
          continue;
        }
        // Son livreur a refusé cette course : ses commandes ne lui reviennent pas par une fusion.
        if (k.delivererId && u.dejaSollicites.has(k.delivererId)) {
          refus.push({ essai: 'FUSION', order_id: null, source_id: u.cle, course_cle: k.cle, refus: 'DEJA_REFUSEE', libelle: 'refusée par le livreur de la course' });
          continue;
        }
        const depart = departOuDefaut(ctx, departCourse(ctx, k));
        // Offre en attente sur la course absorbée (livreur au comptoir, par
        // exemple) : elle n'est pas reprise pour attendre un livreur qui
        // partira plus tard. Seules les fusions qui ne retardent rien restent.
        if (u.offre && departU !== null && depart > departU) {
          refus.push({ essai: 'FUSION', order_id: null, source_id: u.cle, course_cle: k.cle, refus: 'OFFRE_EN_COURS', libelle: 'partirait plus tôt avec le livreur sollicité' });
          continue;
        }
        const res = evaluerAjout(ctx, {
          existants: k.arrets,
          nouveaux: u.arrets,
          departAvantMs: depart,
          departApresMs: depart,
          departSeulMs: departU,
          attente: { premierePreteMs: premiere },
          departConnu: true,
        });
        if (!res.ok) {
          refus.push({ essai: 'FUSION', order_id: null, source_id: u.cle, course_cle: k.cle, refus: res.refus, libelle: res.libelle });
          continue;
        }
        const cle = [k.categorie, k.categorie === 2 ? depart : 0, res.detourS];
        if (!meilleureA || comparerCles(cle, meilleureA.cle) < 0) meilleureA = { k, res, cle };
      }
      if (meilleureA) {
        fusionner(meilleureA.k, u, meilleureA.res);
        change = true;
        continue;
      }

      // (b) Avec une autre course sans livreur : la cible part le plus tôt,
      // garde son offre à égalité, la plus ancienne sinon.
      let meilleureB: { cible: CourseTravail; absorbee: CourseTravail; res: Extract<ResultatAjout, { ok: true }>; cle: number[] } | null = null;
      for (const v of sansLivreur()) {
        if (v === u || v.absorbee) continue;
        for (const [cible, absorbee] of [
          [u, v],
          [v, u],
        ] as const) {
          // Offre forcée par l'administrateur : la course n'est jamais absorbée.
          if (absorbee.offre?.forcee) continue;
          // Le livreur sollicité par la course absorbée sera libre pour la cible.
          const enPlus = absorbee.offre ? [absorbee.offre.deliverer_id] : [];
          // Refusée (l'une ou l'autre) par un livreur qui pourrait prendre la
          // course fusionnée maintenant : pas de fusion, ses commandes ne lui
          // reviennent pas et l'autre course lui reste proposable seule.
          const refusants = new Set([...cible.dejaSollicites, ...absorbee.dejaSollicites]);
          const preneurs = [...enPlus, ...(cible.offre ? [cible.offre.deliverer_id] : [])];
          if (refuseeParUnDisponible(ctx, refusants, preneurs)) {
            refus.push({ essai: 'FUSION', order_id: null, source_id: absorbee.cle, course_cle: cible.cle, refus: 'DEJA_REFUSEE', libelle: 'refusée par un livreur libre' });
            continue;
          }
          const departCible = departCourse(ctx, cible, enPlus);
          const departAvant = departOuDefaut(ctx, departCourse(ctx, cible));
          const res = evaluerAjout(ctx, {
            existants: cible.arrets,
            nouveaux: absorbee.arrets,
            departAvantMs: departAvant,
            departApresMs: departOuDefaut(ctx, departCible),
            departSeulMs: departCourse(ctx, absorbee),
            attente: { premierePreteMs: plusAnciennePrete(ctx, absorbee.arrets) },
            departConnu: departCible !== null,
            // Retour d'un livreur qui a refusé l'une des deux : il ne justifie pas la fusion.
            attendLivreur: attendUnLivreur(ctx, cible, enPlus)
              ? { retourMs: retourAvantTurbo(ctx, cible.arrets, refusants) }
              : null,
          });
          if (!res.ok) {
            refus.push({ essai: 'FUSION', order_id: null, source_id: absorbee.cle, course_cle: cible.cle, refus: res.refus, libelle: res.libelle });
            continue;
          }
          const cle = [
            departCible ?? Number.POSITIVE_INFINITY,
            cible.offre ? 0 : 1,
            cible === u ? 0 : 1,
            res.detourS,
          ];
          if (!meilleureB || comparerCles(cle, meilleureB.cle) < 0) meilleureB = { cible, absorbee, res, cle };
        }
      }
      if (meilleureB) {
        fusionner(meilleureB.cible, meilleureB.absorbee, meilleureB.res);
        change = true;
      }
    }
  }

  // ── 4. Ordre des arrêts des courses existantes modifiées : celui de la
  // dernière estimation acceptée (ajout ou fusion), qui a passé les limites.
  // Le recalculer ici pouvait donner un autre ordre (il dépend des promesses
  // et du départ) que les limites n'avaient pas vu.
  for (const k of ouvertes) {
    if (!k.modifiee || k.absorbee || !k.id) continue;
    actions.push({ type: 'ORDONNER', course_id: k.id, sequence: k.arrets.map((a) => a.id) });
  }

  // ── 5. Offres, par urgence croissante, au meilleur livreur libre.
  const aOffrir = [...ouvertes, ...nouvelles]
    .filter((k) => k.categorie === 3 && !k.absorbee && !k.offre && k.arrets.length > 0)
    .map((k) => ({ k, marge: margeMs(ctx, k.arrets), premiere: plusAnciennePrete(ctx, k.arrets) }))
    .sort((a, b) => a.marge - b.marge || a.premiere - b.premiere || (a.k.cle < b.k.cle ? -1 : 1));
  for (const { k, marge } of aOffrir) {
    const candidats = [...ctx.libres].filter((id) => !k.dejaSollicites.has(id)).map((id) => ctx.livreurs.get(id)!);
    if (candidats.length === 0) continue;
    const [premier] = classerLivreurs(candidats, instantane.livreurs, ctx.etas, maintenant);
    ctx.libres.delete(premier.deliverer_id);
    k.offre = { id: '', deliverer_id: premier.deliverer_id, expires_at: maintenant }; // offerte dans ce passage
    actions.push({
      type: 'OFFRIR',
      course_cle: k.cle,
      course_id: k.id,
      deliverer_id: premier.deliverer_id,
      marge_s: Math.round(marge / 1000),
      cout: premier,
      libelle: premier.au_comptoir
        ? 'Proposée au livreur au restaurant'
        : `Proposée au livreur à ${minutesTexte(premier.eta_s * 1000)}`,
    });
  }

  // ── 5 bis. Zéro temps mort : une offre en attente vise un livreur loin du
  // restaurant alors qu'un livreur libre y serait plus de 5 min plus tôt (2 min
  // s'il est au comptoir). L'offre est reprise sans pénalité et la course
  // proposée au livreur libre. Jamais une offre forcée par l'administrateur.
  for (const k of ouvertes) {
    if (k.categorie !== 3 || k.absorbee || !k.offre || !k.offre.id || k.arrets.length === 0) continue; // offre de ce passage : id vide
    if (k.offre.forcee) continue;
    const vise = k.offre;
    // Offre échue pas encore traitée : son expiration (avec sa pénalité)
    // passe d'abord, puis la course est proposée au suivant.
    if (vise.expires_at.getTime() <= t) continue;
    const etaVise = ctx.etas.get(vise.deliverer_id);
    if (!etaVise) continue;
    const candidats = [...ctx.libres]
      .filter((id) => id !== vise.deliverer_id && !k.dejaSollicites.has(id))
      .map((id) => ctx.livreurs.get(id)!);
    if (candidats.length === 0) continue;
    const [premier] = classerLivreurs(candidats, instantane.livreurs, ctx.etas, maintenant);
    // Position du livreur sollicité inconnue ou périmée : on ne sait pas qu'il
    // est loin. Sauf face à un livreur AU COMPTOIR (temps 0, sûr) : le temps
    // par défaut du livreur sollicité, celui qui l'a fait choisir, sert alors
    // (relecture du 24/10 : la course restait au livreur sans position).
    if (etaVise.source === 'DEFAUT' && !premier.au_comptoir) continue;
    const gainMs = etaMs(ctx, vise.deliverer_id) - premier.eta_s * 1000;
    const seuilS = premier.au_comptoir ? ECART_REPRISE_OFFRE_COMPTOIR_S : ECART_REPRISE_OFFRE_S;
    if (gainMs <= seuilS * 1000) continue;
    ctx.libres.delete(premier.deliverer_id);
    actions.push({
      type: 'REPRENDRE_OFFRE',
      course_id: k.id!,
      offre: vise,
      pour_deliverer_id: premier.deliverer_id,
      libelle: `Reprise : un livreur arrive ${minutesTexte(gainMs)} plus tôt`,
    });
    k.offre = { id: '', deliverer_id: premier.deliverer_id, expires_at: maintenant };
    actions.push({
      type: 'OFFRIR',
      course_cle: k.cle,
      course_id: k.id,
      deliverer_id: premier.deliverer_id,
      marge_s: Math.round(margeMs(ctx, k.arrets) / 1000),
      cout: premier,
      libelle: premier.au_comptoir
        ? 'Proposée au livreur au restaurant'
        : `Proposée au livreur à ${minutesTexte(premier.eta_s * 1000)}`,
    });
  }

  // ── 6. Retenues au comptoir.
  const retenues = new Set<string>();
  const reservees = new Set<string>();
  const enPreparation = instantane.commandes.filter(
    (c) =>
      c.statut === OrderStatus.IN_PROGRESS &&
      c.delivery_service === DeliveryService.CHICKEN_NATION &&
      !!c.preparation,
  );
  const aRetenir = ouvertes
    .filter((k) => !k.absorbee && k.categorie !== null && k.categorie <= 2 && !!k.delivererId)
    .sort((a, b) => {
      const ra = a.source?.retenue_jusqua && a.source.retenue_jusqua.getTime() > t ? 0 : 1;
      const rb = b.source?.retenue_jusqua && b.source.retenue_jusqua.getTime() > t ? 0 : 1;
      return ra - rb || a.categorie! - b.categorie! || departOuDefaut(ctx, departCourse(ctx, a)) - departOuDefaut(ctx, departCourse(ctx, b));
    });

  const trajetLongActif = r.attenteMaxTrajetLongS > 0;
  for (const k of aRetenir) {
    const T = k.source?.retenue_jusqua?.getTime() ?? null;
    if (T !== null && T <= t) continue; // terminée : jamais reposée
    if (k.arrets.length === 0) continue;
    const dPossible = departOuDefaut(ctx, departCourse(ctx, k));
    // Une retenue posée ne peut que diminuer. Après le retrait, elle n'est
    // plus bornée par la fenêtre d'ajout : la fenêtre court depuis sa fin
    // (essai du 25/10 : la remise au code la ramenait à remise + 150 s).
    let plafond = Number.POSITIVE_INFINITY;
    if (T !== null) plafond = Math.min(plafond, T);
    /** Aucune commande prête de la course n'attend plus de `s` secondes depuis `ready_at`. */
    const attenteAuPlus = (s: number) => Math.min(plafond, ...k.arrets.map((a) => (a.readyMs ?? t) + s * 1000));
    // Attente courte (règle d'avant) : 5 min ; trajet long : 20 min.
    const limiteCourte = attenteAuPlus(r.attenteMaxCommandePreteS);
    const limiteLongue = trajetLongActif ? attenteAuPlus(r.attenteMaxTrajetLongS) : Number.NEGATIVE_INFINITY;
    const limite = Math.max(limiteCourte, limiteLongue);
    if (limite <= t || dPossible >= limite) continue;

    const attenduesAvant = new Set(k.source?.commandes_attendues ?? []);
    const candidates = enPreparation
      .filter((c) => !reservees.has(c.id))
      .sort(
        (a, b) =>
          Number(!attenduesAvant.has(a.id)) - Number(!attenduesAvant.has(b.id)) ||
          a.preparation!.finDecision.getTime() - b.preparation!.finDecision.getTime(),
      );
    const choisies: { c: CommandePlanif; arret: Arret; fin: number; motif: MotifRetenue }[] = [];
    // Retour au restaurant du livreur s'il partait sans la commande examinée :
    // départ au plus tôt avec la course et les commandes déjà attendues
    // (après la dernière d'entre elles), tournée, retour. Calculé au besoin,
    // une fois par état des commandes attendues.
    const mesure: { allerRetourSeulMs: number | null; retour: { attendues: number; ms: number } | null } = {
      allerRetourSeulMs: null,
      retour: null,
    };
    const retourSansAttendre = (): number => {
      mesure.allerRetourSeulMs ??= allerRetourMs(ctx, k.arrets, dPossible);
      if (!mesure.retour || mesure.retour.attendues !== choisies.length) {
        const depart = Math.max(dPossible, ...choisies.map((x) => x.fin));
        const ar =
          choisies.length === 0
            ? mesure.allerRetourSeulMs
            : allerRetourMs(ctx, [...k.arrets, ...choisies.map((x) => x.arret)], depart);
        mesure.retour = { attendues: choisies.length, ms: depart + ar };
      }
      return mesure.retour.ms;
    };
    for (const c of candidates) {
      // Fin estimée de la commande (8e décile). `fin` peut ensuite être ramenée
      // à l'échéance d'une retenue déjà posée ; elle, jamais.
      const finEstimee = c.preparation!.finDecision.getTime();
      let fin = finEstimee;
      const noter = (motif: MotifRefusPlanification, libelle: string) =>
        refus.push({ essai: 'RETENUE', order_id: c.id, source_id: null, course_cle: k.cle, refus: motif, libelle });
      const courte = (f: number) => f - t <= r.horizonPreparationS * 1000 && f <= limiteCourte;
      let motif: MotifRetenue = 'ATTENTE_COURTE';
      if (!courte(fin)) {
        // Trajet long (demande du 24/10) : partir sans elle ferait revenir le
        // livreur plus d'un petit retard après qu'elle est prête. La course
        // l'attend jusqu'à sa fin estimée, au-delà de l'horizon et de
        // l'attente courte, sans qu'une commande prête attende plus de
        // `attenteMaxTrajetLongS`. Sinon (il reviendrait à temps, à un petit
        // retard près), la règle d'avant, inchangée.
        const trajetLong = trajetLongActif && retourSansAttendre() > fin + r.petitRetardRetourMin * 60_000;
        if (!trajetLong) {
          if (fin - t > r.horizonPreparationS * 1000) {
            noter('HORIZON', `${c.reference} prête dans plus de ${minutesTexte(r.horizonPreparationS * 1000)}`);
          } else {
            noter('LIMITE_RETENUE', `${c.reference} prête trop tard`);
          }
          continue;
        }
        if (fin > limiteLongue) {
          // Déjà attendue, son estimation a reculé : la retenue n'est jamais
          // prolongée, elle garde son échéance ; à l'échéance, la course part.
          if (!attenduesAvant.has(c.id)) {
            noter('LIMITE_RETENUE', `${c.reference} prête trop tard, même pour un trajet long`);
            continue;
          }
          fin = limiteLongue;
        }
        motif = courte(fin) ? 'ATTENTE_COURTE' : 'TRAJET_LONG';
      }
      if (fin <= dPossible) continue; // prête avant le départ possible : rien à attendre
      // Un autre livreur la prendrait seule à temps : jugé à sa fin estimée,
      // jamais à l'échéance d'une retenue qu'elle dépasse (relecture du 24/10 :
      // annoncée plus tard, elle partait avec un livreur revenu entre-temps et
      // la course l'avait attendue pour rien).
      if (!r.retenueMemeSiLivreurLibre && autreLivreurATemps(ctx, k, finEstimee)) {
        noter('AUTRE_LIVREUR_LIBRE', `un autre livreur peut prendre ${c.reference}`);
        continue;
      }
      const arret = arretDe(ctx, c);
      const departApres = Math.max(dPossible, fin, ...choisies.map((x) => x.fin));
      const alternative = r.retenueMemeSiLivreurLibre ? departLibreMs(ctx) : null;
      const res = evaluerAjout(ctx, {
        existants: k.arrets,
        nouveaux: [...choisies.map((x) => x.arret), arret],
        departAvantMs: dPossible,
        departApresMs: departApres,
        departSeulMs: alternative === null ? null : Math.max(alternative, fin),
        attente: null,
        departConnu: true,
      });
      if (!res.ok) {
        noter(res.refus, res.libelle);
        continue;
      }
      choisies.push({ c, arret, fin, motif });
    }
    if (choisies.length === 0) continue;

    const jusqua = Math.min(limite, Math.max(...choisies.map((x) => x.fin)));
    for (const x of choisies) reservees.add(x.c.id);
    retenues.add(k.id!);
    const attendues: CommandeAttendue[] = choisies.map((x) => ({
      order_id: x.c.id,
      reference: x.c.reference,
      prete_vers: x.c.preparation!.finMediane,
      prete_au_plus_tard: x.c.preparation!.finDecision,
      motif: x.motif,
    }));
    const memes =
      T === jusqua &&
      attenduesAvant.size === attendues.length &&
      attendues.every((a) => attenduesAvant.has(a.order_id));
    if (memes) continue;
    const motif: MotifRetenue = attendues.some((a) => a.motif === 'TRAJET_LONG') ? 'TRAJET_LONG' : 'ATTENTE_COURTE';
    const liste = attendues.map((a) => `${a.reference} (prête vers ${heureLisible(a.prete_vers, maintenant)})`).join(', ');
    const depart = `départ au plus tard ${heureLisible(new Date(jusqua), maintenant)}`;
    actions.push({
      type: 'RETENIR',
      course_id: k.id!,
      deliverer_id: k.delivererId,
      jusqua: new Date(jusqua),
      attendues,
      motif,
      aller_retour_s: mesure.allerRetourSeulMs === null ? null : Math.round(mesure.allerRetourSeulMs / 1000),
      libelle: motif === 'TRAJET_LONG' ? `Trajet long : attendre ${liste}, ${depart}` : `Attendre ${liste}, ${depart}`,
    });
  }

  // Retenues à lever : toute course retenue (ou qui attend encore) qui ne l'est plus.
  const parId = new Map(ouvertes.filter((k) => k.id).map((k) => [k.id!, k]));
  for (const k of instantane.courses) {
    const T = k.retenue_jusqua?.getTime() ?? null;
    if (T === null || retenues.has(k.id)) continue;
    if (T <= t && k.commandes_attendues.length === 0) continue; // déjà levée
    const travail = parId.get(k.id);
    const toutEstLa =
      !!travail &&
      k.commandes_attendues.length > 0 &&
      k.commandes_attendues.every((id) => travail.arrets.some((a) => a.id === id));
    let motif: MotifLiberation;
    if (parties.has(k.id)) motif = 'PARTI';
    else if (toutEstLa) motif = 'TOUT_PRET';
    else if (T <= t) motif = 'ECHEANCE';
    else motif = 'PLUS_RIEN_A_ATTENDRE';
    actions.push({
      type: 'LIBERER',
      course_id: k.id,
      deliverer_id: k.deliverer_id,
      motif,
      jusqua: new Date(Math.min(t, T)),
      libelle: LIBELLES_LIBERATION[motif],
    });
  }

  // ── 7. Turbo, dernier recours : la plus urgente d'abord ; une course attend
  // le retour d'un livreur interne s'il revient très bientôt (un livreur par
  // course).
  const aConfier = ouvertes
    .filter((k) => k.categorie === 3 && !k.absorbee && !k.nouvelle && !k.offre && !!k.source)
    .map((k) => ({ k, d: decisionTurboV2({ ...k.source!, offre: null }, r, maintenant) }))
    .filter(({ d }) => d.basculer)
    .map((x) => ({ ...x, marge: margeMs(ctx, x.k.arrets) }))
    .sort((a, b) => a.marge - b.marge || (a.k.cle < b.k.cle ? -1 : a.k.cle > b.k.cle ? 1 : 0));
  const retoursPris = new Set<string>();
  for (const { k, d } of aConfier) {
    const retour = retourAttenduAvantTurbo(ctx, k, d, retoursPris);
    if (retour) {
      retoursPris.add(retour.id);
      refus.push({
        essai: 'TURBO',
        order_id: null,
        source_id: null,
        course_cle: k.cle,
        refus: 'RETOUR_ATTENDU',
        libelle: `livreur de retour à ${heureLisible(new Date(retour.ms), maintenant)}`,
      });
      continue;
    }
    actions.push({
      type: 'CONFIER_TURBO',
      course_id: k.id!,
      minutes: Math.floor(d.minutes),
      libelle: `Aucun livreur depuis ${Math.floor(d.minutes)} min : confiée à Turbo`,
    });
  }

  return { restaurant_id: instantane.restaurant.id, maintenant, actions, refus };
}

/** Ordre lexicographique de deux clés de préférence (l'infini est égal à lui-même). */
function comparerCles(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Marge d'une course (3.10) : plus petite (promesse − arrivée estimée, départ immédiat). */
function margeMs(ctx: Contexte, arrets: readonly Arret[]): number {
  const est = estimer(ctx, arrets, ctx.t);
  return Math.min(...arrets.map((a) => a.promesseMs - (est.arriveesMs.get(a.id) ?? ctx.t)));
}

/**
 * « Aucun autre livreur libre ne peut prendre q seul à temps » (3.5) : un
 * autre livreur libre au restaurant au plus tard 3 min après la fin estimée
 * de q, ou un livreur en course attendu de retour avant. Les livreurs en
 * pause, hors service, ou sollicités ailleurs ne comptent pas.
 */
function autreLivreurATemps(ctx: Contexte, k: CourseTravail, finMs: number): boolean {
  const limite = finMs + MARGE_AUTRE_LIVREUR_S * 1000;
  for (const id of ctx.libres) {
    if (id === k.delivererId) continue;
    if (ctx.t + etaMs(ctx, id) <= limite) return true;
  }
  for (const l of ctx.instantane.livreurs) {
    if (l.id === k.delivererId || ctx.libres.has(l.id)) continue;
    if (estEnPause(l.etat, ctx.maintenant) || estEnPauseAuto(l.etat, ctx.maintenant)) continue;
    const sa = ctx.instantane.courses.find(
      (c) =>
        c.deliverer_id === l.id &&
        (c.statut === CourseStatut.ACCEPTED || c.statut === CourseStatut.AT_RESTAURANT || c.statut === CourseStatut.IN_DELIVERY),
    );
    if (!sa) continue;
    const retour = retourAuRestaurantMs(sa, l, ctx.restaurant, ctx.r, ctx.maintenant, etaMs(ctx, l.id));
    if (retour !== null && retour <= limite) return true;
  }
  return false;
}

/**
 * Retour estimé d'un livreur en course au restaurant, sans Google : arrêts
 * restants à vol d'oiseau × 1,4, 3 min par arrêt, puis le retour. Depuis sa
 * position fraîche s'il est parti, sinon depuis le restaurant à son départ
 * (au plus tôt, ou à son arrivée s'il est en route, jamais avant l'échéance
 * de sa retenue au comptoir). Un trajet vers ou
 * depuis un client sans coordonnées dure `trajetSansCoordonneesMin` : le
 * livreur qui le livre n'est jamais réputé déjà revenu. `null` sans
 * coordonnées du restaurant.
 */
export function retourAuRestaurantMs(
  course: CoursePlanif,
  livreur: Pick<LivreurPlanif, 'position' | 'position_at'>,
  restaurant: ILatLng | null,
  r: ReglagesPlanification,
  maintenant: Date,
  etaVersRestaurantMs = r.etaParDefautMin * 60_000,
): number | null {
  if (!restaurant) return null;
  const t = maintenant.getTime();
  const restants = livraisonsActives(course.livraisons);
  const parti =
    course.statut === CourseStatut.IN_DELIVERY &&
    (!!course.parti_at || course.livraisons.some((l) => l.statut !== DeliveryStatut.PENDING && l.statut !== DeliveryStatut.CANCELLED));
  const fraiche =
    !!livreur.position && !!livreur.position_at && t - livreur.position_at.getTime() <= r.positionExpirationMin * 60_000;

  // `null` : dernier point inconnu (client sans coordonnées).
  let point: ILatLng | null;
  let debut: number;
  if (parti && fraiche) {
    point = livreur.position!;
    debut = t;
  } else if (parti) {
    point = restaurant;
    debut = (course.parti_at ?? course.picked_up_at ?? maintenant).getTime();
  } else {
    point = restaurant;
    debut = course.statut === CourseStatut.ACCEPTED ? t + etaVersRestaurantMs : t;
    // Course retenue au comptoir : le livreur part à l'échéance de la retenue.
    // Jusqu'à 20 min pour un trajet long (relecture du 24/10) : compté depuis
    // maintenant, son retour paraissait bien plus proche, au point de refuser
    // une retenue à une autre course pour un livreur qui ne serait pas là.
    const retenue = course.retenue_jusqua?.getTime() ?? null;
    if (retenue !== null && retenue > debut) debut = retenue;
  }
  const mps = vitesseKmh(new Date(debut), r) / 3.6;
  const trajetInconnuS = r.trajetSansCoordonneesMin * 60;
  const trajetS = (a: ILatLng | null, b: ILatLng | null) =>
    a && b ? (haversineMeters(a, b) * FACTEUR_ROUTE_VOL_OISEAU) / mps : trajetInconnuS;
  let duree = 0;
  for (const l of restants) {
    const p = l.commande.client.position;
    duree += trajetS(point, p) + ARRET_CLIENT_S;
    point = p;
  }
  duree += trajetS(point, restaurant);
  return Math.max(t, debut + duree * 1000);
}

/**
 * Retour au planificateur v1 en pleine activité (conception 5.5) : les
 * courses récupérées encore au restaurant sont réputées parties, leurs
 * commandes ajoutées après le retrait et pas encore remises sont détachées
 * (l'ancien regroupement les reprend) ; les retenues sont levées.
 */
export function actionsRepliV1(instantane: InstantanePlanification): ActionPlanification[] {
  const actions: ActionPlanification[] = [];
  const t = instantane.maintenant.getTime();
  for (const k of instantane.courses) {
    if (k.statut === CourseStatut.IN_DELIVERY) {
      if (!k.parti_at) {
        actions.push({
          type: 'MARQUER_PARTI',
          course_id: k.id,
          deliverer_id: k.deliverer_id,
          motif: 'REPLI_V1',
          libelle: `Parti : ${LIBELLES_DEPART.REPLI_V1}`,
        });
      }
      for (const l of livraisonsActives(k.livraisons)) {
        if (estAjoutNonRemis(l)) {
          actions.push({
            type: 'DETACHER',
            course_id: k.id,
            order_id: l.commande.id,
            reference: l.commande.reference,
            motif: 'REPLI_V1',
            libelle: `${l.commande.reference} pas remise : repart seule`,
          });
        }
      }
    }
  }
  for (const k of instantane.courses) {
    const T = k.retenue_jusqua?.getTime() ?? null;
    if (T === null || (T <= t && k.commandes_attendues.length === 0)) continue;
    actions.push({
      type: 'LIBERER',
      course_id: k.id,
      deliverer_id: k.deliverer_id,
      motif: 'REPLI_V1',
      jusqua: new Date(Math.min(t, T)),
      libelle: LIBELLES_LIBERATION.REPLI_V1,
    });
  }
  return actions;
}
