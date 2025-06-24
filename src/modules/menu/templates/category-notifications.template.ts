import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { Prisma, Category } from "@prisma/client";
import { userGetRole } from "src/modules/users/constantes/user-get-role.constante";

export class CategoryNotificationsTemplate {

    /**
     * Notification for back-office members (Admins/Managers)
     * Informs back-office staff when a new category has been created in the system.
     */
    NEW_CATEGORY_BACKOFFICE: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        category: Category
    }> = {
            title: (ctx) => `✨ Nouvelle catégorie : "${ctx.data.category.name}"`,
            message: (ctx) => `La catégorie "${ctx.data.category.name}" a été créée par ${ctx.data.actor.fullname} (${userGetRole(ctx.data.actor.role)}).`,
            icon: (ctx) => notificationIcons.ok.url,
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: true // Suggests clicking to view category details in the admin panel
        };

    /**
     * Notification for restaurant users
     * Informs restaurant managers about the creation of a new category they can use.
     */
    NEW_CATEGORY_RESTAURANT: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        category: Category
    }> = {
            title: (ctx) => `🎉 Nouvelle catégorie disponible : "${ctx.data.category.name}" !`,
            message: (ctx) => `Bonne nouvelle ! La catégorie "${ctx.data.category.name}" est maintenant disponible. Vous pouvez l'utiliser pour organiser vos produits.`,
            icon: (ctx) => notificationIcons.joice.url,
            iconBgColor: (ctx) => notificationIcons.joice.color,
            showChevron: true // Suggests clicking to go to menu/category management
        };
}