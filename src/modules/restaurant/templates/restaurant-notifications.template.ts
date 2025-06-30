import { notificationIcons } from "src/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/notifications/interfaces/notifications.interface";
import { Prisma, Restaurant } from "@prisma/client";
import { userGetRole } from "src/modules/users/constantes/user-get-role.constante";

export class RestaurantNotificationsTemplate {

    /**
     * Notification aux membres du backoffice (Admins/Managers)
     * Inform an administrator or manager that a new restaurant has been onboarded.
     */
    NEW_RESTAURANT_BACKOFFICE: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, // The user who created the restaurant
        restaurant: Restaurant
    }> = {
            title: (ctx) => `🎉 Nouveau restaurant : ${ctx.data.restaurant.name} !`,
            message: (ctx) => `${ctx.data.restaurant.name} a été créé par ${ctx.data.actor.fullname} (${userGetRole(ctx.data.actor.role)}). Une belle addition à Chicken Nation !`,
            icon: (ctx) => notificationIcons.joice.url, // Using 'joice' for a celebratory feel
            iconBgColor: (ctx) => notificationIcons.joice.color,
            showChevron: true // Indicate that clicking will show more details
        };

    /**
     * Notification de bienvenue au restaurant nouvellement créé
     * Welcome the new restaurant partner to the platform.
     */
    WELCOME_RESTAURANT: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, // The user (admin/manager) who created the restaurant
        restaurant: Restaurant
    }> = {
            title: (ctx) => `✨ Bienvenue, ${ctx.data.restaurant.name} !`,
            message: (ctx) => `Votre restaurant fait maintenant officiellement partie de la famille Chicken Nation ! Prêt à recevoir vos premières commandes ?`,
            icon: (ctx) => notificationIcons.ok.url, // Using 'ok' as a positive confirmation icon
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: true // Indicate that clicking will take them to their dashboard
        };
}