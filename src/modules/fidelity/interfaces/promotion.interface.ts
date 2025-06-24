import { Customer, Promotion, Prisma } from '@prisma/client';

export interface PromotionFilter {
  status?: string;
  visibility?: 'PUBLIC' | 'PRIVATE';
  customer_loyalty_level?: 'STANDARD' | 'PREMIUM' | 'GOLD';
  target_type?: 'ALL_PRODUCTS' | 'SPECIFIC_PRODUCTS' | 'CATEGORIES';
  active_only?: boolean;
}

export interface DiscountCalculation {
  discount_amount: number;
  final_amount: number;
  applicable: boolean;
  reason?: string;
  promotion_details?: {
    id: string;
    title: string;
    discount_type: string;
    discount_value: number;
  };
}

export interface LoyaltyStats {
  total_customers_by_level: {
    STANDARD: number;
    PREMIUM: number;
    GOLD: number;
  };
  points_distributed_this_month: number;
  points_redeemed_this_month: number;
  average_points_per_customer: number;
}


export interface PromotionManagementEventPayload {
  promotion: Promotion;
  actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>;
  targetedNames?: string[];
}

export interface PromotionUsedEventPayload {
  customer: Customer;
  promotion: Promotion;
  discountAmount: number;
}
