import { OrderStatus, UserRole } from '@prisma/client';

/**
 * QUI PEUT MODIFIER UNE COMMANDE, SELON SON STATUT (bouton « Modifier »).
 *
 * Doit rester identique à son jumeau côté écran :
 * `statutPermetModification` dans
 * `backoffice/features/orders/utils/order-actions-rules.ts`.
 *
 * Appliquée par `OrderService.update()`. `OrderController.update()` ne lève
 * cette garde (`skipStatusCheck`) que pour l'ADMIN ; le cas du centre
 * d'appels sur une commande annulée est décidé ici, pas dans le contrôleur.
 *
 * Le droit lui même (COMMANDES UPDATE_FULL) est contrôlé par la garde de la
 * route : ces règles ne portent que sur le statut de la commande.
 *
 *  - Tout rôle qui a le droit modifie une commande en attente, acceptée, en
 *    préparation ou prête.
 *  - Le CENTRE D'APPELS modifie AUSSI une commande annulée (demande du
 *    01/10). Elle RESTE annulée : la modification ne la réactive jamais
 *    (l'annulation a déjà rendu le bon, révoqué les points, décompté le code
 *    promo et remboursé le paiement). Ni terminée, ni récupérée, ni en
 *    livraison : celles là restent à l'administrateur.
 *  - L'ADMINISTRATEUR modifie une commande quel que soit son statut (erreur
 *    de saisie, audit comptable).
 */

/** Statuts modifiables par tout rôle qui a le droit de modifier une commande. */
export const STATUTS_MODIFIABLES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.IN_PROGRESS,
  OrderStatus.READY,
];

/** Rôles qui, en plus, modifient une commande annulée. L'administrateur passe partout. */
export const ROLES_MODIFIANT_UNE_COMMANDE_ANNULEE: readonly UserRole[] = [UserRole.CALL_CENTER];

type Role = UserRole | string | null | undefined;
type Statut = OrderStatus | string | null | undefined;

export function peutModifierCommande(role: Role, statut: Statut): boolean {
  if (role === UserRole.ADMIN) return true;
  if (!statut) return false;
  if ((STATUTS_MODIFIABLES as readonly string[]).includes(statut)) return true;
  return (
    statut === OrderStatus.CANCELLED &&
    !!role &&
    (ROLES_MODIFIANT_UNE_COMMANDE_ANNULEE as readonly string[]).includes(role)
  );
}

/** Motif du refus, en français, quand `peutModifierCommande` répond non. */
export function motifRefusModification(role: Role, statut: Statut): string {
  if (statut === OrderStatus.CANCELLED) {
    return "Une commande annulée ne peut être modifiée que par l'administrateur ou le centre d'appels.";
  }
  if (role && (ROLES_MODIFIANT_UNE_COMMANDE_ANNULEE as readonly string[]).includes(role)) {
    return 'Seules les commandes en attente, acceptées, en préparation, prêtes ou annulées peuvent être modifiées.';
  }
  return 'Seules les commandes en attente, acceptées, en préparation ou prêtes peuvent être modifiées';
}
