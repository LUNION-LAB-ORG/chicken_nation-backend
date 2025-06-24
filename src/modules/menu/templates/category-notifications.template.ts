import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { Prisma, Category } from "@prisma/client";

export class CategoryNotificationsTemplate {

    // Notification aux membres du backoffice
    NEW_CATEGORY_BACKOFFICE: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        category: Category
    }> = {
            title: (ctx) => `Nouvelle catégorie`,
            message: (ctx) => `La catégorie ${ctx.data.category.name} a été créée par ${ctx.data.actor.fullname}`,
            icon: (ctx) => notificationIcons.ok.url,
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: false
        };

    // Notification à l'utilisateur
    NEW_CATEGORY_RESTAURANT: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        category: Category
    }> = {
            title: (ctx) => `Nouvelle catégorie`,
            message: (ctx) => `Nous avons le plaisir de vous annoncer la création de la catégorie ${ctx.data.category.name}.`,
            icon: (ctx) => notificationIcons.joice.url,
            iconBgColor: (ctx) => notificationIcons.joice.color,
            showChevron: false
        };

}