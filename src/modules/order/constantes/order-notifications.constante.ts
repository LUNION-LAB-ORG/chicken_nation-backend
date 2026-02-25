import { OrderStatus, PaymentMethod } from '@prisma/client';
import { notificationIcons } from 'src/modules/notifications/constantes/notifications.constante';

export const getOrderNotificationContent = (orderData: {
    reference: string;
    status: OrderStatus;
    amount: number;
    restaurant_name: string;
    customer_name: string;
    payment_method:PaymentMethod
}, type: 'customer' | 'restaurant') => {

    const statusConfig = {
      PENDING: {
            title: '🎉 Commande enregistrée !',
            message: type === 'customer' ?
                (orderData.payment_method === 'OFFLINE' ? 
                    `Votre commande #${orderData.reference} est prête. Confirmez votre présence sur l'app à votre arrivée pour lancer la cuisson !` : 
                    `Votre commande #${orderData.reference} est en attente de traitement chez ${orderData.restaurant_name}.`) :
                `Nouvelle commande #${orderData.reference} (${orderData.customer_name}). En attente de confirmation de présence du client.`,
            icon: notificationIcons.joice.url,
            iconBgColor: notificationIcons.joice.color,
        },
        ACCEPTED: {
            title: '🔥 Cuisson lancée !',
            message: type === 'customer' ?
                `C'est parti ! Votre présence est confirmée. ${orderData.restaurant_name} commence la cuisson de votre commande #${orderData.reference}.` :
                `Le client ${orderData.customer_name} a confirmé sa présence. Lancez la cuisson pour la commande #${orderData.reference} !`,
            icon: notificationIcons.ok.url,
            iconBgColor: notificationIcons.ok.color,
        },
        IN_PROGRESS: {
            title: '👨‍🍳 Commande en pleine préparation !',
            message: type === 'customer' ?
                `Votre commande #${orderData.reference} de ${orderData.restaurant_name} est activement en préparation. Ça sent bon !` :
                `La commande #${orderData.reference} pour ${orderData.customer_name} est en cours de préparation. Super ! Montant: ${orderData.amount} XOF.`,
            icon: notificationIcons.progress.url,
            iconBgColor: notificationIcons.progress.color,
        },
        READY: {
            title: '🍽️ Votre commande est prête !',
            message: type === 'customer' ?
                `Votre commande #${orderData.reference} chez ${orderData.restaurant_name} est prête pour la livraison ou la récupération. Préparez-vous à déguster !` :
                `Commande prête ! #${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF. Prête pour le départ !`,
            icon: notificationIcons.good.url,
            iconBgColor: notificationIcons.good.color,
        },
        PICKED_UP: {
            title: '🚗 Commande en route !',
            message: type === 'customer' ?
                `Votre commande #${orderData.reference} est en cours de livraison depuis ${orderData.restaurant_name}. Elle arrive très vite !` :
                `La commande #${orderData.reference} de ${orderData.customer_name} a été prise en charge par le livreur. Montant: ${orderData.amount} XOF.`,
            icon: notificationIcons.delivery.url,
            iconBgColor: notificationIcons.delivery.color,
        },
        COLLECTED: {
            title: '📦 Commande collectée avec succès !',
            message: type === 'customer' ?
                `Votre commande #${orderData.reference} a été collectée. Nous espérons que vous apprécierez votre repas de ${orderData.restaurant_name} !` :
                `La commande #${orderData.reference} de ${orderData.customer_name} a bien été collectée. Montant: ${orderData.amount} XOF.`,
            icon: notificationIcons.collected.url,
            iconBgColor: notificationIcons.collected.color,
        },
        COMPLETED: {
            title: '✅ Commande terminée !',
            message: type === 'customer' ?
                `Votre commande #${orderData.reference} de ${orderData.restaurant_name} a été livrée avec succès ! Merci d'avoir choisi Chicken Nation. 😊` :
                `La commande #${orderData.reference} de ${orderData.customer_name} est maintenant terminée. Montant: ${orderData.amount} XOF. Bravo !`,
            icon: notificationIcons.joice.url,
            iconBgColor: notificationIcons.joice.color,
        },
        CANCELLED: {
            title: '❌ Commande annulée',
            message: type === 'customer' ?
                `Désolé ! Votre commande #${orderData.reference} chez ${orderData.restaurant_name} a été annulée. Contactez le support pour plus d'infos.` :
                `Annulation : La commande #${orderData.reference} de ${orderData.customer_name} a été annulée. Montant: ${orderData.amount} XOF.`,
            icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524890.png',
            iconBgColor: '#DC3545',
        },
    };

    return statusConfig[orderData.status] || {
        title: '📋 Mise à jour de votre commande',
        message: type === 'customer' ?
            `Votre commande #${orderData.reference} a été mise à jour. Consultez les détails pour en savoir plus.` :
            `Une mise à jour a été effectuée pour la commande #${orderData.reference} de ${orderData.customer_name}. Montant: ${orderData.amount} XOF.`,
        icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524335.png', // Default icon
        iconBgColor: '#6C757D', // Default color
    };
}