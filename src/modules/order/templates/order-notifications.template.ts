import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { OrderStatus } from "@prisma/client";
import { getOrderNotificationContent } from "../constantes/order-notifications.constante";

export class OrderNotificationsTemplate {

    // STATUT COMMANDE - Pour le client
    NOTIFICATION_ORDER_CUSTOMER: NotificationTemplate<{
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
    NOTIFICATION_ORDER_RESTAURANT: NotificationTemplate<{ reference: string; status: OrderStatus; amount: number; restaurant_name: string; customer_name: string; }> = {
        title: (ctx) => getOrderNotificationContent(ctx.data, 'restaurant').title,
        message: (ctx) => getOrderNotificationContent(ctx.data, 'restaurant').message,
        icon: (ctx) => getOrderNotificationContent(ctx.data, 'restaurant').icon,
        iconBgColor: (ctx) => getOrderNotificationContent(ctx.data, 'restaurant').iconBgColor,
        showChevron: false
    };
}