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
}