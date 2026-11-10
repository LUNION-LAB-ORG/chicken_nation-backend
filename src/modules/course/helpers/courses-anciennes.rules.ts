import { CourseStatut, DeliveryStatut, EntityStatus, OrderStatus } from '@prisma/client';

import { STATUTS_LIVRAISON_TERMINEE } from './remise-course.rules';

/**
 * COURSES RESTÉES OUVERTES D'UNE JOURNÉE PASSÉE (demande du 10/11), règles
 * pures.
 *
 * Constat : des courses du 27/10 au 30/10 encore « en livraison » faisaient
 * 40 des 45 alertes (« en retard de 341 h »). Leurs commandes ont été servies
 * ou annulées à la main avant la règle du 07/11 (terminer une commande
 * termine sa course), ou chez Turbo avant le correctif du 05/11. Le tableau
 * ne les montre plus en alerte (`estCourseAncienne`) ; l'administrateur les
 * ferme d'un geste.
 *
 * Même effet que la fin de chaque commande (`fermerLivraisonTerminee`, et
 * `fermerSuiviCommandeFinie` chez Turbo) : livraison d'une commande servie
 * fermée comme livrée, SANS heure de livraison (personne ne l'a validée, elle
 * fausserait la durée moyenne) ; livraison d'une commande annulée ou
 * supprimée annulée. Aucune commande n'est écrite, aucun appel à Turbo.
 *
 * Une course dont une commande vit encore (en cuisine, prête, en livraison)
 * est GARDÉE : la fermer rendrait la commande au planificateur, qui la
 * proposerait à un livreur deux semaines plus tard. Elle se regarde une par une.
 */

/** Commande servie : récupérée (à encaisser) ou terminée. */
const COMMANDE_SERVIE: OrderStatus[] = [OrderStatus.COLLECTED, OrderStatus.COMPLETED];

/** Ce que la fermeture lit d'une course. */
export interface CourseAncienneLue {
  id: string;
  deliveries: Array<{
    id: string;
    statut: DeliveryStatut;
    order: { status: OrderStatus; entity_status: EntityStatus };
  }>;
}

export interface FermetureCourseAncienne {
  course_id: string;
  /** Terminée si un client a été servi, sinon annulée. */
  statut: typeof CourseStatut.COMPLETED | typeof CourseStatut.CANCELLED;
  /** Livraisons à fermer comme livrées (commande servie). */
  livrees: string[];
  /** Livraisons à annuler (commande annulée ou supprimée). */
  annulees: string[];
}

/**
 * Comment fermer cette course ; `null` quand une de ses commandes vit encore
 * (elle est gardée).
 */
export function fermetureDeCourseAncienne(c: CourseAncienneLue): FermetureCourseAncienne | null {
  const livrees: string[] = [];
  const annulees: string[] = [];
  for (const l of c.deliveries) {
    if (STATUTS_LIVRAISON_TERMINEE.includes(l.statut)) continue;
    if (l.order.entity_status === EntityStatus.DELETED || l.order.status === OrderStatus.CANCELLED) annulees.push(l.id);
    else if (COMMANDE_SERVIE.includes(l.order.status)) livrees.push(l.id);
    else return null;
  }
  const servie = livrees.length > 0 || c.deliveries.some((l) => l.statut === DeliveryStatut.DELIVERED);
  return { course_id: c.id, statut: servie ? CourseStatut.COMPLETED : CourseStatut.CANCELLED, livrees, annulees };
}

/** Motif écrit sur une course annulée par ce geste. */
export const MOTIF_COURSE_ANCIENNE = "Restée ouverte d'une journée passée, fermée par l'administrateur";

/** « 38 courses fermées. 2 gardées : une de leurs commandes n'est pas terminée. » */
export function messageFermetureAnciennes(fermees: number, gardees: number): string {
  if (fermees === 0 && gardees === 0) return 'Aucune course des jours passés à fermer.';
  const debut =
    fermees === 0 ? 'Aucune course fermée.' : fermees === 1 ? '1 course fermée.' : `${fermees} courses fermées.`;
  if (gardees === 0) return debut;
  const fin =
    gardees === 1
      ? "1 gardée : une de ses commandes n'est pas terminée."
      : `${gardees} gardées : une de leurs commandes n'est pas terminée.`;
  return `${debut} ${fin}`;
}
