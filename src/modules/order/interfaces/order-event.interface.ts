import { LoyaltyLevel, Order } from "@prisma/client";

export interface OrderCreatedEvent {
  order: Order;
  payment_id: string | null;
  loyalty_level: LoyaltyLevel | undefined;
  totalDishes: number;
  orderItems: { dish_id: string, quantity: number, price: number }[];
}