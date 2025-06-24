import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { Prisma, Dish } from "@prisma/client";
import { userGetRole } from "src/modules/users/constantes/user-get-role.constante";

export class DishNotificationsTemplate {

    /**
     * Notification pour les membres du back-office (Admins/Managers)
     * Informe le personnel du back-office lorsqu'un nouveau plat a été créé.
     */
    NEW_DISH_BACKOFFICE: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        dish: Dish
    }> = {
            title: (ctx) => `🍽️ Nouveau plat ajouté : ${ctx.data.dish.name}`,
            message: (ctx) => `Le plat ${ctx.data.dish.name} a été créé par ${ctx.data.actor.fullname} (${userGetRole(ctx.data.actor.role)}).`,
            icon: (ctx) => notificationIcons.ok.url,
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: true // Clicking this should lead to dish details in the admin panel
        };

    /**
     * Notification pour les utilisateurs de restaurant
     * Informe les managers de restaurant de la création d'un nouveau plat qu'ils peuvent utiliser.
     */
    NEW_DISH_RESTAURANT: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        dish: Dish
    }> = {
            title: (ctx) => `✨ Nouveau plat disponible : ${ctx.data.dish.name} !`,
            message: (ctx) => `Bonne nouvelle ! Le plat ${ctx.data.dish.name} est maintenant disponible. Vous pouvez l'ajouter à votre menu.`,
            icon: (ctx) => notificationIcons.joice.url,
            iconBgColor: (ctx) => notificationIcons.joice.color,
            showChevron: true // Clicking this should take them to their menu management
        };
}