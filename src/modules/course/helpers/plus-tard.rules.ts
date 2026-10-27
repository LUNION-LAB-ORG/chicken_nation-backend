/**
 * « PLUS TARD », règle pure (demande du client du 27/10) : le livreur passe
 * un client qui pose problème (absent, injoignable), livre les autres, puis
 * revient sur lui en fin de tournée.
 *
 * La livraison passée repasse « en attente » (PENDING) et va en dernier ; la
 * suivante démarre aussitôt. Le nouvel ordre :
 *  1. les livraisons terminées (livrées, en échec), dans leur ordre ;
 *  2. la suivante : la première livraison livrable (en attente, commande
 *     remise au livreur), dans l'ordre d'aujourd'hui ;
 *  3. les autres livraisons en attente, dans leur ordre ;
 *  4. la livraison reportée ;
 *  5. les annulées.
 * Aucun calcul de route : la tournée prévue reste la bonne pour les autres.
 *
 * Une fois par livraison (`reportee_at`, gardée au redémarrage) : la limite
 * empêche le va-et-vient entre deux clients absents. Jamais sur la dernière
 * restante : il reste « Livrer », les appels et « Terminer ».
 */
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { STATUTS_COMMANDE_REMISE } from './remise-course.rules';

export const MESSAGE_PAS_ENCORE_PARTI = 'Pas encore parti.';
export const MESSAGE_DEJA_REPORTEE = 'Déjà reportée une fois.';
export const MESSAGE_PLUS_D_AUTRE_CLIENT = "Plus d'autre client.";
/** Démarrer (ou passer) une livraison pendant qu'une autre est en route ou chez son client. */
export const MESSAGE_CLIENT_EN_COURS = "Termine d'abord le client en cours.";

/** Livraisons qu'on peut passer à plus tard : encore à faire. */
const A_FAIRE: DeliveryStatut[] = [DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED];
/** Livraison commencée : en route ou chez le client. */
const COMMENCEE: DeliveryStatut[] = [DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED];
const TERMINEE: DeliveryStatut[] = [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED];

export interface LivraisonPlusTard {
  id: string;
  statut: DeliveryStatut;
  sequence_order: number;
  reportee_at: Date | null;
  arrived_at?: Date | null;
  in_route_at?: Date | null;
  ajoutee_apres_retrait?: boolean | null;
  order: { status: OrderStatus; reference?: string | null };
}

export interface CoursePlusTard {
  deliverer_id: string | null;
  statut: CourseStatut;
  parti_at: Date | null;
  deliveries: readonly LivraisonPlusTard[];
}

export type DecisionPlusTard =
  | { type: 'REFUS'; code: 400 | 403 | 404 | 409; message: string }
  /** Déjà passée (réponse perdue, double toucher) : la course est rendue telle quelle. */
  | { type: 'REJEU' }
  | {
      type: 'REPORTER';
      reportee: {
        id: string;
        statut_avant: DeliveryStatut;
        rang_avant: number;
        rang_apres: number;
        /** Arrivée chez le client effacée (journal). */
        arrivee_avant: Date | null;
      };
      /** La suivante, et s'il faut la démarrer (elle peut déjà être en route : ancien état). */
      suivante: { id: string; a_demarrer: boolean };
      /** Nouveaux rangs de toutes les livraisons de la course, de 1 à N. */
      rangs: Map<string, number>;
      /** Les livraisons après le geste, dans le nouvel ordre (ce que l'appli affiche aussitôt). */
      livraisons: LivraisonPlusTard[];
    };

/**
 * Livraison livrable : en attente, commande remise au livreur. Un sac resté
 * au restaurant ou une commande ajoutée après le retrait et pas remise
 * (commande encore prête) ne l'est pas.
 */
export function livraisonLivrable(l: Pick<LivraisonPlusTard, 'statut' | 'order' | 'ajoutee_apres_retrait'>): boolean {
  if (l.statut !== DeliveryStatut.PENDING) return false;
  if (l.ajoutee_apres_retrait === true && l.order.status === OrderStatus.READY) return false;
  return STATUTS_COMMANDE_REMISE.includes(l.order.status);
}

const refus = (code: 400 | 403 | 404 | 409, message: string): DecisionPlusTard => ({ type: 'REFUS', code, message });

/**
 * Refus dans l'ordre des routes du livreur (inconnue, autre livreur, course
 * pas en livraison), puis « Pas encore parti. », livraison terminée, rejeu,
 * déjà reportée une fois, un autre client en cours, et plus aucun autre
 * client livrable.
 */
export function reglePlusTard(p: {
  livraisonId: string;
  delivererId: string;
  course: CoursePlusTard | null;
  maintenant: Date;
}): DecisionPlusTard {
  const k = p.course;
  const cible = k?.deliveries.find((l) => l.id === p.livraisonId) ?? null;
  if (!k || !cible) return refus(404, 'Delivery non trouvée');
  if (k.deliverer_id !== p.delivererId) return refus(403, 'Cette livraison ne vous est pas affectée');
  if (k.statut !== CourseStatut.IN_DELIVERY) return refus(400, 'La course doit être en phase IN_DELIVERY');
  if (!k.parti_at) return refus(409, MESSAGE_PAS_ENCORE_PARTI);
  if (!A_FAIRE.includes(cible.statut)) {
    return refus(400, `Statut delivery attendu ${A_FAIRE.join(' ou ')}, actuel ${cible.statut}`);
  }
  if (cible.reportee_at) {
    return cible.statut === DeliveryStatut.PENDING ? { type: 'REJEU' } : refus(409, MESSAGE_DEJA_REPORTEE);
  }

  const actuel = [...k.deliveries].sort((a, b) => a.sequence_order - b.sequence_order);
  const autres = actuel.filter((l) => l.id !== cible.id);
  const commencee = autres.find((l) => COMMENCEE.includes(l.statut)) ?? null;
  // En attente : seulement si c'est la prochaine (aucun autre client en cours).
  if (cible.statut === DeliveryStatut.PENDING && commencee) return refus(409, MESSAGE_CLIENT_EN_COURS);
  // Ancien état (deux livraisons en route) : la suivante est celle déjà commencée.
  const suivante = commencee ?? autres.find((l) => livraisonLivrable(l)) ?? null;
  if (!suivante) return refus(409, MESSAGE_PLUS_D_AUTRE_CLIENT);

  const ordre = [
    ...autres.filter((l) => TERMINEE.includes(l.statut)),
    suivante,
    ...autres.filter((l) => l !== suivante && (l.statut === DeliveryStatut.PENDING || COMMENCEE.includes(l.statut))),
    cible,
    ...autres.filter((l) => l.statut === DeliveryStatut.CANCELLED),
  ];
  const rangs = new Map(ordre.map((l, i) => [l.id, i + 1]));
  const aDemarrer = suivante.statut === DeliveryStatut.PENDING;
  const livraisons = ordre.map((l): LivraisonPlusTard => {
    const rang = rangs.get(l.id)!;
    if (l === cible) return { ...l, statut: DeliveryStatut.PENDING, arrived_at: null, reportee_at: p.maintenant, sequence_order: rang };
    if (l === suivante && aDemarrer) return { ...l, statut: DeliveryStatut.IN_ROUTE, in_route_at: p.maintenant, sequence_order: rang };
    return { ...l, sequence_order: rang };
  });
  return {
    type: 'REPORTER',
    reportee: {
      id: cible.id,
      statut_avant: cible.statut,
      rang_avant: cible.sequence_order,
      rang_apres: rangs.get(cible.id)!,
      arrivee_avant: cible.arrived_at ?? null,
    },
    suivante: { id: suivante.id, a_demarrer: aDemarrer },
    rangs,
    livraisons,
  };
}
