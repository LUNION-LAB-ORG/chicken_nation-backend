import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { Prisma, Dish } from "@prisma/client";

export class DishNotificationsTemplate {

    // Notification aux membres du backoffice
    NEW_DISH_BACKOFFICE: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        dish: Dish
    }> = {
            title: (ctx) => `Nouveau plat`,
            message: (ctx) => `Le plat ${ctx.data.dish.name} a été créé par ${ctx.data.actor.fullname}`,
            icon: (ctx) => notificationIcons.ok.url,
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: false
        };

    // Notification à l'utilisateur
    NEW_DISH_RESTAURANT: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        dish: Dish
    }> = {
            title: (ctx) => `Nouveau plat`,
            message: (ctx) => `Nous avons le plaisir de vous annoncer la création du plat ${ctx.data.dish.name}.`,
            icon: (ctx) => notificationIcons.joice.url,
            iconBgColor: (ctx) => notificationIcons.joice.color,
            showChevron: false
        };
}