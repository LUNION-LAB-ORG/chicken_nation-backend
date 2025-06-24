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

    // FIDÉLITÉ - Points gagnés
    static LOYALTY_POINTS_EARNED: NotificationTemplate<{ points: number; total_points: number; }> = {
        title: (ctx) => `🎉 Points gagnés !`,
        message: (ctx) => `Félicitations ! Vous avez gagné ${ctx.data.points} points. Total: ${ctx.data.total_points} points`,
        icon: (ctx) => notificationIcons.joice.url,
        iconBgColor: (ctx) => notificationIcons.joice.color,
        showChevron: false
    };

    // FIDÉLITÉ - Points utilisés
    static LOYALTY_POINTS_REDEEMED: NotificationTemplate<{ points: number; remaining_points: number; }> = {
        title: (ctx) => `💎 Points utilisés`,
        message: (ctx) => `Vous avez utilisé ${ctx.data.points} points. Points restants: ${ctx.data.remaining_points}`,
        icon: (ctx) => notificationIcons.good.url,
        iconBgColor: (ctx) => notificationIcons.good.color,
        showChevron: false
    };

    // FIDÉLITÉ - Changement de niveau
    static LOYALTY_LEVEL_UP: NotificationTemplate<{ new_level: string; bonus_points: number; }> = {
        title: (ctx) => `🏆 Niveau atteint !`,
        message: (ctx) => `Félicitations ! Vous êtes maintenant ${ctx.data.new_level}. Bonus: ${ctx.data.bonus_points} points`,
        icon: (ctx) => notificationIcons.joice.url,
        iconBgColor: (ctx) => '#FFD700', // Or
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

    // Notification de points expirés
    static POINTS_EXPIRING_SOON: NotificationTemplate<{ expiring_points: number; days_remaining: number; }> = {
        title: (ctx) => `⏰ Points bientôt expirés`,
        message: (ctx) => `${ctx.data.expiring_points} points vont expirer dans ${ctx.data.days_remaining} jours. Utilisez-les vite !`,
        icon: (ctx) => notificationIcons.waiting.url,
        iconBgColor: (ctx) => notificationIcons.waiting.color,
        showChevron: false
    };
}