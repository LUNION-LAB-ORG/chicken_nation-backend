import { LoyaltyLevel, UserRole } from "@prisma/client";

export interface NotificationRecipient {
    id: string;
    type: 'customer' | "user" | 'restaurant_user' | 'backoffice_user';
    role?: UserRole;
    name: string;
    email?: string;
    phone?: string;
    loyalty_level?: LoyaltyLevel | null;
    lifetime_points?: number;
    total_points?: number;
    restaurant_id?: string;
    restaurant_name?: string;
}

export interface NotificationContext<T> {
    actor: NotificationRecipient;
    recipients: NotificationRecipient[];
    data: T;
    meta?: any;
}

export interface NotificationTemplate<T> {
    title: (context: NotificationContext<T>) => string;
    message: (context: NotificationContext<T>) => string;
    icon: (context: NotificationContext<T>) => string;
    iconBgColor: (context: NotificationContext<T>) => string;
    showChevron?: boolean;
}
