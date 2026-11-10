import { CourseStatut, DeliveryStatut, EntityStatus, OrderStatus } from '@prisma/client';

import { STATUTS_LIVRAISON_TERMINEE } from './remise-course.rules';
import { CourseTourneeLue, finTourneePrevue, retardMin } from './retard-tournee.rules';

/**
 * COURSES « EN DIRECT » (demande du 10/11) : le kanban de l'écran Courses.
 * Règles pures ; lectures dans `CoursesEnDirectService`.
 *
 * Cinq colonnes, une carte par course de la journée de service :
 *  - À affecter : en recherche (sans livreur), ou « Aucun livreur trouvé »
 *    avec encore une commande à livrer ;
 *  - Vers le restaurant : acceptée ;
 *  - Au restaurant ;
 *  - En livraison : retard compté par la règle commune (`retardMin`) ;
 *  - Terminées : terminées dans la journée, les plus récentes d'abord.
 *
 * Les courses restées ouvertes d'une journée passée n'y sont pas : elles sont
 * comptées à part au tableau de la livraison (« Les fermer »).
 */

export type ColonneEnDirect = 'A_AFFECTER' | 'VERS_RESTAURANT' | 'AU_RESTAURANT' | 'EN_LIVRAISON' | 'TERMINEE';

export const COLONNES_EN_DIRECT: readonly ColonneEnDirect[] = [
  'A_AFFECTER',
  'VERS_RESTAURANT',
  'AU_RESTAURANT',
  'EN_LIVRAISON',
  'TERMINEE',
];

/** Terminées montrées au plus : le reste est dans l'historique. */
export const TERMINEES_MONTREES_MAX = 30;

type DateLue = Date | string | null | undefined;

/** Ce que les règles lisent d'une course. */
export interface CourseEnDirectLue extends CourseTourneeLue {
  id: string;
  reference: string;
  pickup_code: string | null;
  statut: CourseStatut;
  restaurant: { id: string; name: string | null };
  deliverer: { id: string; first_name: string | null; last_name: string | null; phone: string | null } | null;
  turbo_escalated_at: DateLue;
  created_at: DateLue;
  assigned_at: DateLue;
  at_restaurant_at: DateLue;
  completed_at: DateLue;
  total_delivery_fee: number | null;
  deliveries: Array<{
    statut: DeliveryStatut;
    order: { reference: string; status: OrderStatus; entity_status: EntityStatus };
  }>;
  /** Offre en attente : à qui elle est proposée (recherche en cours). */
  offer_attempts?: Array<{ deliverer: { first_name: string | null } | null }>;
}

/** Une carte du kanban. */
export interface CourseEnDirect {
  id: string;
  reference: string;
  code: string | null;
  statut: CourseStatut;
  colonne: ColonneEnDirect;
  restaurant: { id: string; nom: string | null };
  livreur: { id: string; prenom: string | null; nom: string | null; telephone: string | null } | null;
  /** Confiée à Turbo : le livreur ne se change pas ici. */
  turbo: boolean;
  /** « Aucun livreur trouvé » (recherche finie). */
  expiree: boolean;
  /** Offre en attente chez ce livreur (prénom), recherche en cours. */
  proposee_a: string | null;
  commandes: { total: number; livrees: number; references: string[] };
  /** Début de l'étape de la colonne (ISO) : création, acceptation, arrivée, départ, fin. */
  depuis: string | null;
  /** En livraison : fin prévue de la tournée (ISO) et retard au-delà, en minutes. */
  fin_prevue: string | null;
  retard_min: number | null;
  frais: number;
  /** Le livreur peut encore être changé : sans Turbo, avant le départ du restaurant. */
  livreur_modifiable: boolean;
}

export interface CoursesEnDirect {
  genere_a: string;
  courses: CourseEnDirect[];
  /** Terminées de la journée en tout (seules les plus récentes sont dans `courses`). */
  terminees_total: number;
}

const lireDate = (v: DateLue): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const iso = (v: DateLue): string | null => lireDate(v)?.toISOString() ?? null;

const STATUTS_COMMANDE_VIVANTE: OrderStatus[] = [
  OrderStatus.ACCEPTED,
  OrderStatus.IN_PROGRESS,
  OrderStatus.READY,
  OrderStatus.PICKED_UP,
];

/** Statuts où le livreur se change encore : personne n'est parti avec les sacs. */
export const STATUTS_LIVREUR_MODIFIABLE: CourseStatut[] = [
  CourseStatut.PENDING_ASSIGNMENT,
  CourseStatut.EXPIRED,
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
];

export function colonneDe(statut: CourseStatut): ColonneEnDirect | null {
  switch (statut) {
    case CourseStatut.PENDING_ASSIGNMENT:
    case CourseStatut.EXPIRED:
      return 'A_AFFECTER';
    case CourseStatut.ACCEPTED:
      return 'VERS_RESTAURANT';
    case CourseStatut.AT_RESTAURANT:
      return 'AU_RESTAURANT';
    case CourseStatut.IN_DELIVERY:
      return 'EN_LIVRAISON';
    case CourseStatut.COMPLETED:
      return 'TERMINEE';
    default:
      return null;
  }
}

/** Une commande attend encore sa livraison (ni livrée, ni annulée, ni supprimée). */
export function aUneCommandeVivante(c: Pick<CourseEnDirectLue, 'deliveries'>): boolean {
  return c.deliveries.some(
    (l) =>
      !STATUTS_LIVRAISON_TERMINEE.includes(l.statut) &&
      STATUTS_COMMANDE_VIVANTE.includes(l.order.status) &&
      l.order.entity_status !== EntityStatus.DELETED,
  );
}

function depuisDeLaColonne(c: CourseEnDirectLue, colonne: ColonneEnDirect): string | null {
  switch (colonne) {
    case 'A_AFFECTER':
      return iso(c.created_at);
    case 'VERS_RESTAURANT':
      return iso(c.assigned_at) ?? iso(c.created_at);
    case 'AU_RESTAURANT':
      return iso(c.at_restaurant_at) ?? iso(c.assigned_at);
    case 'EN_LIVRAISON':
      return iso(c.parti_at) ?? iso(c.picked_up_at);
    default:
      return iso(c.completed_at);
  }
}

export function carteEnDirect(c: CourseEnDirectLue, maintenant: Date, facteurRetard: number): CourseEnDirect | null {
  const colonne = colonneDe(c.statut);
  if (!colonne) return null;
  const turbo = !!lireDate(c.turbo_escalated_at);
  const enLivraison = colonne === 'EN_LIVRAISON';
  const proposee = c.statut === CourseStatut.PENDING_ASSIGNMENT ? c.offer_attempts?.[0]?.deliverer?.first_name ?? null : null;
  return {
    id: c.id,
    reference: c.reference,
    code: c.pickup_code,
    statut: c.statut,
    colonne,
    restaurant: { id: c.restaurant.id, nom: c.restaurant.name },
    livreur: c.deliverer
      ? { id: c.deliverer.id, prenom: c.deliverer.first_name, nom: c.deliverer.last_name, telephone: c.deliverer.phone }
      : null,
    turbo,
    expiree: c.statut === CourseStatut.EXPIRED,
    proposee_a: proposee,
    commandes: {
      total: c.deliveries.filter((l) => l.order.entity_status !== EntityStatus.DELETED).length,
      livrees: c.deliveries.filter((l) => l.statut === DeliveryStatut.DELIVERED).length,
      references: c.deliveries.map((l) => l.order.reference),
    },
    depuis: depuisDeLaColonne(c, colonne),
    fin_prevue: enLivraison ? iso(finTourneePrevue(c)) : null,
    retard_min: enLivraison ? retardMin(c, maintenant, facteurRetard) : null,
    frais: c.total_delivery_fee ?? 0,
    livreur_modifiable: !turbo && STATUTS_LIVREUR_MODIFIABLE.includes(c.statut),
  };
}

const temps = (v: string | null) => (v ? Date.parse(v) : Number.POSITIVE_INFINITY);

/**
 * Ordre dans chaque colonne : en livraison, le plus en retard d'abord ;
 * terminées, la plus récente d'abord ; ailleurs, la plus ancienne d'abord
 * (celle qui attend depuis le plus longtemps).
 */
export function comparerCartes(a: CourseEnDirect, b: CourseEnDirect): number {
  const rang = COLONNES_EN_DIRECT.indexOf(a.colonne) - COLONNES_EN_DIRECT.indexOf(b.colonne);
  if (rang !== 0) return rang;
  if (a.colonne === 'EN_LIVRAISON') {
    const retard = (b.retard_min ?? -1) - (a.retard_min ?? -1);
    if (retard !== 0) return retard;
  }
  if (a.colonne === 'TERMINEE') return temps(b.depuis) - temps(a.depuis) || a.reference.localeCompare(b.reference);
  return temps(a.depuis) - temps(b.depuis) || a.reference.localeCompare(b.reference);
}

export function construireCoursesEnDirect(e: {
  maintenant: Date;
  facteurRetard: number;
  courses: CourseEnDirectLue[];
  termineesTotal: number;
}): CoursesEnDirect {
  const cartes = e.courses
    .filter((c) => c.statut !== CourseStatut.EXPIRED || aUneCommandeVivante(c))
    .map((c) => carteEnDirect(c, e.maintenant, e.facteurRetard))
    .filter((c): c is CourseEnDirect => c !== null)
    .sort(comparerCartes);
  return { genere_a: e.maintenant.toISOString(), courses: cartes, terminees_total: e.termineesTotal };
}
