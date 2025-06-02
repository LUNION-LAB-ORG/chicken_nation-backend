import { Customer, LoyaltyLevel } from "@prisma/client";

export interface LoyaltyLevelUpEvent {
    customer: Customer;
    previous_level: LoyaltyLevel;
    new_level: LoyaltyLevel;
}