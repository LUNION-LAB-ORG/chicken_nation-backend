import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

/**
 * REMISE DES COMMANDES ET ANNULATION AUTOMATIQUE D'UNE COURSE, règles pures.
 *
 * Principe du projet : « une commande ne s'annule que manuellement ». Une
 * course bloquée annulée par la tâche automatique n'emporte donc JAMAIS les
 * commandes des clients :
 *  - une commande déjà remise au livreur (PICKED_UP et au-delà) reste telle
 *    quelle, et la course passe en livraison au lieu d'être annulée ;
 *  - une commande encore au restaurant (READY) est détachée et repart en
 *    recherche de livreur dans une NOUVELLE course.
 */

/** Course acceptée par un livreur, pas encore partie du restaurant. */
export const STATUTS_COURSE_AVANT_DEPART: CourseStatut[] = [
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
];

/** Commande remise au livreur (ou déjà livrée). */
export const STATUTS_COMMANDE_REMISE: OrderStatus[] = [
  OrderStatus.PICKED_UP,
  OrderStatus.COLLECTED,
  OrderStatus.COMPLETED,
];

/** Livraison terminée : plus rien à remettre ni à détacher. */
export const STATUTS_LIVRAISON_TERMINEE: DeliveryStatut[] = [
  DeliveryStatut.DELIVERED,
  DeliveryStatut.FAILED,
  DeliveryStatut.CANCELLED,
];

export interface LivraisonATrier {
  id: string;
  statut: DeliveryStatut;
  order: { id: string; reference: string; status: OrderStatus };
}

export interface TriAnnulationAuto<L extends LivraisonATrier> {
  /** Commandes déjà remises au livreur : gardées, la course part en livraison. */
  remises: L[];
  /** Commandes encore au restaurant : détachées, relancées dans une nouvelle course. */
  auRestaurant: L[];
  /** Le reste (commande annulée à la main, livraison terminée) : on n'y touche pas. */
  autres: L[];
}

export function trierCommandesAnnulationAuto<L extends LivraisonATrier>(livraisons: L[]): TriAnnulationAuto<L> {
  const tri: TriAnnulationAuto<L> = { remises: [], auRestaurant: [], autres: [] };
  for (const l of livraisons) {
    if (STATUTS_COMMANDE_REMISE.includes(l.order.status)) tri.remises.push(l);
    else if (l.order.status === OrderStatus.READY && !STATUTS_LIVRAISON_TERMINEE.includes(l.statut)) {
      tri.auRestaurant.push(l);
    } else tri.autres.push(l);
  }
  return tri;
}

/**
 * Ce que fait l'annulation automatique d'une course bloquée :
 *  - `EN_LIVRAISON` : au moins une commande est déjà remise, la course passe
 *    en livraison avec elles ;
 *  - `ANNULEE` : rien n'a été remis, la course est annulée (pas ses commandes).
 * Dans les deux cas, les commandes encore au restaurant sont relancées.
 */
export function issueAnnulationAuto(tri: TriAnnulationAuto<LivraisonATrier>): 'EN_LIVRAISON' | 'ANNULEE' {
  return tri.remises.length > 0 ? 'EN_LIVRAISON' : 'ANNULEE';
}

/**
 * Frais de livraison d'une course : somme des frais des commandes de ses
 * livraisons non annulées. À recalculer à chaque ajout ou retrait de livraison
 * (rééquilibrage), sinon le revenu des courses terminées est faux.
 */
export function fraisLivraisonCourse(
  livraisons: { statut: DeliveryStatut; order: { delivery_fee: number | null } }[],
): number {
  return livraisons
    .filter((l) => l.statut !== DeliveryStatut.CANCELLED)
    .reduce((somme, l) => somme + (l.order.delivery_fee ?? 0), 0);
}
