import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { User } from "@prisma/client";

export class NotificationsTemplate {

    // Notification aux membres du backoffice
    static NEW_USER_BACKOFFICE: NotificationTemplate<User> = {
        title: (ctx) => `👥 Nouvel utilisateur`,
        message: (ctx) => `${ctx.actor.name} a rejoint votre équipe en tant que ${ctx.data.role}`,
        icon: (ctx) => notificationIcons.ok.url,
        iconBgColor: (ctx) => notificationIcons.ok.color,
        showChevron: false
    };

    // Notification aux membres du restaurant
    static NEW_USER_RESTAURANT: NotificationTemplate<User> = {
        title: (ctx) => `👥 Nouveau membre`,
        message: (ctx) => `${ctx.meta.name} a rejoint votre équipe en tant que ${ctx.meta.role}`,
        icon: (ctx) => notificationIcons.ok.url,
        iconBgColor: (ctx) => notificationIcons.ok.color,
        showChevron: false
    };

    // Notification à l'utilisateur
    static WELCOME_USER: NotificationTemplate<User> = {
        title: (ctx) => `🎉 Bienvenue ${ctx.actor.name} !`,
        message: (ctx) => `Merci de rejoindre notre communauté !`,
        icon: (ctx) => notificationIcons.joice.url,
        iconBgColor: (ctx) => notificationIcons.joice.color,
        showChevron: false
    };

}