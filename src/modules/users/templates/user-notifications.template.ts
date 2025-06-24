import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { Prisma } from "@prisma/client";

export class UserNotificationsTemplate {

    // Notification aux membres du backoffice
    NEW_USER_BACKOFFICE: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
    }> = {
            title: (ctx) => `👥 Nouvel utilisateur`,
            message: (ctx) => `${ctx.data.user.fullname} a rejoint votre équipe en tant que agent ${ctx.data.user.role}`,
            icon: (ctx) => notificationIcons.ok.url,
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: false
        };

    // Notification aux membres du restaurant
    NEW_USER_RESTAURANT: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
    }> = {
            title: (ctx) => `👥 Nouveau membre`,
            message: (ctx) => `${ctx.data.user.fullname} a rejoint votre équipe en tant que agent ${ctx.data.user.role}`,
            icon: (ctx) => notificationIcons.ok.url,
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: false
        };

    // Notification à l'utilisateur
    WELCOME_USER: NotificationTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
    }> = {
            title: (ctx) => `🎉 Bienvenue ${ctx.data.user.fullname} !`,
            message: (ctx) => `Merci de rejoindre notre communauté !`,
            icon: (ctx) => notificationIcons.joice.url,
            iconBgColor: (ctx) => notificationIcons.joice.color,
            showChevron: false
        };

}