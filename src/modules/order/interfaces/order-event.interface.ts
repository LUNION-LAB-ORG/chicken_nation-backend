import { LoyaltyLevel, Prisma } from "@prisma/client";

export class OrderCreatedEvent {
  order: Prisma.OrderGetPayload<{ include: { restaurant: true } }>;
  expo_token?: string | null;
  payment_id?: string;
  loyalty_level?: LoyaltyLevel;
  totalDishes?: number;
  orderItems?: { dish_id: string, quantity: number, price: number }[];
  voucher?: { code: string; initial_amount: number; expires_at: Date | null } | null;
}