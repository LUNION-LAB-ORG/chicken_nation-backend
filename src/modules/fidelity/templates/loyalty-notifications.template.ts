import { Customer } from "@prisma/client";
import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";

export class LoyaltyNotificationsTemplate {

    // FIDÉLITÉ - Points gagnés
    LOYALTY_POINTS_ADDED: NotificationTemplate<{ actor: Customer; points: number; }> = {
        title: (ctx) => `🎉 Points gagnés ! ${ctx.data.points} points pour vous !`,
        message: (ctx) => `Félicitations, ${ctx.data.actor.first_name ?? 'cher client'} ! Vous avez accumulé ${ctx.data.points} points supplémentaires. Votre nouveau solde est de ${ctx.data.actor.total_points} points !`,
        icon: (ctx) => notificationIcons.joice.url,
        iconBgColor: (ctx) => notificationIcons.joice.color,
        showChevron: true // Encourage clicking to see rewards
    };

    // FIDÉLITÉ - Points utilisés
    LOYALTY_POINTS_REDEEMED: NotificationTemplate<{ actor: Customer; points: number; orderReference?: string; }> = { // Added optional orderReference for context
        title: (ctx) => `💎 Points utilisés !`,
        message: (ctx) => {
            const orderContext = ctx.data.orderReference ? ` pour votre commande #${ctx.data.orderReference}` : '';
            return `Vous avez utilisé ${ctx.data.points} points${orderContext}. Il vous reste maintenant ${ctx.data.actor.total_points} points à dépenser.`;
        },
        icon: (ctx) => notificationIcons.good.url, // Good for a successful action
        iconBgColor: (ctx) => notificationIcons.good.color,
        showChevron: true // Encourage clicking to see impact on order or loyalty history
    };

    // FIDÉLITÉ - Changement de niveau
    LOYALTY_LEVEL_UP: NotificationTemplate<{ actor: Customer; new_level: string; bonus_points: number; }> = {
        title: (ctx) => `🏆 Bravo ! Vous êtes un membre ${ctx.data.new_level} !`,
        message: (ctx) => `Félicitations, ${ctx.data.actor.first_name ?? 'cher client'} ! Vous avez atteint le niveau ${ctx.data.new_level} de fidélité ! Pour célébrer, nous vous offrons ${ctx.data.bonus_points} points bonus !`,
        icon: (ctx) => notificationIcons.joice.url, // Joice for celebration
        iconBgColor: (ctx) => '#FFD700', // Gold color for achievement
        showChevron: true // Encourage clicking to explore new benefits
    };

    // Notification de points bientôt expirés
    POINTS_EXPIRING_SOON: NotificationTemplate<{ actor: Customer; expiring_points: number; days_remaining: number; }> = {
        title: (ctx) => `⏰ Attention : ${ctx.data.expiring_points} points vont expirer !`,
        message: (ctx) => `Vous avez ${ctx.data.expiring_points} points qui expireront dans seulement ${ctx.data.days_remaining} jours. Utilisez-les vite avant qu'il ne soit trop tard !`,
        icon: (ctx) => notificationIcons.waiting.url, // Waiting for urgency
        iconBgColor: (ctx) => notificationIcons.waiting.color,
        showChevron: true // Critical: clicking should lead to redemption options
    };

    // Notification de points expirés
    POINTS_EXPIRED: NotificationTemplate<{ actor: Customer; expired_points: number; }> = { // Renamed from POINTS_EXPIRING and changed payload
        title: (ctx) => `🗑️ Vos points ont expiré`,
        message: (ctx) => `Malheureusement, ${ctx.data.expired_points} points de votre solde ont expiré. Votre nouveau total est de ${ctx.data.actor.total_points} points. Continuez à commander pour gagner plus !`,
        icon: (ctx) => notificationIcons.setting.url, // Using a neutral/informative icon
        iconBgColor: (ctx) => '#6C757D', // Neutral color for a less celebratory message
        showChevron: true // Still offer to go to loyalty page to earn more
    };
}