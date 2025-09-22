import { notificationIcons } from "src/modules/notifications/constantes/notifications.constante";
import { NotificationTemplate } from "src/modules/notifications/interfaces/notifications.interface";
import { Customer } from "@prisma/client";

export class CustomerNotificationsTemplate {
    /**
     * Notification de bienvenue au client nouvellement inscrit
     * Welcome the customer when their account is created.
     */
    WELCOME_CUSTOMER: NotificationTemplate<{
        customer: Customer
    }> = {
            title: (ctx) => `🎉 Bienvenue ${ctx.data.customer.first_name ?? ''} !`,
            message: (ctx) => {
                const fullname = `${ctx.data.customer.first_name ?? ''} ${ctx.data.customer.last_name ?? ''}`.trim();
                return `Bonjour ${fullname || ctx.data.customer.phone}, votre compte Chicken Nation est prêt ! Découvrez le menu et profitez de notre programme fidélité.`;
            },
            icon: (ctx) => notificationIcons.joice.url, // Joie pour marquer la bienvenue
            iconBgColor: (ctx) => notificationIcons.joice.color,
            showChevron: true // Pour ouvrir le dashboard / app client
        };

    /**
     * Notification aux administrateurs : un nouveau client vient de s’inscrire
     */
    NEW_CUSTOMER: NotificationTemplate<{
        customer: Customer
    }> = {
            title: (ctx) => `🆕 Nouveau client inscrit`,
            message: (ctx) => {
                const fullname = `${ctx.data.customer.first_name ?? ''} ${ctx.data.customer.last_name ?? ''}`.trim();
                return `${fullname || ctx.data.customer.phone} vient de rejoindre Chicken Nation.`;
            },
            icon: (ctx) => notificationIcons.ok.url, // Succès
            iconBgColor: (ctx) => notificationIcons.ok.color,
            showChevron: true // Pour ouvrir la fiche du client dans le backoffice
        };
}
