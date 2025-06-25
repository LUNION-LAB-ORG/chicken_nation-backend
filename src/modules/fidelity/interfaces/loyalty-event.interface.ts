import { Customer, LoyaltyLevel } from "@prisma/client";

export interface LoyaltyPointsAddedEvent {
    customer: Customer;
    points: number;
    orderReference?: string;
}

export interface LoyaltyPointsRedeemedEvent {
    customer: Customer;
    points: number;
    orderReference?: string;
}

export interface LoyaltyLevelUpEvent {
    customer: Customer;
    new_level: LoyaltyLevel;
    bonus_points: number;
}
export interface LoyaltyPointsExpiringSoonEvent {
    customer: Customer;
    expiring_points: number;
    days_remaining: number;
}

export interface LoyaltyPointsExpiredEvent {
    customer: Customer;
    expired_points: number;
}
