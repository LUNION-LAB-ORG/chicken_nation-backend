
import { OrderStatus } from '@prisma/client';
import { join } from 'path';

export const notificationIcons = {
    collected: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/collected.png'),
        color: "#4CAF50" // Vert pour "collecté/terminé"
    },
    delivery: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/delivery.png'),
        color: "#FF5722" // Rouge-orange pour la livraison
    },
    good: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/good.png'),
        color: "#FFC107" // Jaune/doré pour "bon/positif"
    },
    joice: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/joice.png'),
        color: "#FFEB3B" // Jaune vif pour la joie/bonheur
    },
    ok: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/ok.png'),
        color: "#4CAF50" // Vert pour "ok/validé"
    },
    progress: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/progress.png'),
        color: "#03A9F4" // Bleu clair pour le progrès
    },
    promotion: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/promotion.png'),
        color: "#E91E63" // Rose/magenta pour les promotions
    },
    setting: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/setting.png'),
        color: "#607D8B" // Gris-bleu pour les paramètres
    },
    waiting: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/waiting.png'),
        color: "#795548" // Marron pour l'attente/temps
    }
}


export const getOrderNotificationContent = (orderData: {
    reference: string;
    status: OrderStatus;
    amount: number;
    restaurant_name: string;
    customer_name: string;
}, type: 'customer' | 'restaurant') => {
    const statusConfig = {
        ACCEPTED: {
            title: '✅ Commande acceptée',
            message: type === 'customer' ?
                `Votre commande ${orderData.reference} a été acceptée et est en préparation.` :
                `Commande ${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF`,
            icon: notificationIcons.ok.url,
            iconBgColor: notificationIcons.ok.color,
        },
        IN_PROGRESS: {
            title: '👨‍🍳 Commande en préparation',
            message: type === 'customer' ?
                `Votre commande ${orderData.reference} est actuellement en préparation.` :
                `Commande ${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF`,
            icon: notificationIcons.progress.url,
            iconBgColor: notificationIcons.progress.color,
        },
        READY: {
            title: '🍽️ Commande prête',
            message: type === 'customer' ?
                `Votre commande ${orderData.reference} est prête pour la livraison/récupération.` :
                `Commande ${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF`,
            icon: notificationIcons.good.url,
            iconBgColor: notificationIcons.good.color,
        },
        PICKED_UP: {
            title: '🚗 Commande en livraison',
            message: type === 'customer' ?
                `Votre commande ${orderData.reference} est en cours de livraison.` :
                `Commande ${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF`,
            icon: notificationIcons.delivery.url,
            iconBgColor: notificationIcons.delivery.color,
        },
        COLLECTED: {
            title: '📦 Commande collectée',
            message: type === 'customer' ?
                `Votre commande ${orderData.reference} a été collectée avec succès.` :
                `Commande ${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF`,
            icon: notificationIcons.collected.url,
            iconBgColor: notificationIcons.collected.color,
        },
        COMPLETED: {
            title: '✅ Commande terminée',
            message: type === 'customer' ?
                `Votre commande ${orderData.reference} a été terminée avec succès.` :
                `Commande ${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF`,
            icon: notificationIcons.joice.url,
            iconBgColor: notificationIcons.joice.color,
        },
        CANCELLED: {
            title: '❌ Commande annulée',
            message: type === 'customer' ?
                `Votre commande ${orderData.reference} a été annulée.` :
                `Commande ${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF`,
            icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524890.png',
            iconBgColor: '#DC3545',
        },
    };

    return statusConfig[orderData.status] || {
        title: '📋 Mise à jour de commande',
        message: type === 'customer' ?
            `Votre commande ${orderData.reference} a été mise à jour.` :
            `Nouvelle commande ${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF`,
        icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524335.png',
        iconBgColor: '#6C757D',
    };
}