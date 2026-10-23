/**
 * Outils des tests du planificateur : fabriques d'instantanés et un petit
 * MONDE simulé (commandes, cuisine, livreurs, caisse) qui applique les
 * actions des VRAIES règles (`planifier`) et fait vivre les livreurs minute
 * par minute.
 *
 * Fichier de test seulement. Son nom finit par « -spec.ts » : exclu de la
 * construction sans être lancé comme une suite par jest.
 *
 * Le monde est volontairement simple et déterministe :
 *  - un livreur accepte une offre après `delaiAcceptationS` ; s'il est au
 *    restaurant, la course passe aussitôt « au restaurant », sinon il arrive
 *    après le trajet (vol d'oiseau × 1,3 à 22 km/h) ;
 *  - la caisse remet la course dès que toutes ses commandes sont prêtes et
 *    qu'aucune retenue n'est active (le livreur attend pendant la retenue) ;
 *    une commande ajoutée après le retrait est remise aussitôt ;
 *  - un livreur à la nouvelle appli part `delaiDepartS` après le retrait (et
 *    jamais avec une commande prête pas encore remise) ; l'ancienne appli
 *    part à la remise ;
 *  - la tournée se déroule à vol d'oiseau × 1,4, 3 min par client, puis le
 *    livreur revient au restaurant et reprend sa place dans la file.
 * Chaque action est contrôlée au moment où elle est appliquée (invariants) :
 * jamais d'offre à un livreur qui ne peut pas la recevoir, jamais d'ajout ni
 * de fusion vers une course Turbo ou d'un livreur en pause, jamais plus de 3
 * commandes, retenue jamais repoussée ni au-delà de la limite, zéro temps
 * mort (un livreur libre et une course qui attend sans offre).
 *
 * Temps morts plus fins, COMPTÉS en secondes (`tempsMort`) plutôt que
 * refusés : un livreur libre AU COMPTOIR pendant qu'une commande prête
 * (1) est dans la course acceptée d'un livreur qui n'est pas au comptoir,
 * (2) est dans une course proposée à un livreur à plus de 2 min, ou (3) est
 * dans une course qu'il a seulement laissée expirer.
 *
 * `positionsCommeLAppli` : les positions arrivent comme l'appli les envoie
 * aujourd'hui (rien hors course appli fermée, donc rien au retour de
 * tournée ; une position à l'ouverture de l'appli et pendant une course).
 */
import { CourseStatut, DelivererStatus, DeliveryService, DeliveryStatut, EntityStatus, OrderStatus } from '@prisma/client';

import { EtatLivreur, estEnPause, estEnPauseAuto, peutRecevoirOffre } from 'src/modules/deliverers/helpers/disponibilite.rules';

import { haversineMeters, ILatLng } from './geo.helper';
import {
  ActionPlanification,
  CommandePlanif,
  CoursePlanif,
  InstantanePlanification,
  LivraisonPlanif,
  LivreurPlanif,
  planifier,
  PlanRestaurant,
  REGLAGES_PLANIFICATION_DEFAUT,
  ReglagesPlanification,
} from './planification.rules';
import { EstimationPreparation, estimerFinPreparation } from './preparation.rules';

// ─── Géographie et heures ────────────────────────────────────────────────────

/** Restaurant Zone 4 (Marcory). */
export const R: ILatLng = { lat: 5.286, lng: -3.9737 };
export const RESTO = 'resto-zone-4';

/** Décale un point de `nord` et `est` mètres. */
export function decale(p: ILatLng, nord: number, est: number): ILatLng {
  const parDegre = (Math.PI / 180) * 6_371_000;
  return { lat: p.lat + nord / parDegre, lng: p.lng + est / (parDegre * Math.cos((p.lat * Math.PI) / 180)) };
}

/** `h('12:30')`, `h('12:30:20')` : le 23/10/2026, heure d'Abidjan (UTC). */
export function h(hhmm: string): Date {
  const complet = hhmm.length === 5 ? `${hhmm}:00` : hhmm;
  return new Date(`2026-10-23T${complet}.000Z`);
}

export const plus = (d: Date, secondes: number) => new Date(d.getTime() + secondes * 1000);

/** « 12:34:10 » */
export const hms = (d: Date) => d.toISOString().slice(11, 19);

// ─── Fabriques d'instantanés ─────────────────────────────────────────────────

export interface OptionsCommande extends Partial<Omit<CommandePlanif, 'client'>> {
  /** Position du client en mètres depuis le restaurant (est par défaut 2 km). */
  est?: number;
  nord?: number;
  /** Client sans coordonnées. */
  sansCoordonnees?: boolean;
}

export function cmd(id: string, o: OptionsCommande = {}): CommandePlanif {
  const { est = 2000, nord = 0, sansCoordonnees = false, ...reste } = o;
  return {
    id,
    reference: `CMD-${id.toUpperCase()}`,
    statut: OrderStatus.READY,
    delivery_service: DeliveryService.CHICKEN_NATION,
    client: { id, position: sansCoordonnees ? null : decale(R, nord, est), routeMetres: null, trace: null },
    created_at: h('12:15'),
    ready_at: h('12:30'),
    heure_programmee: null,
    preparation: null,
    ...reste,
  };
}

/** Commande EN PRÉPARATION dont la cuisine a donné la fin (`fin`, décision = médiane). */
export function enPrep(id: string, fin: Date, o: OptionsCommande = {}): CommandePlanif {
  const preparation: EstimationPreparation = {
    debut: o.created_at ?? h('12:20'),
    finMediane: fin,
    finDecision: fin,
    source: 'CUISINE',
    enRetard: false,
  };
  return cmd(id, { statut: OrderStatus.IN_PROGRESS, ready_at: null, preparation, ...o });
}

export interface OptionsCourse extends Partial<Omit<CoursePlanif, 'livraisons'>> {
  commandes?: CommandePlanif[];
  livraisons?: LivraisonPlanif[];
}

export function crs(id: string, o: OptionsCourse = {}): CoursePlanif {
  const { commandes = [], livraisons, ...reste } = o;
  return {
    id,
    reference: `CRS-${id.toUpperCase()}`,
    statut: CourseStatut.PENDING_ASSIGNMENT,
    deliverer_id: null,
    turbo_escalated_at: null,
    created_at: h('12:30'),
    picked_up_at: null,
    parti_at: null,
    retenue_jusqua: null,
    commandes_attendues: [],
    offre: null,
    deja_sollicites: [],
    livraisons:
      livraisons ??
      commandes.map((c, i) => ({ id: `liv-${c.id}`, statut: DeliveryStatut.PENDING, sequence_order: i + 1, commande: c })),
    ...reste,
  };
}

export interface OptionsLivreur extends Partial<Omit<LivreurPlanif, 'etat'>> {
  etat?: Partial<EtatLivreur>;
  /** Au comptoir (position au restaurant, fraîche). */
  auComptoir?: boolean;
  /** Position à `est` mètres du restaurant, fraîche. */
  aEst?: number;
}

export function livr(id: string, maintenant: Date, o: OptionsLivreur = {}): LivreurPlanif {
  const { etat = {}, auComptoir = false, aEst, ...reste } = o;
  const position = auComptoir ? R : aEst !== undefined ? decale(R, 0, aEst) : null;
  return {
    id,
    etat: {
      status: DelivererStatus.ACTIVE,
      is_operational: true,
      entity_status: EntityStatus.ACTIVE,
      pause_until: null,
      auto_pause_until: null,
      last_available_at: plus(maintenant, -600),
      en_course: false,
      offre_en_attente: false,
      ...etat,
    },
    position,
    position_at: position ? plus(maintenant, -30) : null,
    protocole_appli: 3,
    queue_penalty_until: null,
    queue_penalty_positions: 0,
    courses_du_jour: 0,
    ...reste,
  };
}

export function instant(
  maintenant: Date,
  o: { commandes?: CommandePlanif[]; courses?: CoursePlanif[]; livreurs?: LivreurPlanif[]; position?: ILatLng | null } = {},
): InstantanePlanification {
  return {
    maintenant,
    restaurant: { id: RESTO, position: o.position === undefined ? R : o.position },
    commandes: o.commandes ?? [],
    courses: o.courses ?? [],
    livreurs: o.livreurs ?? [],
  };
}

export const types = (plan: PlanRestaurant) => plan.actions.map((a) => a.type);
export function actionsDe<T extends ActionPlanification['type']>(plan: PlanRestaurant, type: T) {
  return plan.actions.filter((a): a is Extract<ActionPlanification, { type: T }> => a.type === type);
}

// ─── Le monde simulé ─────────────────────────────────────────────────────────

interface CommandeMonde {
  id: string;
  reference: string;
  statut: OrderStatus;
  position: ILatLng | null;
  created_at: Date;
  prepared_at: Date | null;
  ready_at: Date | null;
  /** Fin annoncée par la cuisine. */
  fin_cuisine: Date | null;
  course_id: string | null;
  remise_at: Date | null;
  livree_at: Date | null;
  turbo: boolean;
}

interface LivraisonMonde {
  id: string;
  order_id: string;
  statut: DeliveryStatut;
  sequence_order: number;
  ajoutee_apres_retrait: boolean;
  livree_ms: number | null;
}

interface CourseMonde {
  id: string;
  reference: string;
  statut: CourseStatut;
  deliverer_id: string | null;
  turbo_escalated_at: Date | null;
  created_at: Date;
  assigned_at: Date | null;
  picked_up_at: Date | null;
  parti_at: Date | null;
  retenue_jusqua: Date | null;
  commandes_attendues: string[];
  offre: { id: string; deliverer_id: string; offered_at: Date; expires_at: Date } | null;
  /** Refus (définitifs). */
  deja_sollicites: string[];
  /** Offres laissées expirer (levées par un signe de vie postérieur). */
  expirees: { deliverer_id: string; a: Date }[];
  livraisons: LivraisonMonde[];
  arrivee_resto_ms: number | null;
  /** Arrivée au comptoir : la caisse remet au plus tôt `DELAI_REMISE_S` après (le livreur présente son code). */
  au_restaurant_ms: number | null;
  depart_prevu_ms: number | null;
  retour_ms: number | null;
}

interface LivreurMonde {
  id: string;
  /** Position connue du serveur (envoyée par l'appli). */
  position: ILatLng | null;
  position_at: Date | null;
  /** Où il est vraiment (temps morts comptés sur la réalité, pas sur ce que voit le serveur). */
  reel: ILatLng | null;
  pause_until: Date | null;
  auto_pause_until: Date | null;
  last_available_at: Date | null;
  protocole_appli: number;
  courses_du_jour: number;
  delaiAcceptationS: number;
  delaiDepartS: number;
}

export interface OptionsLivreurMonde {
  position?: ILatLng | null;
  /** Libre et au comptoir depuis cette heure (défaut : début du monde). */
  libreDepuis?: Date | null;
  pause_until?: Date | null;
  protocole_appli?: number;
  delaiAcceptationS?: number;
  delaiDepartS?: number;
}

/** Événement prévu : quand, et quoi faire. */
interface Evenement {
  a: Date;
  faire: () => void;
}

const VITESSE_MONDE_KMH = 22;
/** Temps pour présenter le code à la caisse après l'arrivée au comptoir. */
const DELAI_REMISE_S = 20;

export class Monde {
  t: Date;
  readonly commandes = new Map<string, CommandeMonde>();
  readonly courses = new Map<string, CourseMonde>();
  readonly livreurs = new Map<string, LivreurMonde>();
  readonly historique: { t: Date; plan: PlanRestaurant }[] = [];
  readonly violations: string[] = [];
  /** Toutes les retenues vues : course, valeur, limite d'attente de ses commandes. */
  readonly retenuesVues: { course: string; t: Date; jusqua: Date; limite: Date }[] = [];
  /** Temps morts plus fins, en secondes (voir l'en-tête). */
  readonly tempsMort = { courseDUnAutreLivreur: 0, offreLointaine: 0, expireeSeulement: 0 };
  private pasCourantS = 10;
  private evenements: Evenement[] = [];
  private numeroCourse = 0;
  private numeroOffre = 0;

  constructor(
    debut: Date,
    readonly reglages: ReglagesPlanification = REGLAGES_PLANIFICATION_DEFAUT,
    readonly options: { positionsCommeLAppli?: boolean } = {},
  ) {
    this.t = debut;
  }

  // ── Mise en place ──

  livreur(id: string, o: OptionsLivreurMonde = {}): this {
    const libre = o.libreDepuis === undefined ? this.t : o.libreDepuis;
    this.livreurs.set(id, {
      id,
      position: o.position === undefined ? R : o.position,
      position_at: this.t,
      reel: o.position === undefined ? R : o.position,
      pause_until: o.pause_until ?? null,
      auto_pause_until: null,
      last_available_at: libre,
      protocole_appli: o.protocole_appli ?? 3,
      courses_du_jour: 0,
      delaiAcceptationS: o.delaiAcceptationS ?? 10,
      delaiDepartS: o.delaiDepartS ?? 60,
    });
    return this;
  }

  /** Commande créée à `creee`, en préparation à `enPrep` (fin annoncée par la cuisine ou non), prête à `prete`. */
  commande(
    id: string,
    o: { est?: number; nord?: number; creee: Date; enPreparation: Date; prete: Date | null; finCuisine?: Date | null },
  ): this {
    this.commandes.set(id, {
      id,
      reference: `CMD-${id.toUpperCase()}`,
      statut: OrderStatus.ACCEPTED,
      position: decale(R, o.nord ?? 0, o.est ?? 2000),
      created_at: o.creee,
      prepared_at: null,
      ready_at: null,
      fin_cuisine: null,
      course_id: null,
      remise_at: null,
      livree_at: null,
      turbo: false,
    });
    this.prevoir(o.enPreparation, () => {
      const c = this.commandes.get(id)!;
      if (c.statut !== OrderStatus.ACCEPTED) return;
      c.statut = OrderStatus.IN_PROGRESS;
      c.prepared_at = o.enPreparation;
      c.fin_cuisine = o.finCuisine ?? null;
    });
    if (o.prete) {
      this.prevoir(o.prete, () => {
        const c = this.commandes.get(id)!;
        if (c.statut !== OrderStatus.ACCEPTED && c.statut !== OrderStatus.IN_PROGRESS) return;
        c.statut = OrderStatus.READY;
        c.ready_at = o.prete;
      });
    }
    return this;
  }

  prevoir(a: Date, faire: () => void): this {
    this.evenements.push({ a, faire });
    this.evenements.sort((x, y) => x.a.getTime() - y.a.getTime());
    return this;
  }

  /** Une course déjà là (créée avant), sans livreur. */
  courseExistante(id: string, commandes: string[], o: { creee?: Date } = {}): this {
    const course = this.nouvelleCourse(commandes, o.creee ?? this.t, id);
    for (const oid of commandes) this.commandes.get(oid)!.course_id = course.id;
    return this;
  }

  /** Le livreur revient au comptoir et se remet en service (fin de pause, retour, appli rouverte). */
  reprendre(id: string): void {
    const l = this.livreurs.get(id)!;
    l.pause_until = null;
    l.auto_pause_until = null;
    l.last_available_at = this.t;
    l.position = R;
    l.position_at = this.t;
    l.reel = R;
  }

  /**
   * Un livreur déjà en tournée : sa course (commandes déjà prêtes) est partie
   * à `partiA`. Il revient seul au restaurant à la fin de sa tournée.
   */
  courseEnTournee(livreurId: string, orderIds: string[], partiA: Date): this {
    const k = this.nouvelleCourse(orderIds, partiA);
    k.statut = CourseStatut.IN_DELIVERY;
    k.deliverer_id = livreurId;
    k.assigned_at = partiA;
    k.picked_up_at = partiA;
    for (const oid of orderIds) {
      const c = this.commandes.get(oid)!;
      c.course_id = k.id;
      c.statut = OrderStatus.PICKED_UP;
      c.ready_at = c.ready_at ?? partiA;
      c.remise_at = partiA;
    }
    const l = this.livreurs.get(livreurId)!;
    l.last_available_at = null;
    const maintenant = this.t;
    this.t = partiA;
    this.partir(k);
    this.t = maintenant;
    return this;
  }

  // ── Instantané lu par le planificateur ──

  instantane(): InstantanePlanification {
    const maintenant = this.t;
    const commandePlanif = (c: CommandeMonde): CommandePlanif => ({
      id: c.id,
      reference: c.reference,
      statut: c.statut,
      delivery_service: DeliveryService.CHICKEN_NATION,
      client: { id: c.id, position: c.position, routeMetres: null, trace: null },
      created_at: c.created_at,
      ready_at: c.ready_at,
      heure_programmee: null,
      preparation: estimerFinPreparation(
        { status: c.statut, prepared_at: c.prepared_at, estimated_preparation_time: c.fin_cuisine },
        null,
        maintenant,
      ),
    });
    const ouverts: CourseStatut[] = [
      CourseStatut.PENDING_ASSIGNMENT,
      CourseStatut.ACCEPTED,
      CourseStatut.AT_RESTAURANT,
      CourseStatut.IN_DELIVERY,
    ];
    const courses = [...this.courses.values()].filter((k) => ouverts.includes(k.statut));
    return {
      maintenant,
      restaurant: { id: RESTO, position: R },
      commandes: [...this.commandes.values()]
        .filter(
          (c) =>
            !c.course_id &&
            !c.turbo &&
            (c.statut === OrderStatus.READY || c.statut === OrderStatus.IN_PROGRESS),
        )
        .map(commandePlanif),
      courses: courses.map((k) => ({
        id: k.id,
        reference: k.reference,
        statut: k.statut,
        deliverer_id: k.deliverer_id,
        turbo_escalated_at: k.turbo_escalated_at,
        created_at: k.created_at,
        assigned_at: k.assigned_at,
        picked_up_at: k.picked_up_at,
        parti_at: k.parti_at,
        retenue_jusqua: k.retenue_jusqua,
        commandes_attendues: [...k.commandes_attendues],
        offre: k.offre ? { id: k.offre.id, deliverer_id: k.offre.deliverer_id, expires_at: k.offre.expires_at } : null,
        deja_sollicites: [...k.deja_sollicites],
        expirees: k.expirees.map((e) => ({ ...e })),
        livraisons: k.livraisons.map((l) => ({
          id: l.id,
          statut: l.statut,
          sequence_order: l.sequence_order,
          ajoutee_apres_retrait: l.ajoutee_apres_retrait,
          commande: commandePlanif(this.commandes.get(l.order_id)!),
        })),
      })),
      livreurs: [...this.livreurs.values()].map((l) => ({
        id: l.id,
        etat: this.etat(l),
        position: l.position,
        position_at: l.position_at,
        protocole_appli: l.protocole_appli,
        queue_penalty_until: null,
        queue_penalty_positions: 0,
        courses_du_jour: l.courses_du_jour,
      })),
    };
  }

  etat(l: LivreurMonde): EtatLivreur {
    const enCourse = [...this.courses.values()].some(
      (k) =>
        k.deliverer_id === l.id &&
        (k.statut === CourseStatut.ACCEPTED || k.statut === CourseStatut.AT_RESTAURANT || k.statut === CourseStatut.IN_DELIVERY),
    );
    return {
      status: DelivererStatus.ACTIVE,
      is_operational: true,
      entity_status: EntityStatus.ACTIVE,
      pause_until: l.pause_until,
      auto_pause_until: l.auto_pause_until,
      last_available_at: l.last_available_at,
      en_course: enCourse,
      offre_en_attente: [...this.courses.values()].some((k) => k.offre?.deliverer_id === l.id),
    };
  }

  // ── Un pas : événements, livreurs et caisse, puis planificateur ──

  /** Avance jusqu'à `fin` par pas de `pasS` secondes ; à chaque pas : événements, monde, planificateur. */
  jusqua(fin: Date, pasS = 10): this {
    this.pasCourantS = pasS;
    while (this.t.getTime() < fin.getTime()) {
      this.t = plus(this.t, pasS);
      this.pas();
    }
    return this;
  }

  /**
   * Un pas au temps courant (sans avancer) : les événements prévus (cuisine,
   * pauses), le planificateur aussitôt (déclenchement par événement), puis
   * les livreurs et la caisse, puis le planificateur encore (tâche de 10 s).
   */
  pas(): PlanRestaurant {
    while (this.evenements.length && this.evenements[0].a.getTime() <= this.t.getTime()) this.evenements.shift()!.faire();
    this.passage();
    this.fairevivre();
    const plan = this.passage();
    this.controlerTempsMort();
    return plan;
  }

  /** Un passage du planificateur, appliqué. */
  passage(): PlanRestaurant {
    const plan = planifier(this.instantane(), this.reglages);
    this.historique.push({ t: this.t, plan });
    this.appliquer(plan);
    return plan;
  }

  private fairevivre(): void {
    const t = this.t.getTime();
    for (const k of this.courses.values()) {
      // Offre : acceptée après le délai du livreur, ou expirée.
      if (k.offre) {
        const l = this.livreurs.get(k.offre.deliverer_id)!;
        if (t >= k.offre.offered_at.getTime() + l.delaiAcceptationS * 1000) {
          const accepte = k.statut === CourseStatut.PENDING_ASSIGNMENT && !k.turbo_escalated_at;
          k.offre = null;
          if (accepte) {
            k.statut = CourseStatut.ACCEPTED;
            k.deliverer_id = l.id;
            k.assigned_at = this.t;
            l.last_available_at = null;
            // En course, l'appli envoie sa position (suivi de la course) : le serveur le voit où il est.
            l.position = l.reel;
            l.position_at = this.t;
            const distance = l.reel ? haversineMeters(l.reel, R) : 3000;
            if (distance <= 200) {
              k.statut = CourseStatut.AT_RESTAURANT;
              k.au_restaurant_ms = t;
            } else {
              k.arrivee_resto_ms = t + ((distance * 1.3) / (VITESSE_MONDE_KMH / 3.6)) * 1000;
            }
          }
        } else if (t >= k.offre.expires_at.getTime()) {
          k.expirees.push({ deliverer_id: k.offre.deliverer_id, a: this.t });
          k.offre = null;
        }
      }
      if (k.statut === CourseStatut.ACCEPTED && k.arrivee_resto_ms !== null && k.arrivee_resto_ms <= t) {
        k.statut = CourseStatut.AT_RESTAURANT;
        k.au_restaurant_ms = t;
        const l = this.livreurs.get(k.deliverer_id!)!;
        l.position = R;
        l.position_at = this.t;
        l.reel = R;
      }
      const retenue = k.retenue_jusqua !== null && k.retenue_jusqua.getTime() > t;
      const actives = k.livraisons.filter((x) => x.statut !== DeliveryStatut.CANCELLED);
      // Caisse : remise dès que tout est prêt et que rien n'est attendu.
      const codePresente = k.au_restaurant_ms !== null && t >= k.au_restaurant_ms + DELAI_REMISE_S * 1000;
      if (k.statut === CourseStatut.AT_RESTAURANT && codePresente && !retenue && actives.length > 0) {
        const toutPret = actives.every((x) => this.commandes.get(x.order_id)!.statut === OrderStatus.READY);
        if (toutPret) {
          k.statut = CourseStatut.IN_DELIVERY;
          k.picked_up_at = this.t;
          for (const x of actives) this.remettre(x.order_id);
          const l = this.livreurs.get(k.deliverer_id!)!;
          if (l.protocole_appli < 3) this.partir(k);
          else k.depart_prevu_ms = t + l.delaiDepartS * 1000;
        }
      }
      // Récupérée, encore au restaurant : la caisse remet l'ajout, puis « Je pars ».
      if (k.statut === CourseStatut.IN_DELIVERY && !k.parti_at) {
        for (const x of actives) {
          const c = this.commandes.get(x.order_id)!;
          if (c.statut === OrderStatus.READY) this.remettre(c.id);
        }
        const resteARemettre = actives.some((x) => this.commandes.get(x.order_id)!.statut === OrderStatus.READY);
        if (!retenue && !resteARemettre && k.depart_prevu_ms !== null && t >= k.depart_prevu_ms) this.partir(k);
      }
      // Tournée.
      if (k.statut === CourseStatut.IN_DELIVERY && k.parti_at) {
        for (const x of k.livraisons) {
          if (x.statut === DeliveryStatut.PENDING && x.livree_ms !== null && x.livree_ms <= t) {
            x.statut = DeliveryStatut.DELIVERED;
            const c = this.commandes.get(x.order_id)!;
            c.statut = OrderStatus.COMPLETED;
            c.livree_at = new Date(x.livree_ms);
          }
        }
        if (k.livraisons.every((x) => x.statut !== DeliveryStatut.PENDING)) k.statut = CourseStatut.COMPLETED;
      }
      if (k.statut === CourseStatut.COMPLETED && k.retour_ms !== null && k.retour_ms <= t && k.deliverer_id) {
        const l = this.livreurs.get(k.deliverer_id)!;
        // Hors course, appli fermée, l'appli d'aujourd'hui n'envoie rien : le
        // planificateur ne le voit pas revenir.
        l.reel = R;
        if (!this.options.positionsCommeLAppli) {
          l.position = R;
          l.position_at = this.t;
        }
        l.last_available_at = this.t;
        l.courses_du_jour++;
        k.retour_ms = null;
      }
    }
  }

  private remettre(orderId: string): void {
    const c = this.commandes.get(orderId)!;
    c.statut = OrderStatus.PICKED_UP;
    c.remise_at = this.t;
  }

  private partir(k: CourseMonde): void {
    if (k.parti_at) return;
    k.parti_at = this.t;
    k.depart_prevu_ms = null;
    const mps = VITESSE_MONDE_KMH / 3.6;
    let t = this.t.getTime();
    let point = R;
    for (const x of [...k.livraisons].sort((a, b) => a.sequence_order - b.sequence_order)) {
      if (x.statut !== DeliveryStatut.PENDING) continue;
      const p = this.commandes.get(x.order_id)!.position ?? R;
      t += ((haversineMeters(point, p) * 1.4) / mps) * 1000 + 180_000;
      x.livree_ms = t;
      point = p;
    }
    k.retour_ms = t + ((haversineMeters(point, R) * 1.4) / mps) * 1000;
    const l = k.deliverer_id ? this.livreurs.get(k.deliverer_id) : undefined;
    if (l) {
      l.position = decale(R, 0, 400);
      l.position_at = this.t;
      l.reel = l.position;
    }
  }

  private nouvelleCourse(orderIds: string[], creee: Date, id?: string): CourseMonde {
    const n = ++this.numeroCourse;
    const course: CourseMonde = {
      id: id ?? `K${n}`,
      reference: `CRS-${id ?? `K${n}`}`,
      statut: CourseStatut.PENDING_ASSIGNMENT,
      deliverer_id: null,
      turbo_escalated_at: null,
      created_at: creee,
      assigned_at: null,
      picked_up_at: null,
      parti_at: null,
      retenue_jusqua: null,
      commandes_attendues: [],
      offre: null,
      deja_sollicites: [],
      expirees: [],
      livraisons: orderIds.map((oid, i) => ({
        id: `liv-${oid}`,
        order_id: oid,
        statut: DeliveryStatut.PENDING,
        sequence_order: i + 1,
        ajoutee_apres_retrait: false,
        livree_ms: null,
      })),
      arrivee_resto_ms: null,
      au_restaurant_ms: null,
      depart_prevu_ms: null,
      retour_ms: null,
    };
    this.courses.set(course.id, course);
    return course;
  }

  // ── Application des actions, avec leurs invariants ──

  private violation(texte: string): void {
    this.violations.push(`${hms(this.t)} ${texte}`);
  }

  private cibleInterdite(k: CourseMonde, quoi: string): void {
    if (k.turbo_escalated_at) this.violation(`${quoi} vers une course confiée à Turbo (${k.id})`);
    if (k.deliverer_id) {
      const l = this.livreurs.get(k.deliverer_id)!;
      if (estEnPause(this.etat(l), this.t) || estEnPauseAuto(this.etat(l), this.t)) {
        this.violation(`${quoi} vers la course d'un livreur en pause (${k.id})`);
      }
    }
    if (k.parti_at) this.violation(`${quoi} vers une course partie (${k.id})`);
  }

  private appliquer(plan: PlanRestaurant): void {
    const cles = new Map<string, string>();
    for (const a of plan.actions) {
      switch (a.type) {
        case 'MARQUER_PARTI': {
          const k = this.courses.get(a.course_id)!;
          this.partir(k);
          break;
        }
        case 'DETACHER': {
          const k = this.courses.get(a.course_id)!;
          k.livraisons = k.livraisons.filter((x) => x.order_id !== a.order_id);
          this.commandes.get(a.order_id)!.course_id = null;
          break;
        }
        case 'AJOUTER': {
          const k = this.courses.get(a.course_id)!;
          this.cibleInterdite(k, 'Ajout');
          const c = this.commandes.get(a.order_id)!;
          if (c.course_id) this.violation(`${a.order_id} ajoutée alors qu'elle a déjà une course`);
          if (c.statut !== OrderStatus.READY) this.violation(`${a.order_id} ajoutée sans être prête`);
          c.course_id = k.id;
          k.livraisons.push({
            id: `liv-${a.order_id}`,
            order_id: a.order_id,
            statut: DeliveryStatut.PENDING,
            sequence_order: k.livraisons.length + 1,
            ajoutee_apres_retrait: k.statut === CourseStatut.IN_DELIVERY,
            livree_ms: null,
          });
          if (k.statut === CourseStatut.IN_DELIVERY && this.livreurs.get(k.deliverer_id!)!.protocole_appli < 3) {
            this.violation(`ajout après retrait à une ancienne appli (${k.id})`);
          }
          this.controlerTaille(k);
          break;
        }
        case 'CREER_COURSE': {
          const k = this.nouvelleCourse(a.sequence, this.t);
          for (const oid of a.order_ids) {
            const c = this.commandes.get(oid)!;
            if (c.course_id) this.violation(`${oid} mise dans une nouvelle course alors qu'elle en a une`);
            c.course_id = k.id;
          }
          cles.set(a.cle, k.id);
          this.controlerTaille(k);
          break;
        }
        case 'FUSIONNER': {
          const cible = this.courses.get(a.cible_id)!;
          const absorbee = this.courses.get(a.absorbee_id)!;
          this.cibleInterdite(cible, 'Fusion');
          if (absorbee.deliverer_id || absorbee.turbo_escalated_at || absorbee.statut !== CourseStatut.PENDING_ASSIGNMENT) {
            this.violation(`fusion d'une course affectée ou confiée à Turbo (${absorbee.id})`);
          }
          for (const x of absorbee.livraisons.filter((y) => y.statut !== DeliveryStatut.CANCELLED)) {
            cible.livraisons.push({ ...x, sequence_order: cible.livraisons.length + 1 });
            this.commandes.get(x.order_id)!.course_id = cible.id;
          }
          absorbee.livraisons = [];
          absorbee.statut = CourseStatut.CANCELLED;
          absorbee.offre = null; // close sans pénalité
          this.controlerTaille(cible);
          break;
        }
        case 'ORDONNER': {
          const k = this.courses.get(a.course_id)!;
          a.sequence.forEach((oid, i) => {
            const x = k.livraisons.find((y) => y.order_id === oid);
            if (x) x.sequence_order = i + 1;
          });
          break;
        }
        case 'OFFRIR': {
          const id = a.course_id ?? cles.get(a.course_cle)!;
          const k = this.courses.get(id)!;
          const l = this.livreurs.get(a.deliverer_id)!;
          const d = peutRecevoirOffre(this.etat(l), this.t);
          if (!d.ok) this.violation(`offre à ${l.id} qui ne peut pas la recevoir (${d.motif})`);
          if (k.offre) this.violation(`deuxième offre sur ${k.id}`);
          if (this.exclu(k, l)) this.violation(`offre à ${l.id} déjà sollicité pour ${k.id}`);
          k.offre = { id: `offre-${++this.numeroOffre}`, deliverer_id: l.id, offered_at: this.t, expires_at: plus(this.t, 120) };
          break;
        }
        case 'RETENIR': {
          const k = this.courses.get(a.course_id)!;
          const limite = Math.min(
            ...k.livraisons.map((x) => (this.commandes.get(x.order_id)!.ready_at?.getTime() ?? Infinity) + this.reglages.attenteMaxCommandePreteS * 1000),
          );
          if (a.jusqua.getTime() > limite) this.violation(`retenue de ${k.id} au-delà de la limite`);
          if (k.retenue_jusqua && a.jusqua.getTime() > k.retenue_jusqua.getTime()) this.violation(`retenue de ${k.id} repoussée`);
          if (k.retenue_jusqua && k.retenue_jusqua.getTime() <= this.t.getTime()) this.violation(`retenue de ${k.id} reposée`);
          k.retenue_jusqua = a.jusqua;
          k.commandes_attendues = a.attendues.map((x) => x.order_id);
          this.retenuesVues.push({ course: k.id, t: this.t, jusqua: a.jusqua, limite: new Date(limite) });
          break;
        }
        case 'LIBERER': {
          const k = this.courses.get(a.course_id)!;
          k.retenue_jusqua = a.jusqua;
          k.commandes_attendues = [];
          break;
        }
        case 'CONFIER_TURBO': {
          const k = this.courses.get(a.course_id)!;
          if (k.offre) this.violation(`Turbo pendant une offre en attente (${k.id})`);
          k.turbo_escalated_at = this.t;
          for (const x of k.livraisons) this.commandes.get(x.order_id)!.turbo = true;
          break;
        }
      }
    }
  }

  private controlerTaille(k: CourseMonde): void {
    const n = k.livraisons.filter((x) => x.statut !== DeliveryStatut.CANCELLED).length;
    if (n > this.reglages.maxCommandesParCourse) this.violation(`${k.id} a ${n} commandes`);
  }

  /** Le livreur ne recevra plus cette course : refus, ou expiration sans signe de vie depuis (règle du planificateur). */
  private exclu(k: CourseMonde, l: LivreurMonde): boolean {
    if (k.deja_sollicites.includes(l.id)) return true;
    return k.expirees.some((e) => e.deliverer_id === l.id && !(l.position_at && l.position_at.getTime() > e.a.getTime()));
  }

  /**
   * Zéro temps mort : jamais un livreur libre ET une course sans livreur ni
   * offre qu'il pourrait prendre. Les temps morts plus fins (voir l'en-tête)
   * sont comptés en secondes.
   */
  private controlerTempsMort(): void {
    const enAttente = [...this.courses.values()].filter(
      (k) => k.statut === CourseStatut.PENDING_ASSIGNMENT && !k.deliverer_id && !k.turbo_escalated_at && !k.offre && k.livraisons.length > 0,
    );
    const auComptoir = (l: LivreurMonde) => !!l.reel && haversineMeters(l.reel, R) <= 200;
    const pretes = (k: CourseMonde) => k.livraisons.some((x) => this.commandes.get(x.order_id)?.statut === OrderStatus.READY);
    const fins = { courseDUnAutreLivreur: false, offreLointaine: false, expireeSeulement: false };
    for (const l of this.livreurs.values()) {
      if (!peutRecevoirOffre(this.etat(l), this.t).ok) continue;
      const k = enAttente.find((c) => !this.exclu(c, l));
      if (k) this.violation(`temps mort : ${l.id} libre et ${k.id} attend sans offre`);
      if (!auComptoir(l)) continue;
      for (const c of this.courses.values()) {
        if (!pretes(c)) continue;
        if (c.statut === CourseStatut.ACCEPTED && c.deliverer_id && c.deliverer_id !== l.id) {
          const autre = this.livreurs.get(c.deliverer_id)!;
          if (!auComptoir(autre)) fins.courseDUnAutreLivreur = true;
        }
        if (c.statut === CourseStatut.PENDING_ASSIGNMENT && c.offre && c.offre.deliverer_id !== l.id) {
          const autre = this.livreurs.get(c.offre.deliverer_id)!;
          const loin = autre.reel ? (haversineMeters(autre.reel, R) * 1.3) / (VITESSE_MONDE_KMH / 3.6) > 120 : true;
          if (loin) fins.offreLointaine = true;
        }
        if (
          c.statut === CourseStatut.PENDING_ASSIGNMENT &&
          !c.offre &&
          !c.turbo_escalated_at &&
          !c.deja_sollicites.includes(l.id) &&
          c.expirees.some((e) => e.deliverer_id === l.id) &&
          this.exclu(c, l)
        ) {
          fins.expireeSeulement = true;
        }
      }
    }
    for (const cle of Object.keys(fins) as (keyof typeof fins)[]) if (fins[cle]) this.tempsMort[cle] += this.pasCourantS;
  }

  // ── Lecture pour les tests ──

  /** Actions d'un type dans tout l'historique, avec leur heure. */
  toutes<T extends ActionPlanification['type']>(type: T): { t: Date; action: Extract<ActionPlanification, { type: T }> }[] {
    return this.historique.flatMap(({ t, plan }) =>
      plan.actions
        .filter((a): a is Extract<ActionPlanification, { type: T }> => a.type === type)
        .map((action) => ({ t, action })),
    );
  }

  courseDe(orderId: string): CourseMonde | null {
    const id = this.commandes.get(orderId)?.course_id;
    return id ? this.courses.get(id) ?? null : null;
  }
}
