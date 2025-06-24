import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { Prisma, UserType } from "@prisma/client";
import { userGetRole } from "../constantes/user-get-role.constante"; // Assuming you have this utility

export class UserNotificationsTemplate {

    /**
     * Notification aux membres du backoffice (Admins/Managers)
     * Inform an administrator or manager that a new user has been created in the system.
     */
    NEW_USER_BACKOFFICE: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, // The user who created the new user
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>  // The newly created user
    }> = {
            title: (ctx) => `👥 Nouvel utilisateur : ${ctx.data.user.fullname}`,
            message: (ctx) => `${ctx.data.user.fullname} (${ctx.data.user.email}) a été ajouté en tant que ${userGetRole(ctx.data.user.role)} par ${ctx.data.actor.fullname}.`,
            icon: (ctx) => notificationIcons.ok.url, // Using 'ok' as a positive confirmation
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: true // Set to true if clicking opens details in the admin panel
        };

    /**
     * Notification aux managers de restaurant
     * Inform a restaurant manager that a new team member (agent) has joined their specific restaurant.
     */
    NEW_USER_RESTAURANT: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, // The user who created the new user (e.g., admin or main manager)
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>  // The newly added agent for the restaurant
    }> = {
            title: (ctx) => `🤝 Nouveau membre dans votre équipe !`,
            message: (ctx) => `${ctx.data.user.fullname} a rejoint l'équipe de votre restaurant ${ctx.data.user.restaurant?.name ?? 'non renseigné'} en tant qu'${userGetRole(ctx.data.user.role)}.`,
            icon: (ctx) => notificationIcons.ok.url, // Keeping 'ok' for a positive addition
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: true // Set to true if clicking opens team management in restaurant dashboard
        };

    /**
     * Notification de bienvenue à l'utilisateur nouvellement créé
     * Welcome the new user to the platform and inform them their account is ready.
     */
    WELCOME_USER: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, // The user who created this user
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>  // The new user being welcomed
    }> = {
            title: (ctx) => `🎉 Bienvenue ${ctx.data.user.fullname} !`,
            message: (ctx) => {
                const companyOrRestaurantName = ctx.data.user.type === UserType.BACKOFFICE ? "Chicken Nation" : ctx.data.user.restaurant?.name ?? "votre espace";
                return `Votre compte pour ${companyOrRestaurantName} est prêt. Connectez-vous pour commencer !`;
            },
            icon: (ctx) => notificationIcons.joice.url,
            iconBgColor: (ctx) => notificationIcons.joice.color,
            showChevron: true // Set to true if clicking takes them to the login/dashboard
        };
}