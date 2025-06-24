import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";

export class LoyaltyNotificationsTemplate {

    // FIDÉLITÉ - Points utilisés
    LOYALTY_POINTS_REDEEMED: NotificationTemplate<{ points: number; remaining_points: number; }> = {
        title: (ctx) => `💎 Points utilisés`,
        message: (ctx) => `Vous avez utilisé ${ctx.data.points} points. Points restants: ${ctx.data.remaining_points}`,
        icon: (ctx) => notificationIcons.good.url,
        iconBgColor: (ctx) => notificationIcons.good.color,
        showChevron: false
    };

    // FIDÉLITÉ - Changement de niveau
    LOYALTY_LEVEL_UP: NotificationTemplate<{ new_level: string; bonus_points: number; }> = {
        title: (ctx) => `🏆 Niveau atteint !`,
        message: (ctx) => `Félicitations ! Vous êtes maintenant ${ctx.data.new_level}. Bonus: ${ctx.data.bonus_points} points`,
        icon: (ctx) => notificationIcons.joice.url,
        iconBgColor: (ctx) => '#FFD700', // Or
        showChevron: false
    };

    // Notification de points expirés
    POINTS_EXPIRING_SOON: NotificationTemplate<{ expiring_points: number; days_remaining: number; }> = {
        title: (ctx) => `⏰ Points bientôt expirés`,
        message: (ctx) => `${ctx.data.expiring_points} points vont expirer dans ${ctx.data.days_remaining} jours. Utilisez-les vite !`,
        icon: (ctx) => notificationIcons.waiting.url,
        iconBgColor: (ctx) => notificationIcons.waiting.color,
        showChevron: false
    };


}