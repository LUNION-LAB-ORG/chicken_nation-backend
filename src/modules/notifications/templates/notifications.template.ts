import { notificationIcons } from "../constantes/notifications.constante";
import { NotificationTemplate } from "../interfaces/notifications.interface";

export class NotificationsTemplate {

    // PAIEMENT - Pour le client
    static PAYMENT_SUCCESS_CUSTOMER: NotificationTemplate<{ reference: string; amount: number; }> = {
        title: (ctx) => `💳 Paiement confirmé`,
        message: (ctx) => `Votre paiement de ${ctx.data.amount} XOF a été confirmé pour la commande ${ctx.data.reference}`,
        icon: (ctx) => notificationIcons.joice.url,
        iconBgColor: (ctx) => notificationIcons.joice.color,
        showChevron: false
    };

    // PAIEMENT - Pour le restaurant
    static PAYMENT_SUCCESS_RESTAURANT: NotificationTemplate<{ reference: string; amount: number; }> = {
        title: (ctx) => `💰 Paiement reçu`,
        message: (ctx) => `Paiement de ${ctx.data.amount} XOF reçu pour la commande ${ctx.data.reference}`,
        icon: (ctx) => notificationIcons.good.url,
        iconBgColor: (ctx) => notificationIcons.good.color,
        showChevron: false
    };

    // CUSTOMER
    // Notification de bienvenue pour nouveau client
    static WELCOME_NEW_CUSTOMER: NotificationTemplate<{ welcome_points: number; }> = {
        title: (ctx) => `🎉 Bienvenue ${ctx.actor.name} !`,
        message: (ctx) => `Merci de rejoindre notre communauté ! Vous avez reçu ${ctx.data.welcome_points} points de bienvenue.`,
        icon: (ctx) => notificationIcons.joice.url,
        iconBgColor: (ctx) => notificationIcons.joice.color,
        showChevron: false
    };
}