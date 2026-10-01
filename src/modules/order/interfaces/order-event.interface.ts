import { LoyaltyLevel, Prisma } from "@prisma/client";
import { RESTAURANT_COMMANDE_SELECT } from "src/modules/restaurant/constantes/restaurant-public.select";

export class OrderCreatedEvent {
  // Restaurant réduit à la liste blanche : la même commande part sur les
  // sockets, et aucun écouteur ne lit autre chose que `restaurant.name`.
  // Une commande chargée avec le restaurant complet reste assignable.
  order: Prisma.OrderGetPayload<{ include: { restaurant: { select: typeof RESTAURANT_COMMANDE_SELECT } } }>;
  expo_token?: string | null;
  payment_id?: string;
  loyalty_level?: LoyaltyLevel;
  totalDishes?: number;
  orderItems?: { dish_id: string, quantity: number, price: number }[];
  voucher?: { code: string; initial_amount: number; expires_at: Date | null } | null;
  /**
   * Création d'un panier non payé de l'application (posé par `createv2`
   * seul). Lu par l'écouteur de création : le restaurant n'est pas prévenu
   * d'une commande qu'il ne voit pas. Pas déduit de `order` : au paiement,
   * KKiaPay réémet la création avec la commande d'AVANT sa mise à jour,
   * encore en attente et non payée, qui ressemble donc à un brouillon.
   */
  brouillon?: boolean;
  /**
   * Changement de statut d'une commande qui ÉTAIT un brouillon (état
   * précédent). Lu par l'écouteur de statut : l'annulation d'un panier non
   * payé ne sonne pas au restaurant.
   */
  etait_brouillon?: boolean;
}