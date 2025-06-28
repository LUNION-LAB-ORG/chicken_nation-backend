
import { DiscountType, TargetType, PromotionStatus, Visibility, PromotionTargetedDish, PromotionTargetedCategory, PromotionDish, RestaurantPromotion } from "@prisma/client";

export class PromotionResponseDto {
    id: string;
    title: string;
    description?: string;
    discount_type: DiscountType;
    discount_value: number;
    target_type: TargetType;
    min_order_amount?: number;
    max_discount_amount?: number;
    max_usage_per_user?: number;
    max_total_usage?: number;
    current_usage: number;
    start_date: Date;
    expiration_date: Date;
    status: PromotionStatus;
    visibility: Visibility;
    is_active: boolean;
    target_standard: boolean;
    target_premium: boolean;
    target_gold: boolean;
    coupon_image_url?: string;
    background_color?: string;
    text_color?: string;
    expiration_color?: string;
    created_by_id: string;
    created_at: Date;
    updated_at: Date;
    
    // Relations
    targeted_dishes?: PromotionTargetedDish[];
    targeted_categories?: PromotionTargetedCategory[];
    offered_dishes?: PromotionDish[];
    restaurants?: {id: string, name: string}[];
}