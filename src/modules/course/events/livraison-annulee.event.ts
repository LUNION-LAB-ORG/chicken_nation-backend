import { DeliveryFailureReason } from '@prisma/client';

/**
 * Événement INTERNE (bus EventEmitter2), jamais relayé aux sockets : le
 * livreur a annulé la livraison d'un client (« Annuler » de la feuille
 * « Problème », ou `/fail` de l'appli déjà installée). La commande n'est pas
 * touchée. Émis une seule fois, après l'écriture conditionnée de l'échec
 * (jamais pour un rejeu). Le module support l'écoute et crée le ticket du
 * livreur (`LivraisonAnnuleeListener`).
 */
export const LIVRAISON_ANNULEE_PAR_LIVREUR = 'livraison.annulee_par_livreur';

/** Route du livreur qui a annulé : la nouvelle (`/annuler`) ou celle de l'appli installée (`/fail`). */
export type OrigineAnnulationLivraison = 'annuler' | 'fail';

export interface LivraisonAnnuleeParLivreurPayload {
  delivery_id: string;
  order_id: string;
  order_reference: string;
  course_id: string;
  course_reference: string;
  restaurant_id: string | null;
  deliverer_id: string;
  reason: DeliveryFailureReason;
  note: string | null;
  route: OrigineAnnulationLivraison;
}

/** Motifs courts, les mêmes mots que le backoffice (`DELIVERY_FAILURE_LABELS`). */
export const MOTIF_COURT_ECHEC: Record<DeliveryFailureReason, string> = {
  CLIENT_ABSENT: 'Client absent',
  CLIENT_REFUSED: 'Client a refusé',
  ADDRESS_NOT_FOUND: 'Adresse introuvable',
  CLIENT_UNREACHABLE: 'Client injoignable',
  WRONG_ORDER: 'Mauvaise commande',
  OTHER: 'Autre',
};
