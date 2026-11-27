import { EntityStatus, OrderStatus, Prisma } from '@prisma/client';

/**
 * COMMANDES À NOTER (27/11), règles sans base, testées par jest.
 *
 * Demande du client : « si une commande est annulée ou supprimée, on doit
 * supprimer l'envoi de la note au client ; le client ne doit pas noter et
 * laisser un commentaire pour une commande qui n'a pas été terminée ».
 *
 * L'invitation à noter n'est pas une notification planifiée : l'appli lit la
 * liste des commandes à noter (`GET /marketing/app-mobile/orders-to-comment`)
 * et l'affiche à l'accueil. La liste ne regardait que le statut : une
 * commande terminée puis SUPPRIMÉE y restait. Une seule règle sert désormais
 * à la liste ET au dépôt de la note.
 */

/** Terminée : remise au client (à emporter, sur place) ou livrée. */
export const STATUTS_COMMANDE_TERMINEE: OrderStatus[] = [OrderStatus.COLLECTED, OrderStatus.COMPLETED];

/** L'invitation attend 30 minutes après la fin : le client a mangé. */
export const DELAI_AVANT_NOTE_MS = 30 * 60_000;

/** Ce que la règle lit d'une commande. */
export interface CommandeANoter {
  status: OrderStatus;
  entity_status: EntityStatus;
}

/** La commande peut-elle recevoir une note ? Terminée, et pas supprimée. */
export function commandeNotable(commande: CommandeANoter): boolean {
  return STATUTS_COMMANDE_TERMINEE.includes(commande.status) && commande.entity_status !== EntityStatus.DELETED;
}

/** Pourquoi la note est refusée, en clair pour le client ; `null` : elle est acceptée. */
export function refusDeNoter(commande: CommandeANoter): string | null {
  if (commande.entity_status === EntityStatus.DELETED || commande.status === OrderStatus.CANCELLED) {
    return 'Cette commande a été annulée : elle ne peut pas être notée.';
  }
  if (!STATUTS_COMMANDE_TERMINEE.includes(commande.status)) {
    return 'Vous ne pouvez commenter que les commandes terminées';
  }
  return null;
}

/**
 * Commandes que l'appli propose de noter : terminées depuis plus de trente
 * minutes, ni supprimées ni annulées, sans note.
 */
export function commandesANoterWhere(customerId: string, maintenant: Date = new Date()): Prisma.OrderWhereInput {
  const seuil = new Date(maintenant.getTime() - DELAI_AVANT_NOTE_MS);
  return {
    customer_id: customerId,
    status: { in: STATUTS_COMMANDE_TERMINEE },
    entity_status: { not: EntityStatus.DELETED },
    Comment: { none: {} },
    OR: [{ completed_at: { lte: seuil } }, { collected_at: { lte: seuil } }],
  };
}
