export interface NotificationRecipient {
    id: string;
    type: 'customer' | 'restaurant_user' | 'backoffice_user';
    name?: string;
    restaurant_id?: string;
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
