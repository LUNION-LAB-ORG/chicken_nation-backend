import { Customer, Prisma, Promotion, DiscountType } from "@prisma/client"; // Import DiscountType
import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";

export class PromotionNotificationsTemplate {

    /**
     * Notification pour le client consommateur lorsqu'une promotion est utilisée avec succès.
     */
    PROMOTION_USED: NotificationTemplate<{
        customer: Customer,
        promotion: Promotion,
        discountAmount: number,
    }> = {
            title: (ctx) => `🎉 Bravo ! Promotion "${ctx.data.promotion.title}" appliquée !`,
            message: (ctx) => `Vous avez économisé ${ctx.data.discountAmount} XOF sur votre commande grâce à la promotion "${ctx.data.promotion.title}".`,
            icon: (ctx) => notificationIcons.promotion.url,
            iconBgColor: (ctx) => notificationIcons.promotion.color,
            showChevron: true // Suggests clicking to see order details or more promotions
        };

    /**
     * Nouvelle Promotion pour la notification des clients consommateurs.
     */
    PROMOTION_AVAILABLE: NotificationTemplate<{ actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, promotion: Promotion }> = {
        title: (ctx) => `🔥 Nouvelle promo : "${ctx.data.promotion.title}" !`,
        message: (ctx) => {
            const endDate = ctx.data.promotion.expiration_date ? ` Valide jusqu'au ${ctx.data.promotion.expiration_date.toLocaleDateString('fr-FR')}.` : '';
            return `Ne manquez pas notre offre spéciale : ${ctx.data.promotion.description}. ${endDate} Cliquez pour en profiter !`;
        },
        icon: (ctx) => notificationIcons.promotion.url,
        iconBgColor: (ctx) => notificationIcons.promotion.color,
        showChevron: true // Crucial: clicking should take them to the promo details or a "promotions" section
    };

    /**
     * Nouvelle promotion pour la notification des restaurants et du backoffice.
     * Informe les parties prenantes internes d'une nouvelle promotion créée.
     */
    PROMOTION_CREATED_INTERNAL: NotificationTemplate<{ actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, promotion: Promotion }> = {
        title: (ctx) => `📣 Nouvelle promotion : "${ctx.data.promotion.title}"`,
        message: (ctx) => {
            const discountInfo = ctx.data.promotion.discount_type === DiscountType.PERCENTAGE
                ? `${ctx.data.promotion.discount_value}% de réduction`
                : ctx.data.promotion.discount_type === DiscountType.BUY_X_GET_Y
                    ? `Achetez ${ctx.data.promotion.discount_value} plats et obtenez des plats offerts`
                    : `${ctx.data.promotion.discount_value} XOF de réduction`;
            return `La promotion "${ctx.data.promotion.title}" (${discountInfo}) a été créée par ${ctx.data.actor.fullname}.`;
        },
        icon: (ctx) => notificationIcons.promotion.url,
        iconBgColor: (ctx) => notificationIcons.promotion.color,
        showChevron: true
    };

    /**
     * Promotion modifiée pour la notification des restaurants et du backoffice.
     */
    PROMOTION_UPDATED_INTERNAL: NotificationTemplate<{ actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, promotion: Promotion }> = {
        title: (ctx) => `✏️ Promotion modifiée : "${ctx.data.promotion.title}"`,
        message: (ctx) => `La promotion "${ctx.data.promotion.title}" a été modifiée par ${ctx.data.actor.fullname}. Vérifiez les détails.`,
        icon: (ctx) => notificationIcons.promotion.url,
        iconBgColor: (ctx) => notificationIcons.promotion.color,
        showChevron: true
    };

    /**
     * Promotion supprimée pour la notification des restaurants et du backoffice.
     */
    PROMOTION_DELETED_INTERNAL: NotificationTemplate<{ actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, promotion: Promotion }> = {
        title: (ctx) => `🗑️ Promotion supprimée : "${ctx.data.promotion.title}"`,
        message: (ctx) => `La promotion "${ctx.data.promotion.title}" a été supprimée par ${ctx.data.actor.fullname}.`,
        icon: (ctx) => notificationIcons.promotion.url,
        iconBgColor: (ctx) => notificationIcons.promotion.color,
        showChevron: true
    };
}