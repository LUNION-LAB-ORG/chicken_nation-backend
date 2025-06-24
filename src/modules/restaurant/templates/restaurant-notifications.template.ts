import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { Prisma, Restaurant } from "@prisma/client";

export class RestaurantNotificationsTemplate {

    // Notification aux membres du backoffice
    NEW_RESTAURANT_BACKOFFICE: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        restaurant: Restaurant
    }> = {
            title: (ctx) => `👥 Nouvel restaurant`,
            message: (ctx) => `Le restaurant ${ctx.data.restaurant.name} a été créé par ${ctx.data.actor.fullname}`,
            icon: (ctx) => notificationIcons.ok.url,
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: false
        };

    // Notification à l'utilisateur
    WELCOME_RESTAURANT: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        restaurant: Restaurant
    }> = {
            title: (ctx) => `🎉 Bienvenue sur Chicken Nation !`,
            message: (ctx) => `Votre restaurant ${ctx.data.restaurant.name} fait partie de la famille Chicken Nation !`,
            icon: (ctx) => notificationIcons.joice.url,
            iconBgColor: (ctx) => notificationIcons.joice.color,
            showChevron: false
        };

}