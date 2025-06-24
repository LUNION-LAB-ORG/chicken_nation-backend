import { Order, OrderStatus } from "@prisma/client";
import { getOrderNotificationContent, notificationIcons } from "../constantes/notifications.constante";
import { NotificationTemplate } from "../interfaces/notifications.interface";

export class NotificationsTemplate {

    // COMMANDES - Pour le client
    static ORDER_CREATED_CUSTOMER: NotificationTemplate<Order> = {
        title: (ctx) => `🛒 Commande créée`,
        message: (ctx) => `Votre commande ${ctx.data.reference} a été créée avec succès. Montant: ${ctx.data.amount} XOF`,
        icon: (ctx) => notificationIcons.ok.url,
        iconBgColor: (ctx) => notificationIcons.ok.color,
        showChevron: false
    };

    // COMMANDES - Pour le restaurant
    static ORDER_CREATED_RESTAURANT: NotificationTemplate<Order> = {
        title: (ctx) => `📋 Nouvelle commande`,
        message: (ctx) => `Nouvelle commande ${ctx.data.reference} de ${ctx.actor.name || 'Client'}. Montant: ${ctx.data.amount} XOF`,
        icon: (ctx) => notificationIcons.waiting.url,
        iconBgColor: (ctx) => notificationIcons.waiting.color,
        showChevron: false
    };

    // STATUT COMMANDE - Pour le client
    static ORDER_STATUS_UPDATED_CUSTOMER: NotificationTemplate<{
        reference: string;
        status: OrderStatus;
        amount: number;
        restaurant_name: string;
        customer_name: string;
    }> = {
            title: (ctx) => getOrderNotificationContent(ctx.data, 'customer').title,
            message: (ctx) => getOrderNotificationContent(ctx.data, 'customer').message,
            icon: (ctx) => getOrderNotificationContent(ctx.data, 'customer').icon,
            iconBgColor: (ctx) => getOrderNotificationContent(ctx.data, 'customer').iconBgColor,
            showChevron: false
        };

    // STATUT COMMANDE - Pour le restaurant
    static ORDER_STATUS_UPDATED_RESTAURANT: NotificationTemplate<{ reference: string; status: OrderStatus; amount: number; restaurant_name: string; customer_name: string; }> = {
        title: (ctx) => getOrderNotificationContent(ctx.data, 'restaurant').title,
        message: (ctx) => getOrderNotificationContent(ctx.data, 'restaurant').message,
        icon: (ctx) => getOrderNotificationContent(ctx.data, 'restaurant').icon,
        iconBgColor: (ctx) => getOrderNotificationContent(ctx.data, 'restaurant').iconBgColor,
        showChevron: false
    };

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

    // PROMOTIONS
    static PROMOTION_USED: NotificationTemplate<{ promotion_title: string; discount_amount: number; }> = {
        title: (ctx) => `🎊 Promotion utilisée`,
        message: (ctx) => `Vous avez utilisé la promotion "${ctx.data.promotion_title}". Économie: ${ctx.data.discount_amount} XOF`,
        icon: (ctx) => notificationIcons.promotion.url,
        iconBgColor: (ctx) => notificationIcons.promotion.color,
        showChevron: false
    };

    static PROMOTION_AVAILABLE: NotificationTemplate<{ promotion_title: string; promotion_description: string; }> = {
        title: (ctx) => `🎉 Nouvelle promotion`,
        message: (ctx) => `"${ctx.data.promotion_title}" - ${ctx.data.promotion_description}`,
        icon: (ctx) => notificationIcons.promotion.url,
        iconBgColor: (ctx) => notificationIcons.promotion.color,
        showChevron: false
    };

    // Notification de bienvenue pour nouveau client
    static WELCOME_NEW_CUSTOMER: NotificationTemplate<{ welcome_points: number; }> = {
        title: (ctx) => `🎉 Bienvenue ${ctx.actor.name} !`,
        message: (ctx) => `Merci de rejoindre notre communauté ! Vous avez reçu ${ctx.data.welcome_points} points de bienvenue.`,
        icon: (ctx) => notificationIcons.joice.url,
        iconBgColor: (ctx) => notificationIcons.joice.color,
        showChevron: false
    };

    // Notification pour les managers quand un nouvel utilisateur rejoint leur restaurant
    static NEW_USER_RESTAURANT: NotificationTemplate<{ role: string; }> = {
        title: (ctx) => `👥 Nouvel utilisateur`,
        message: (ctx) => `${ctx.actor.name} a rejoint votre équipe en tant que agent ${ctx.data.role}`,
        icon: (ctx) => notificationIcons.ok.url,
        iconBgColor: (ctx) => notificationIcons.ok.color,
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

    // Notification de commande annulée par le restaurant
    static ORDER_CANCELLED_BY_RESTAURANT: NotificationTemplate<{ reference: string; reason: string; }> = {
        title: (ctx) => `❌ Commande annulée`,
        message: (ctx) => `Votre commande ${ctx.data.reference} a été annulée par le restaurant. Raison: ${ctx.data.reason || 'Non spécifiée'}`,
        icon: (ctx) => 'https://cdn-icons-png.flaticon.com/512/3524/3524890.png',
        iconBgColor: (ctx) => '#DC3545',
        showChevron: false
    };

    // Notifications catégorie cr&e
    static CATEGORY_CREATED: NotificationTemplate<{ category_name: string; }> = {
        title: (ctx) => `🎉 Nouvelle catégorie`,
        message: (ctx) => `Nouvelle catégorie "${ctx.data.category_name}"`,
        icon: (ctx) => notificationIcons.ok.url,
        iconBgColor: (ctx) => notificationIcons.ok.color,
        showChevron: false
    };

    // Notifications catégorie mise à jour
    static CATEGORY_UPDATED: NotificationTemplate<{ category_name: string; }> = {
        title: (ctx) => `Catégorie mise à jour`,
        message: (ctx) => `Catégorie "${ctx.data.category_name}" mise à jour`,
        icon: (ctx) => notificationIcons.ok.url,
        iconBgColor: (ctx) => notificationIcons.ok.color,
        showChevron: false
    };

    // Notifications plat cr&e
    static DISH_CREATED: NotificationTemplate<{ dish_name: string; }> = {
        title: (ctx) => `🎉 Nouveau plat`,
        message: (ctx) => `Nouveau plat "${ctx.data.dish_name}"`,
        icon: (ctx) => notificationIcons.ok.url,
        iconBgColor: (ctx) => notificationIcons.ok.color,
        showChevron: false
    };

    // Notifications plat mis à jour
    static DISH_UPDATED: NotificationTemplate<{ dish_name: string; }> = {
        title: (ctx) => `Plat mis à jour`,
        message: (ctx) => `Plat "${ctx.data.dish_name}" mis à jour`,
        icon: (ctx) => notificationIcons.ok.url,
        iconBgColor: (ctx) => notificationIcons.ok.color,
        showChevron: false
    };
}