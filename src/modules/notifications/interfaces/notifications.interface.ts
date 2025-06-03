import { LoyaltyLevel, UserRole } from "@prisma/client";

export interface NotificationRecipient {
    id: string;
    type: 'customer' | 'restaurant_user' | 'backoffice_user';
    role?: UserRole;
    name: string;
    restaurant_id?: string;
    loyalty_level?: LoyaltyLevel | null;
    lifetime_points?: number;
    total_points?: number;
}

export interface NotificationContext {
    actor: NotificationRecipient; // Celui qui fait l'action
    recipients: NotificationRecipient[]; // Ceux qui doivent recevoir la notification
    data: any; // Données spécifiques à l'événement
}

export interface NotificationTemplate {
    title: (context: NotificationContext) => string;
    message: (context: NotificationContext) => string;
    icon: (context: NotificationContext) => string;
    iconBgColor: (context: NotificationContext) => string;
    showChevron?: boolean;
}
