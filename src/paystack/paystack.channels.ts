/**
 * Événements internes de Paystack (25/11). Le module Paystack ne connaît ni
 * les commandes ni les paiements : il annonce, le module des commandes
 * confirme la commande, celui des paiements suit les remboursements.
 */
export enum PaystackChannels {
  /** Paiement réussi annoncé (webhook) : le traitement le revérifie chez Paystack. */
  PAIEMENT_A_CONFIRMER = 'paystack:paiement-a-confirmer',
  /** Remboursement dont le statut a changé chez Paystack. */
  REMBOURSEMENT = 'paystack:remboursement',
}

export interface EvenementPaiementPaystack {
  reference: string;
}

export interface EvenementRemboursementPaystack {
  /** Référence de la transaction remboursée. */
  reference: string;
  statut: string;
}

/** Issue rendue par le traitement d'un paiement (même forme que pour KKiaPay). */
export interface IssuePaiementPaystack {
  confirmed: boolean;
  reason?: string;
  orderReference?: string | null;
  restaurantId?: string | null;
}
