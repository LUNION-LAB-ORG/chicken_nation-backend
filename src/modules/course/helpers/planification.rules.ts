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
 *    ajoutée automatiquement dès qu'elle est prête ;
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
 *  1. DÉPARTS : une course récupérée dont le livreur est parti (position,
 *     première livraison commencée, fenêtre écoulée, ancienne appli) est
 *     marquée partie ; une commande ajoutée après le retrait mais pas encore
 *     remise en est DÉTACHÉE et repart dans ce même passage.
 *  2. COMMANDES PRÊTES sans course, de la plus ancienne à la plus récente :
 *     AJOUTÉE à la meilleure course ouverte compatible (celle qui l'attendait
 *     d'abord ; puis livreur encore au restaurant après le retrait, au
 *     comptoir, en route, puis course sans livreur ; à égalité le plus petit
 *     détour), sinon regroupement glouton des restantes et CRÉATION de course.
 *  3. FUSIONS (demande 4) : une course sans livreur rejoint une course ouverte
 *     avec livreur, ou une autre course sans livreur, de la même direction et
 *     dans les limites ; l'offre en attente de la course absorbée est close
 *     sans pénalité.
 *  4. ORDRE des arrêts de chaque course modifiée.
 *  5. OFFRES : les courses sans livreur et sans offre sont proposées par
 *     urgence croissante, chacune au meilleur livreur libre (au comptoir
 *     d'abord, puis en minutes, 4.2).
 *  6. RETENUES au comptoir (3.5) : posées, réduites ou levées. Une retenue ne
 *     peut que diminuer ; levée, elle ne revient jamais sur la même course.
 *  7. TURBO (3.11) : dernier recours, compté depuis la plus ancienne commande
 *     prête de la course (6 min sous v2), jamais pendant une offre en attente.
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

// ─── Réglages ────────────────────────────────────────────────────────────────

export interface ReglagesPlanification {
  /** `course.attente_max_commande_prete_s` : jamais de retenue au-delà de `ready_at` + ce délai. */
  attenteMaxCommandePreteS: number;
  /** `course.horizon_preparation_s` : on n'attend pas une commande prête dans plus de ce délai. */
  horizonPreparationS: number;
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
 * de retenue, horizon 0 = jamais d'attente d'une commande en préparation,
 * fenêtre 0 = jamais d'ajout après le retrait, retard ou détour 0 = aucun
 * toléré, Turbo 0 = dès qu'aucun livreur n'est libre. Une valeur hors bornes
 * ou illisible est remplacée par le défaut et SIGNALÉE.
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
  /** Livreurs ayant refusé ou laissé expirer une offre de CETTE course (pas les offres closes sans pénalité). */
  deja_sollicites: string[];
  livraisons: LivraisonPlanif[];
}

/** Un livreur actif du restaurant. */
export interface LivreurPlanif {
  id: string;
  /** État pour la règle unique `peutRecevoirOffre` (en_course et offre_en_attente compris). */
  etat: EtatLivreur;
  position: ILatLng | null;
  position_at: Date | null;
  /** En-tête `x-deli-protocole` : 3 = appli qui sait recevoir un ajout après le retrait. */
  protocole_appli: number | null;
  queue_penalty_until?: Date | null;
  queue_penalty_positions?: number | null;
  /** Courses du jour (équité, 4.2). */
  courses_du_jour: number;
  /** Temps jusqu'au restaurant donné par Google (secondes), position fraîche seulement ; sinon absent. */
  secondes_google?: number | null;
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
  | 'AUTRE_LIVREUR_LIBRE';

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

export interface CommandeAttendue {
  order_id: string;
  reference: string;
  /** Fin estimée, médiane : « prête vers ». */
  prete_vers: Date;
  /** Fin estimée pour décider (8e décile ou cuisine). */
  prete_au_plus_tard: Date;
}

export interface ActionRetenir {
  type: 'RETENIR';
  course_id: string;
  deliverer_id: string | null;
  /** Départ retenu jusqu'à : ne peut que diminuer. */
  jusqua: Date;
  attendues: CommandeAttendue[];
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

export type ActionPlanification =
  | ActionMarquerParti
  | ActionDetacher
  | ActionAjouter
  | ActionCreerCourse
  | ActionFusionner
  | ActionOrdonner
  | ActionOffrir
  | ActionRetenir
  | ActionLiberer
  | ActionConfierTurbo;

export type TypeActionPlanification = ActionPlanification['type'];

/** Un essai refusé (journal, tests une limite à la fois). */
export interface RefusPlanification {
  essai: 'AJOUT' | 'CREATION' | 'FUSION' | 'RETENUE';
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

/** Le livreur est-il au restaurant ? Dernière position proche et de moins de 15 min (4.2). */
export function estAuRestaurant(
  l: Pick<LivreurPlanif, 'position' | 'position_at'>,
  restaurant: ILatLng | null,
  r: Pick<ReglagesPlanification, 'auRestaurantRayonM' | 'auRestaurantFraicheurMin'>,
  maintenant: Date,
): boolean {
  if (!restaurant || !l.position || !l.position_at) return false;
  if (maintenant.getTime() - l.position_at.getTime() > r.auRestaurantFraicheurMin * 60_000) return false;
  return haversineMeters(l.position, restaurant) <= r.auRestaurantRayonM;
}

export type SourceEta = 'COMPTOIR' | 'GOOGLE' | 'VOL_OISEAU' | 'DEFAUT';

export interface EtaLivreur {
  secondes: number;
  source: SourceEta;
  au_comptoir: boolean;
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
  const fraiche = (l: LivreurPlanif) =>
    !!restaurant &&
    !!l.position &&
    !!l.position_at &&
    maintenant.getTime() - l.position_at.getTime() <= r.positionExpirationMin * 60_000;
  const aMesurer = livreurs.filter((l) => !estAuRestaurant(l, restaurant, r, maintenant) && fraiche(l));
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

export type FenetreApresRetrait = { ouverte: true; ferme_a: Date } | { ouverte: false; motif: MotifDepart };

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
 *  - aucune position, reçue après le retrait, à plus du rayon de départ ;
 *  - retrait il y a moins de la fenêtre (240 s).
 */
export function fenetreApresRetrait(
  course: Pick<CoursePlanif, 'statut' | 'parti_at' | 'picked_up_at' | 'livraisons'>,
  livreur: Pick<LivreurPlanif, 'protocole_appli' | 'position' | 'position_at'> | null,
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
  if (
    restaurant &&
    livreur.position &&
    livreur.position_at &&
    livreur.position_at.getTime() > course.picked_up_at.getTime() &&
    haversineMeters(livreur.position, restaurant) > r.departRayonM
  ) {
    return { ouverte: false, motif: 'POSITION' };
  }
  const fermeA = course.picked_up_at.getTime() + r.ajoutApresRetraitMaxS * 1000;
  if (fermeA <= maintenant.getTime()) return { ouverte: false, motif: 'FENETRE_ECHUE' };
  return { ouverte: true, ferme_a: new Date(fermeA) };
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

/** Livraisons qui comptent : ni annulées, ni échouées, ni livrées, commande non annulée. */
function livraisonsActives(livraisons: readonly LivraisonPlanif[]): LivraisonPlanif[] {
  return [...livraisons]
    .filter((l) => !STATUTS_LIVRAISON_TERMINEE.includes(l.statut) && l.commande.statut !== OrderStatus.CANCELLED)
    .sort((a, b) => a.sequence_order - b.sequence_order);
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
  r: Pick<ReglagesPlanification, 'horizonPreparationS'> = REGLAGES_PLANIFICATION_DEFAUT,
): [ClientDirection, ClientDirection][] {
  const t = instantane.maintenant.getTime();
  const mobiles: ClientDirection[] = [];
  const groupes: ClientDirection[][] = [];

  for (const c of instantane.commandes) {
    if (c.delivery_service !== DeliveryService.CHICKEN_NATION) continue;
    if (c.statut === OrderStatus.READY) mobiles.push(c.client);
    else if (
      c.statut === OrderStatus.IN_PROGRESS &&
      c.preparation &&
      c.preparation.finDecision.getTime() - t <= r.horizonPreparationS * 1000
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

/**
 * Tournée d'un groupe partant à `departMs` : validité de la direction, ordre
 * des arrêts, arrivée estimée de chaque client (trajets + 3 min par arrêt
 * précédent), durée. Groupe invalide (ancienne course) : estimé en « même
 * zone » pour comparer, jamais accepté comme nouveau groupe.
 * `volOiseau` : sans tracé ni distance routière, pour comparer deux
 * estimations sur la même base.
 */
function estimer(ctx: Contexte, arrets: readonly Arret[], departMs: number, volOiseau = false): EstimationGroupe {
  const arriveesMs = new Map<string, number>();
  if (arrets.length === 0) return { valide: true, verdict: null, ordre: [], base: 'vol_oiseau', arriveesMs, dureeS: 0 };
  const R = ctx.restaurant;
  const clients = arrets.map((a) => (volOiseau ? sansCarte(a.client) : a.client));
  if (!R) {
    for (const a of arrets) arriveesMs.set(a.id, departMs);
    return { valide: arrets.length === 1, verdict: null, ordre: arrets.map((a) => a.id), base: 'vol_oiseau', arriveesMs, dureeS: 0 };
  }
  const verdict = evaluerGroupe(R, clients, ctx.verdictDe);
  const mode: ModeGroupe = verdict.valide && verdict.mode ? verdict.mode : clients.length === 1 ? 'seul' : 'zone';
  const ordre = verdict.valide ? verdict.ordre : ordonnerArrets(R, clients, { mode });
  const parId = new Map(clients.map((c) => [c.id, c]));
  const ordonnes = ordre.map((id) => parId.get(id)!).filter(Boolean);
  const lointain = verdict.valide && verdict.lointainId ? parId.get(verdict.lointainId) ?? null : null;
  const est = estimerTrajets(R, ordonnes, { mode, lointain, vitesseKmh: vitesseKmh(new Date(departMs), ctx.r) });
  const places = ordonnes.filter((c) => c.position);
  places.forEach((c, i) => arriveesMs.set(c.id, departMs + (est.secondesCumulees[i] + i * ARRET_CLIENT_S) * 1000));
  for (const c of ordonnes) if (!arriveesMs.has(c.id)) arriveesMs.set(c.id, departMs);
  const dureeS = places.length ? est.secondesCumulees[places.length - 1] + (places.length - 1) * ARRET_CLIENT_S : 0;
  return { valide: verdict.valide, verdict, ordre, base: est.base, arriveesMs, dureeS };
}

/** Comparer deux estimations sur la même base : vol d'oiseau pour les deux si elles diffèrent. */
function memeBase(
  ctx: Contexte,
  a: { arrets: readonly Arret[]; departMs: number; est: EstimationGroupe },
  b: { arrets: readonly Arret[]; departMs: number; est: EstimationGroupe },
): [EstimationGroupe, EstimationGroupe] {
  if (a.est.base === b.est.base || a.arrets.length === 0 || b.arrets.length === 0) return [a.est, b.est];
  return [estimer(ctx, a.arrets, a.departMs, true), estimer(ctx, b.arrets, b.departMs, true)];
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
 */
function evaluerAjout(
  ctx: Contexte,
  p: {
    existants: readonly Arret[];
    nouveaux: readonly Arret[];
    departAvantMs: number;
    departApresMs: number;
    /** Départ des nouvelles commandes si elles partaient seules ; `null` = aucun livreur pour elles. */
    departSeulMs: number | null;
    attente: { premierePreteMs: number } | null;
    /**
     * Le départ de la course est connu (livreur affecté, offre en attente ou
     * livreur libre). Faux : personne ne peut la prendre, le départ n'est
     * qu'une supposition ; toutes ses commandes attendent un livreur et la
     * regrouper ne fait que mieux employer le premier qui se libère. Le
     * détour maximal joue toujours, le retard des commandes déjà prévues non.
     */
    departConnu: boolean;
  },
): ResultatAjout {
  const r = ctx.r;
  const tous = [...p.existants, ...p.nouveaux];
  if (tous.length > r.maxCommandesParCourse) return { ok: false, refus: 'TAILLE', libelle: 'course pleine' };
  if (
    p.attente &&
    p.departSeulMs !== null &&
    p.departApresMs > p.attente.premierePreteMs + r.attenteMaxCommandePreteS * 1000 &&
    p.departSeulMs < p.departApresMs
  ) {
    return { ok: false, refus: 'ATTENTE_COMMANDE_PRETE', libelle: 'attente trop longue au comptoir' };
  }

  const apres = estimer(ctx, tous, p.departApresMs);
  if (!apres.valide) {
    return { ok: false, refus: 'DIRECTION', libelle: apres.verdict?.refus?.libelle || libelleDirection('DIRECTION_DIFFERENTE') };
  }
  if (tous.length >= 2 && apres.dureeS > r.dureeTourneeMaxMin * 60) {
    return { ok: false, refus: 'DUREE_TOURNEE', libelle: `tournée de ${minutesTexte(apres.dureeS * 1000)}, trop longue` };
  }

  const avant0 = estimer(ctx, p.existants, p.departAvantMs);
  const [avant, apresCmp] = memeBase(
    ctx,
    { arrets: p.existants, departMs: p.departAvantMs, est: avant0 },
    { arrets: tous, departMs: p.departApresMs, est: apres },
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
      const seul0 = estimer(ctx, [q], p.departSeulMs);
      const [groupe, seul] = memeBase(
        ctx,
        { arrets: tous, departMs: p.departApresMs, est: apres },
        { arrets: [q], departMs: p.departSeulMs, est: seul0 },
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
  if (!turbo) {
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
    dejaSollicites: new Set(k.deja_sollicites),
  };
}

function etaMs(ctx: Contexte, delivererId: string | null): number {
  const eta = delivererId ? ctx.etas.get(delivererId) : undefined;
  return (eta?.secondes ?? ctx.r.etaParDefautMin * 60) * 1000;
}

/** Départ au plus tôt avec un livreur libre (le plus proche), ou `null` sans livreur libre. */
function departLibreMs(ctx: Contexte, enPlus: readonly string[] = []): number | null {
  const ids = new Set([...ctx.libres, ...enPlus]);
  if (ids.size === 0) return null;
  return ctx.t + Math.min(...[...ids].map((id) => etaMs(ctx, id)));
}

/** Départ estimé d'une course ; `null` = sans livreur et aucun livreur libre. */
function departCourse(ctx: Contexte, k: CourseTravail): number | null {
  if (k.statut === CourseStatut.IN_DELIVERY || k.statut === CourseStatut.AT_RESTAURANT) return ctx.t;
  if (k.statut === CourseStatut.ACCEPTED) return ctx.t + etaMs(ctx, k.delivererId);
  if (k.offre) return ctx.t + etaMs(ctx, k.offre.deliverer_id);
  return departLibreMs(ctx);
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
    const departSeul = departLibreMs(ctx);
    let meilleur: { k: CourseTravail; res: Extract<ResultatAjout, { ok: true }>; cle: number[]; attendue: boolean } | null = null;
    for (const k of ouvertes) {
      if (k.categorie === null || k.absorbee) continue;
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
    const depart = departOuDefaut(ctx, departLibre);
    let arrets: Arret[] = [graine];
    let derniere: Extract<ResultatAjout, { ok: true }> | null = null;
    for (let i = 0; i < restantes.length && arrets.length < r.maxCommandesParCourse; ) {
      const res = evaluerAjout(ctx, {
        existants: arrets,
        nouveaux: [restantes[i]],
        departAvantMs: depart,
        departApresMs: depart,
        departSeulMs: departLibre === null ? null : depart,
        attente: null,
        departConnu: departLibre !== null,
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

      // (a) Vers une course qui a déjà son livreur.
      let meilleureA: { k: CourseTravail; res: Extract<ResultatAjout, { ok: true }>; cle: number[] } | null = null;
      for (const k of ouvertes) {
        if (k === u || k.absorbee || k.categorie === null || k.categorie === 3) continue;
        const depart = departOuDefaut(ctx, departCourse(ctx, k));
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
          const departCible = cible.offre
            ? ctx.t + etaMs(ctx, cible.offre.deliverer_id)
            : departLibreMs(ctx, absorbee.offre ? [absorbee.offre.deliverer_id] : []);
          const departAvant = departOuDefaut(ctx, departCourse(ctx, cible));
          const res = evaluerAjout(ctx, {
            existants: cible.arrets,
            nouveaux: absorbee.arrets,
            departAvantMs: departAvant,
            departApresMs: departOuDefaut(ctx, departCible),
            departSeulMs: departCourse(ctx, absorbee),
            attente: { premierePreteMs: plusAnciennePrete(ctx, absorbee.arrets) },
            departConnu: departCible !== null,
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

  // ── 4. Ordre des arrêts des courses existantes modifiées.
  for (const k of ouvertes) {
    if (!k.modifiee || k.absorbee || !k.id) continue;
    const est = estimer(ctx, k.arrets, departOuDefaut(ctx, departCourse(ctx, k)));
    k.arrets = reordonner(k.arrets, est.ordre);
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
        ? 'Proposée au livreur au comptoir'
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

  for (const k of aRetenir) {
    const T = k.source?.retenue_jusqua?.getTime() ?? null;
    if (T !== null && T <= t) continue; // terminée : jamais reposée
    const dPossible = departOuDefaut(ctx, departCourse(ctx, k));
    let limite = Math.min(...k.arrets.map((a) => (a.readyMs ?? t) + r.attenteMaxCommandePreteS * 1000));
    if (k.fenetreFermeMs !== null) limite = Math.min(limite, k.fenetreFermeMs);
    if (T !== null) limite = Math.min(limite, T);
    if (k.arrets.length === 0 || limite <= t || dPossible >= limite) continue;

    const attenduesAvant = new Set(k.source?.commandes_attendues ?? []);
    const candidates = enPreparation
      .filter((c) => !reservees.has(c.id))
      .sort(
        (a, b) =>
          Number(!attenduesAvant.has(a.id)) - Number(!attenduesAvant.has(b.id)) ||
          a.preparation!.finDecision.getTime() - b.preparation!.finDecision.getTime(),
      );
    const choisies: { c: CommandePlanif; arret: Arret; fin: number }[] = [];
    for (const c of candidates) {
      const fin = c.preparation!.finDecision.getTime();
      const noter = (motif: MotifRefusPlanification, libelle: string) =>
        refus.push({ essai: 'RETENUE', order_id: c.id, source_id: null, course_cle: k.cle, refus: motif, libelle });
      if (fin - t > r.horizonPreparationS * 1000) {
        noter('HORIZON', `${c.reference} prête dans plus de ${minutesTexte(r.horizonPreparationS * 1000)}`);
        continue;
      }
      if (fin > limite) {
        noter('LIMITE_RETENUE', `${c.reference} prête trop tard`);
        continue;
      }
      if (fin <= dPossible) continue; // prête avant le départ possible : rien à attendre
      if (!r.retenueMemeSiLivreurLibre && autreLivreurATemps(ctx, k, fin)) {
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
      choisies.push({ c, arret, fin });
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
    }));
    const memes =
      T === jusqua &&
      attenduesAvant.size === attendues.length &&
      attendues.every((a) => attenduesAvant.has(a.order_id));
    if (memes) continue;
    actions.push({
      type: 'RETENIR',
      course_id: k.id!,
      deliverer_id: k.delivererId,
      jusqua: new Date(jusqua),
      attendues,
      libelle: `Attendre ${attendues
        .map((a) => `${a.reference} (prête vers ${heureLisible(a.prete_vers, maintenant)})`)
        .join(', ')}, départ au plus tard ${heureLisible(new Date(jusqua), maintenant)}`,
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

  // ── 7. Turbo, dernier recours.
  for (const k of ouvertes) {
    if (k.categorie !== 3 || k.absorbee || k.nouvelle || k.offre || !k.source) continue;
    const d = decisionTurboV2({ ...k.source, offre: null }, r, maintenant);
    if (!d.basculer) continue;
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
 * (au plus tôt, ou à son arrivée s'il est en route). `null` sans coordonnées.
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
  const restants = livraisonsActives(course.livraisons).filter((l) => l.commande.client.position);
  const parti =
    course.statut === CourseStatut.IN_DELIVERY &&
    (!!course.parti_at || course.livraisons.some((l) => l.statut !== DeliveryStatut.PENDING && l.statut !== DeliveryStatut.CANCELLED));
  const fraiche =
    !!livreur.position && !!livreur.position_at && t - livreur.position_at.getTime() <= r.positionExpirationMin * 60_000;

  let point: ILatLng;
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
  }
  const mps = vitesseKmh(new Date(debut), r) / 3.6;
  let duree = 0;
  for (const l of restants) {
    const p = l.commande.client.position!;
    duree += (haversineMeters(point, p) * FACTEUR_ROUTE_VOL_OISEAU) / mps + ARRET_CLIENT_S;
    point = p;
  }
  duree += (haversineMeters(point, restaurant) * FACTEUR_ROUTE_VOL_OISEAU) / mps;
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
