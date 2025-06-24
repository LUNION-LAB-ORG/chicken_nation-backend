import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";

export class PromotionNotificationsTemplate {

    PROMOTION_USED: NotificationTemplate<{ promotion_title: string; discount_amount: number; }> = {
        title: (ctx) => `🎊 Promotion utilisée`,
        message: (ctx) => `Vous avez utilisé la promotion "${ctx.data.promotion_title}". Économie: ${ctx.data.discount_amount} XOF`,
        icon: (ctx) => notificationIcons.promotion.url,
        iconBgColor: (ctx) => notificationIcons.promotion.color,
        showChevron: false
    };

    PROMOTION_AVAILABLE: NotificationTemplate<{ promotion_title: string; promotion_description: string; }> = {
        title: (ctx) => `🎉 Nouvelle promotion`,
        message: (ctx) => `"${ctx.data.promotion_title}" - ${ctx.data.promotion_description}`,
        icon: (ctx) => notificationIcons.promotion.url,
        iconBgColor: (ctx) => notificationIcons.promotion.color,
        showChevron: false
    };


}