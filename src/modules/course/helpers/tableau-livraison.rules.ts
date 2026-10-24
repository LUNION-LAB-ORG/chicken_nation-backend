import {
  CourseStatut,
  DeliveryService,
  DeliveryStatut,
  EntityStatus,
  OrderStatus,
  ShiftAssignmentStatus,
  ShiftType,
} from '@prisma/client';

import type { EtatAffichageLivreur } from 'src/modules/deliverers/helpers/disponibilite.rules';
import {
  AffectationDuJour,
  PlanningDuJourLu,
  affectationsDuJour,
  prevusParRestaurant,
} from 'src/modules/deliverers/helpers/planning-du-jour.rules';

import { JourneeDeService, journeeDeService } from './journee-service.rules';
import { STATUTS_LIVRAISON_TERMINEE } from './remise-course.rules';
import { CourseTourneeLue, departEstReel, enRetard, finTourneePrevue, retardMin } from './retard-tournee.rules';

/**
 * TABLEAU DE LA LIVRAISON, règle pure (conception du 24/10, 11.4) : ce que
 * `GET /livraison/tableau` renvoie, calculé à partir de lectures faites par
 * `TableauLivraisonService`.
 *
 * Il nourrit le bandeau des restaurants (En direct, Courses, Livreurs,
 * Planning), la ligne Livreurs de l'écran Commandes, « À surveiller »,
 * « À traiter » et la pastille du menu. Les alertes sont calculées ICI, une
 * seule fois, avec les réglages existants :
 *
 *  - TOURNEE_EN_RETARD (rouge) : course en livraison en retard
 *    (retard-tournee.rules.ts, `course.delay_alert_factor`) ;
 *  - SANS_LIVREUR : recherche sans livreur ni Turbo (ambre, rouge au seuil
 *    de la cloche, `seuilAlerteSansLivreurMin`), ou expirée dans la journée
 *    (rouge), avec des commandes vivantes ;
 *  - PARTI_SANS_SAC (rouge) : départ réel avec une commande d'origine encore
 *    prête au comptoir ;
 *  - COURSE_ANNULEE_A_RELANCER (rouge) : annulée dans la journée, une
 *    commande encore prête à relancer ;
 *  - ATTENTE_AU_RESTAURANT (ambre) : livreur au restaurant, course pas
 *    récupérée, depuis la moitié de `course.auto_cancel_at_restaurant_after_min` ;
 *  - APPLI_FERMEE_EN_COURSE (ambre) : livreur en course, appli fermée par la
 *    règle unique ;
 *  - POSITION_PERDUE_EN_COURSE (ambre) : livreur en course, position plus
 *    vieille que `deliverer.gps_expiration_minutes` ; pas quand l'appli est
 *    fermée, le signal d'au-dessus le dit déjà ;
 *  - A_ENCAISSER (ambre) : commandes livrées en espèces pas encaissées d'un
 *    livreur, la plus ancienne depuis 60 min ;
 *  - PREVU_PAS_EN_SERVICE (ambre) : prévu au créneau en cours commencé depuis
 *    15 min et hors service, ou « Non » au point du matin.
 *
 * Journée de service de 05 h à 05 h (journee-service.rules.ts) : livrées,
 * courses expirées ou annulées et planning du jour la suivent.
 */

/** Le livreur doit rapporter l'argent : même seuil que l'écran Commandes (`OVERDUE_COLLECTED_UNPAID_MIN`). */
export const A_ENCAISSER_APRES_MIN = 60;
/** Un livreur prévu qui n'est pas en service 15 min après le début de son créneau. */
export const PREVU_PAS_EN_SERVICE_APRES_MIN = 15;

export type CleSignal =
  | 'TOURNEE_EN_RETARD'
  | 'SANS_LIVREUR'
  | 'PARTI_SANS_SAC'
  | 'COURSE_ANNULEE_A_RELANCER'
  | 'ATTENTE_AU_RESTAURANT'
  | 'APPLI_FERMEE_EN_COURSE'
  | 'POSITION_PERDUE_EN_COURSE'
  | 'A_ENCAISSER'
  | 'PREVU_PAS_EN_SERVICE';

export type GraviteSignal = 'rouge' | 'ambre';

export interface SignalLivraison {
  cle: CleSignal;
  gravite: GraviteSignal;
  restaurant_id: string;
  /** Début du problème (ISO) : arrivée, départ, fin prévue dépassée, créneau… */
  depuis: string | null;
  /** Minutes pleines depuis `depuis` ; retard au-delà de la fin prévue pour une tournée. */
  minutes: number | null;
  course: { id: string; reference: string; statut: CourseStatut; expiree: boolean } | null;
  livreur: { id: string; prenom: string | null } | null;
  /** Références des commandes concernées. */
  commandes: string[];
  /** PREVU_PAS_EN_SERVICE : créneau prévu. */
  creneau?: ShiftType;
  /** APPLI_FERMEE_EN_COURSE : dernier signe de vie de l'appli (ISO). */
  appli_vue_a?: string | null;
}

export interface LivreurDuTableau {
  id: string;
  prenom: string | null;
  etat: EtatAffichageLivreur;
  /** Place dans la file de CE restaurant (rang-file.rules.ts). */
  rang_file: number | null;
  course: { reference: string; statut: CourseStatut } | null;
}

export interface RestaurantDuTableau {
  id: string;
  nom: string;
  livreurs: {
    /** Disponible, Offre en attente, En appel (avec le service client). */
    disponibles: number;
    en_course: number;
    /** En pause, Pause automatique. */
    en_pause: number;
    /** Appli fermée, Injoignable (aucune offre ne lui arrive). */
    appli_fermee: number;
    /** Tous sauf Hors service et Inactif. */
    en_service: number;
    /** Livreurs prévus aujourd'hui ; `null` sans planning envoyé ou confirmé pour ce jour. */
    prevus: number | null;
  };
  sans_livreur: { courses: number; plus_ancienne_depuis: string | null };
  jour: { livrees: number; duree_moyenne_s: number | null };
  /** Signaux rouges du restaurant. */
  alertes: number;
  liste: LivreurDuTableau[];
}

export interface TableauLivraison {
  genere_a: string;
  restaurants: RestaurantDuTableau[];
  signaux: SignalLivraison[];
}

// ============================================================
// LECTURES
// ============================================================

type DateLue = Date | string | null | undefined;

export interface ReglagesTableau {
  /** `course.delay_alert_factor`. */
  facteurRetard: number;
  /** `course.no_deliverer_alert_after_min`. */
  sansLivreurAlerteMin: number;
  /**
   * Seuil de « Sans livreur » par restaurant, quand il diffère du précédent :
   * planificateur v2 avec Turbo actif (`seuilAlerteSansLivreurMin`, comme la
   * cloche). Une course d'origine Turbo garde `sansLivreurAlerteMin`.
   */
  sansLivreurAlerteMinParRestaurant?: Record<string, number>;
  /** Moitié de `course.auto_cancel_at_restaurant_after_min`. */
  attenteAuRestaurantMin: number;
  /** `deliverer.gps_expiration_minutes`. */
  positionExpireeMin: number;
}

/** Livreur tel que `GET /deliverers/live-locations` le renvoie (champs lus). */
export interface LivreurLu {
  id: string;
  first_name: string | null;
  restaurant: { id: string } | null;
  disponibilite: { etat: EtatAffichageLivreur };
  rang_file: number | null;
  appli_active: boolean | null;
  appli_vue_a: string | null;
  location_at: string | null;
  active_course: { id: string; reference: string; statut: CourseStatut } | null;
}

/** Course non terminée, ou expirée ou annulée dans la journée. */
export interface CourseLue extends CourseTourneeLue {
  id: string;
  reference: string;
  statut: CourseStatut;
  restaurant_id: string;
  deliverer: { id: string; first_name: string | null } | null;
  turbo_escalated_at: DateLue;
  created_at: DateLue;
  at_restaurant_at: DateLue;
  cancelled_at: DateLue;
  deliveries: Array<{
    statut: DeliveryStatut;
    ajoutee_apres_retrait: boolean;
    order: { reference: string; status: OrderStatus; entity_status: EntityStatus; delivery_service?: DeliveryService };
  }>;
}

/** Commande livrée payable en espèces, pas encore encaissée (COLLECTED, OFFLINE). */
export interface CommandeAEncaisserLue {
  reference: string;
  restaurant_id: string;
  collected_at: DateLue;
  livreur: { id: string; first_name: string | null } | null;
}

/** Livraison DELIVERED : restaurant, livrée à, prête à. */
export interface LivraisonLivreeLue {
  restaurant_id: string;
  delivered_at: DateLue;
  ready_at: DateLue;
}

export interface EntreeTableau {
  maintenant: Date;
  reglages: ReglagesTableau;
  restaurants: Array<{ id: string; nom: string }>;
  livreurs: LivreurLu[];
  courses: CourseLue[];
  aEncaisser: CommandeAEncaisserLue[];
  livrees: LivraisonLivreeLue[];
  planning: PlanningDuJourLu;
}

// ============================================================
// OUTILS
// ============================================================

const UNE_MINUTE_MS = 60_000;

const lireDate = (v: DateLue): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

const ecouleMs = (d: Date, maintenant: Date): number => maintenant.getTime() - d.getTime();

const minutesDepuis = (d: Date | null, maintenant: Date): number | null =>
  d ? Math.max(0, Math.floor(ecouleMs(d, maintenant) / UNE_MINUTE_MS)) : null;

const dansLaJournee = (d: Date | null, j: JourneeDeService): boolean =>
  !!d && d.getTime() >= j.debut.getTime() && d.getTime() < j.fin.getTime();

/** Commande qui attend encore sa livraison : acceptée, en cuisine ou prête, pas supprimée. */
const STATUTS_COMMANDE_VIVANTE: OrderStatus[] = [OrderStatus.ACCEPTED, OrderStatus.IN_PROGRESS, OrderStatus.READY];

type LivraisonLue = CourseLue['deliveries'][number];

const commandeVivante = (l: LivraisonLue): boolean =>
  l.statut !== DeliveryStatut.CANCELLED &&
  STATUTS_COMMANDE_VIVANTE.includes(l.order.status) &&
  l.order.entity_status !== EntityStatus.DELETED;

const references = (livraisons: LivraisonLue[]): string[] => livraisons.map((l) => l.order.reference);

/** Ordre de la liste : d'abord ceux qui peuvent partir, puis la file. */
const ORDRE_ETATS: EtatAffichageLivreur[] = [
  'DISPONIBLE',
  'OFFRE_EN_ATTENTE',
  'EN_APPEL',
  'EN_COURSE',
  'EN_PAUSE',
  'PAUSE_AUTO',
  'APPLI_FERMEE',
  'INJOIGNABLE',
  'HORS_SERVICE',
  'INACTIF',
];

// ============================================================
// RÈGLES
// ============================================================

/**
 * Course sans livreur : recherche en cours sans livreur ni Turbo, ou expirée
 * (aucun livreur trouvé) dans la journée de service ; avec au moins une
 * commande vivante (une course vidée par un regroupement ne compte pas).
 */
export function estSansLivreur(c: CourseLue, journee: JourneeDeService): boolean {
  if (!c.deliveries.some(commandeVivante)) return false;
  if (c.statut === CourseStatut.PENDING_ASSIGNMENT) return !c.deliverer && !lireDate(c.turbo_escalated_at);
  if (c.statut === CourseStatut.EXPIRED) return dansLaJournee(lireDate(c.created_at), journee);
  return false;
}

/**
 * Seuil de la cloche « aucun livreur » pour cette course : celui de son
 * restaurant (v2 avec Turbo : Turbo d'abord), sauf course d'origine Turbo.
 */
function seuilSansLivreurMin(c: CourseLue, reglages: ReglagesTableau): number {
  const turboNatif =
    c.deliveries.length > 0 && c.deliveries.every((l) => l.order.delivery_service === DeliveryService.TURBO);
  if (turboNatif) return reglages.sansLivreurAlerteMin;
  return reglages.sansLivreurAlerteMinParRestaurant?.[c.restaurant_id] ?? reglages.sansLivreurAlerteMin;
}

function signauxDesCourses(e: EntreeTableau, journee: JourneeDeService): SignalLivraison[] {
  const { maintenant, reglages } = e;
  const signaux: SignalLivraison[] = [];
  for (const c of e.courses) {
    const course = { id: c.id, reference: c.reference, statut: c.statut, expiree: c.statut === CourseStatut.EXPIRED };
    const livreur = c.deliverer ? { id: c.deliverer.id, prenom: c.deliverer.first_name } : null;
    const base = { restaurant_id: c.restaurant_id, course };

    if (estSansLivreur(c, journee)) {
      const creee = lireDate(c.created_at);
      const rouge =
        course.expiree || (!!creee && ecouleMs(creee, maintenant) >= seuilSansLivreurMin(c, reglages) * UNE_MINUTE_MS);
      signaux.push({
        ...base,
        cle: 'SANS_LIVREUR',
        gravite: rouge ? 'rouge' : 'ambre',
        depuis: iso(creee),
        minutes: minutesDepuis(creee, maintenant),
        livreur: null,
        commandes: references(c.deliveries.filter(commandeVivante)),
      });
      continue;
    }

    if (enRetard(c, maintenant, reglages.facteurRetard)) {
      signaux.push({
        ...base,
        cle: 'TOURNEE_EN_RETARD',
        gravite: 'rouge',
        depuis: iso(finTourneePrevue(c)),
        minutes: retardMin(c, maintenant, reglages.facteurRetard),
        livreur,
        commandes: references(c.deliveries.filter((l) => !STATUTS_LIVRAISON_TERMINEE.includes(l.statut))),
      });
    }

    // Même règle que la cloche du sac oublié (`DepartCourseService.signalerCommandesPasRemises`).
    if (c.statut === CourseStatut.IN_DELIVERY && departEstReel(c)) {
      const oubliees = c.deliveries.filter(
        (l) =>
          !STATUTS_LIVRAISON_TERMINEE.includes(l.statut) &&
          !l.ajoutee_apres_retrait &&
          l.order.status === OrderStatus.READY,
      );
      if (oubliees.length > 0) {
        const parti = lireDate(c.parti_at);
        signaux.push({
          ...base,
          cle: 'PARTI_SANS_SAC',
          gravite: 'rouge',
          depuis: iso(parti),
          minutes: minutesDepuis(parti, maintenant),
          livreur,
          commandes: references(oubliees),
        });
      }
    }

    const arrivee = lireDate(c.at_restaurant_at);
    if (
      arrivee &&
      !lireDate(c.picked_up_at) &&
      (c.statut === CourseStatut.ACCEPTED || c.statut === CourseStatut.AT_RESTAURANT) &&
      ecouleMs(arrivee, maintenant) >= reglages.attenteAuRestaurantMin * UNE_MINUTE_MS
    ) {
      signaux.push({
        ...base,
        cle: 'ATTENTE_AU_RESTAURANT',
        gravite: 'ambre',
        depuis: iso(arrivee),
        minutes: minutesDepuis(arrivee, maintenant),
        livreur,
        commandes: references(c.deliveries.filter(commandeVivante)),
      });
    }

    // Mêmes commandes que « Relancer la livraison » (`relancerCourseAnnulee`) : livraison
    // annulée, commande encore prête. Relancée, elle quitte cette course.
    if (c.statut === CourseStatut.CANCELLED) {
      const annulee = lireDate(c.cancelled_at) ?? lireDate(c.created_at);
      const aRelancer = c.deliveries.filter(
        (l) =>
          l.statut === DeliveryStatut.CANCELLED &&
          l.order.status === OrderStatus.READY &&
          l.order.entity_status !== EntityStatus.DELETED,
      );
      if (dansLaJournee(annulee, journee) && aRelancer.length > 0) {
        signaux.push({
          ...base,
          cle: 'COURSE_ANNULEE_A_RELANCER',
          gravite: 'rouge',
          depuis: iso(annulee),
          minutes: minutesDepuis(annulee, maintenant),
          livreur: null,
          commandes: references(aRelancer),
        });
      }
    }
  }
  return signaux;
}

function signauxDesLivreurs(e: EntreeTableau): SignalLivraison[] {
  const { maintenant, reglages } = e;
  const signaux: SignalLivraison[] = [];
  for (const l of e.livreurs) {
    if (!l.active_course || !l.restaurant) continue;
    const base = {
      restaurant_id: l.restaurant.id,
      // Champ par champ : la lecture du livreur porte aussi le code de retrait
      // et les adresses de la tournée, qui n'ont rien à faire ici.
      course: { id: l.active_course.id, reference: l.active_course.reference, statut: l.active_course.statut, expiree: false },
      livreur: { id: l.id, prenom: l.first_name },
      commandes: [] as string[],
    };
    if (l.appli_active === false) {
      const vue = lireDate(l.appli_vue_a);
      signaux.push({
        ...base,
        cle: 'APPLI_FERMEE_EN_COURSE',
        gravite: 'ambre',
        depuis: iso(vue),
        minutes: minutesDepuis(vue, maintenant),
        appli_vue_a: iso(vue),
      });
      continue;
    }
    const position = lireDate(l.location_at);
    if (!position || ecouleMs(position, maintenant) > reglages.positionExpireeMin * UNE_MINUTE_MS) {
      signaux.push({
        ...base,
        cle: 'POSITION_PERDUE_EN_COURSE',
        gravite: 'ambre',
        depuis: iso(position),
        minutes: minutesDepuis(position, maintenant),
      });
    }
  }
  return signaux;
}

function signauxAEncaisser(e: EntreeTableau): SignalLivraison[] {
  const groupes = new Map<string, CommandeAEncaisserLue[]>();
  for (const c of e.aEncaisser) {
    if (!c.livreur) continue;
    const cle = `${c.restaurant_id}|${c.livreur.id}`;
    groupes.set(cle, [...(groupes.get(cle) ?? []), c]);
  }
  const signaux: SignalLivraison[] = [];
  for (const commandes of groupes.values()) {
    const dates = commandes.map((c) => lireDate(c.collected_at)).filter((d): d is Date => !!d);
    if (dates.length === 0) continue;
    const plusAncienne = new Date(Math.min(...dates.map((d) => d.getTime())));
    if (ecouleMs(plusAncienne, e.maintenant) < A_ENCAISSER_APRES_MIN * UNE_MINUTE_MS) continue;
    const { livreur, restaurant_id } = commandes[0];
    signaux.push({
      cle: 'A_ENCAISSER',
      gravite: 'ambre',
      restaurant_id,
      depuis: iso(plusAncienne),
      minutes: minutesDepuis(plusAncienne, e.maintenant),
      course: null,
      livreur: { id: livreur!.id, prenom: livreur!.first_name },
      commandes: commandes.map((c) => c.reference),
    });
  }
  return signaux;
}

/**
 * Prévu, pas en service : affecté (pas refusé) à un créneau du jour d'un
 * planning envoyé ou confirmé, pas au repos, hors service, et soit le créneau
 * en cours a commencé depuis 15 min, soit il a répondu « Non » au point du
 * matin (signalé dès la réponse, pour le créneau en cours ou le suivant).
 * Un signal par livreur.
 */
function signauxPrevus(e: EntreeTableau): SignalLivraison[] {
  const { maintenant, planning } = e;
  const repos = new Set(planning.repos);
  const absents = new Set(planning.absents);
  const parId = new Map(e.livreurs.map((l) => [l.id, l]));
  const parLivreur = new Map<string, AffectationDuJour[]>();
  for (const a of affectationsDuJour(planning)) {
    if (a.statut === ShiftAssignmentStatus.REFUSED) continue;
    parLivreur.set(a.deliverer_id, [...(parLivreur.get(a.deliverer_id) ?? []), a]);
  }

  const t = maintenant.getTime();
  const signaux: SignalLivraison[] = [];
  for (const [id, affectations] of parLivreur) {
    const l = parId.get(id);
    if (!l || repos.has(id) || l.disponibilite.etat !== 'HORS_SERVICE') continue;
    const triees = [...affectations].sort((a, b) => a.debut.getTime() - b.debut.getTime());
    const enCours = triees.find((a) => a.debut.getTime() <= t && t < a.fin.getTime());
    let retenue: AffectationDuJour | null = null;
    if (enCours && t - enCours.debut.getTime() >= PREVU_PAS_EN_SERVICE_APRES_MIN * UNE_MINUTE_MS) retenue = enCours;
    else if (absents.has(id)) retenue = enCours ?? triees.find((a) => a.fin.getTime() > t) ?? null;
    if (!retenue) continue;
    const commence = retenue.debut.getTime() <= t ? retenue.debut : null;
    signaux.push({
      cle: 'PREVU_PAS_EN_SERVICE',
      gravite: 'ambre',
      restaurant_id: retenue.restaurant_id,
      depuis: iso(commence),
      minutes: minutesDepuis(commence, maintenant),
      course: null,
      livreur: { id, prenom: l.first_name },
      commandes: [],
      creneau: retenue.type,
    });
  }
  return signaux;
}

/** Rouges d'abord, puis le problème le plus ancien. */
function trierSignaux(signaux: SignalLivraison[]): SignalLivraison[] {
  const temps = (s: SignalLivraison) => (s.depuis ? new Date(s.depuis).getTime() : Number.POSITIVE_INFINITY);
  return [...signaux].sort(
    (a, b) =>
      (a.gravite === 'rouge' ? 0 : 1) - (b.gravite === 'rouge' ? 0 : 1) ||
      temps(a) - temps(b) ||
      a.cle.localeCompare(b.cle) ||
      (a.course?.reference ?? a.livreur?.id ?? '').localeCompare(b.course?.reference ?? b.livreur?.id ?? ''),
  );
}

function listeDuRestaurant(livreurs: LivreurLu[]): LivreurDuTableau[] {
  const rangEtat = (etat: EtatAffichageLivreur) => {
    const i = ORDRE_ETATS.indexOf(etat);
    return i === -1 ? ORDRE_ETATS.length : i;
  };
  return livreurs
    .map((l) => ({
      id: l.id,
      prenom: l.first_name,
      etat: l.disponibilite.etat,
      rang_file: l.rang_file,
      course: l.active_course ? { reference: l.active_course.reference, statut: l.active_course.statut } : null,
    }))
    .sort(
      (a, b) =>
        rangEtat(a.etat) - rangEtat(b.etat) ||
        (a.rang_file ?? Number.POSITIVE_INFINITY) - (b.rang_file ?? Number.POSITIVE_INFINITY) ||
        (a.prenom ?? '').localeCompare(b.prenom ?? ''),
    );
}

function chiffresDuJour(livrees: LivraisonLivreeLue[], journee: JourneeDeService): RestaurantDuTableau['jour'] {
  let total = 0;
  let somme = 0;
  let mesurees = 0;
  for (const l of livrees) {
    const livree = lireDate(l.delivered_at);
    if (!dansLaJournee(livree, journee)) continue;
    total += 1;
    const prete = lireDate(l.ready_at);
    if (prete && livree!.getTime() >= prete.getTime()) {
      somme += (livree!.getTime() - prete.getTime()) / 1000;
      mesurees += 1;
    }
  }
  return { livrees: total, duree_moyenne_s: mesurees > 0 ? Math.round(somme / mesurees) : null };
}

export function construireTableau(e: EntreeTableau): TableauLivraison {
  const journee = journeeDeService(e.maintenant);
  const restaurantsVus = new Set(e.restaurants.map((r) => r.id));
  const signaux = trierSignaux(
    [...signauxDesCourses(e, journee), ...signauxDesLivreurs(e), ...signauxAEncaisser(e), ...signauxPrevus(e)].filter(
      (s) => restaurantsVus.has(s.restaurant_id),
    ),
  );
  const prevus = prevusParRestaurant(e.planning);

  const restaurants = e.restaurants.map((r): RestaurantDuTableau => {
    const livreurs = e.livreurs.filter((l) => l.restaurant?.id === r.id);
    const compte = (...etats: EtatAffichageLivreur[]) =>
      livreurs.filter((l) => etats.includes(l.disponibilite.etat)).length;
    const sansLivreur = signaux.filter((s) => s.restaurant_id === r.id && s.cle === 'SANS_LIVREUR');
    const depuis = sansLivreur.map((s) => s.depuis).filter((d): d is string => !!d).sort();
    return {
      id: r.id,
      nom: r.nom,
      livreurs: {
        // En appel avec le service client : en service et dans la file, repris à la fin de l'appel.
        disponibles: compte('DISPONIBLE', 'OFFRE_EN_ATTENTE', 'EN_APPEL'),
        en_course: compte('EN_COURSE'),
        en_pause: compte('EN_PAUSE', 'PAUSE_AUTO'),
        appli_fermee: compte('APPLI_FERMEE', 'INJOIGNABLE'),
        en_service: livreurs.length - compte('HORS_SERVICE', 'INACTIF'),
        prevus: prevus.get(r.id)?.size ?? null,
      },
      sans_livreur: { courses: sansLivreur.length, plus_ancienne_depuis: depuis[0] ?? null },
      jour: chiffresDuJour(
        e.livrees.filter((l) => l.restaurant_id === r.id),
        journee,
      ),
      alertes: signaux.filter((s) => s.restaurant_id === r.id && s.gravite === 'rouge').length,
      liste: listeDuRestaurant(livreurs),
    };
  });

  return { genere_a: e.maintenant.toISOString(), restaurants, signaux };
}
