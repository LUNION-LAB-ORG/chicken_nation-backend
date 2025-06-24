import { LoyaltyLevel, Prisma } from "@prisma/client";

export interface OrderCreatedEvent {
  order: Prisma.OrderGetPayload<{ include: { restaurant: true } }>;
  payment_id?: string;
  loyalty_level?: LoyaltyLevel;
  totalDishes?: number;
  orderItems?: { dish_id: string, quantity: number, price: number }[];
}