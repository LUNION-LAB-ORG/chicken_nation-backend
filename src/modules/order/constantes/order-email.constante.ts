import { OrderStatus } from "@prisma/client";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";

export const getOrderEmailContent = (orderData: {
    reference: string;
    status: OrderStatus;
    amount: number;
    restaurant_name: string;
    customer_name: string;
    delivery_address?: string;
}, type: 'customer' | 'restaurant', emailComponentsService: EmailComponentsService) => {

    // Common order information for both customer and restaurant
    const commonOrderSummaryItems = [
        { label: 'Référence de commande', value: orderData.reference },
        { label: 'Montant', value: `${orderData.amount} XOF`, isTotal: true }, // Using isTotal for amount
    ];

    const customerOrderSummaryItems = [
        ...commonOrderSummaryItems,
        { label: 'Restaurant', value: orderData.restaurant_name },
        ...(orderData.delivery_address ? [{ label: 'Adresse de livraison', value: orderData.delivery_address }] : []),
    ];

    const restaurantOrderSummaryItems = [
        ...commonOrderSummaryItems,
        { label: 'Client', value: orderData.customer_name },
    ];

    const statusConfig = {
        PENDING: {
            subject: '🎉 Nouvelle commande en attente de validation',
            content: type === 'customer' ?
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.customer_name}`, '🎉'),
                    emailComponentsService.Message(`Votre commande #${orderData.reference} a été enregistrée avec succès et est en attente de validation par le restaurant ${orderData.restaurant_name}.`),
                    emailComponentsService.Summary(customerOrderSummaryItems),
                    // emailComponentsService.CtaButton('Suivre ma commande', 'YOUR_CUSTOMER_ORDER_TRACKING_LINK_HERE'), 
                    emailComponentsService.InfoBox('Vous recevrez une nouvelle notification par email dès que le restaurant aura accepté votre commande.', '⏱️'),
                ].join('\n') :
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.restaurant_name}`, '🎉'),
                    emailComponentsService.Title('Nouvelle Commande Reçue !', 2),
                    emailComponentsService.Message(`Vous avez une nouvelle commande #${orderData.reference} de ${orderData.customer_name} en attente de votre action. Veuillez la consulter et la valider dès que possible.`),
                    emailComponentsService.Summary(restaurantOrderSummaryItems),
                    // emailComponentsService.CtaButton('Voir la commande', 'YOUR_RESTAURANT_ORDER_LINK_HERE'), 
                    emailComponentsService.Alert('Veuillez traiter cette commande rapidement pour assurer une bonne expérience client.', 'warning'),
                ].join('\n'),
        },
        ACCEPTED: {
            subject: '✅ Votre commande a été acceptée !',
            content: type === 'customer' ?
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.customer_name}`, '✅'),
                    emailComponentsService.Message(`Bonne nouvelle ! Votre commande #${orderData.reference} a été acceptée par ${orderData.restaurant_name} et est maintenant en préparation.`),
                    emailComponentsService.Summary(customerOrderSummaryItems),
                    // emailComponentsService.CtaButton('Suivre ma commande', 'YOUR_CUSTOMER_ORDER_TRACKING_LINK_HERE'),
                    emailComponentsService.ToastNotification('Vous serez informé à chaque étape de l\'avancement de votre commande.', 'info'), // Toast for quick info
                ].join('\n') :
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.restaurant_name}`, '✅'),
                    emailComponentsService.Message(`La commande #${orderData.reference} de ${orderData.customer_name} a été acceptée et est en cours de préparation.`),
                    emailComponentsService.Summary(restaurantOrderSummaryItems),
                    emailComponentsService.Divider(),
                    emailComponentsService.InfoBox('Assurez-vous que la préparation se déroule sans accroc et mettez à jour le statut lorsque la commande est prête.', '📝'),
                ].join('\n'),
        },
        IN_PROGRESS: {
            subject: '👨‍🍳 Votre commande est en préparation',
            content: type === 'customer' ?
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.customer_name}`, '👨‍🍳'),
                    emailComponentsService.Message(`Votre commande #${orderData.reference} chez ${orderData.restaurant_name} est en pleine préparation. Encore un peu de patience !`),
                    emailComponentsService.Summary(customerOrderSummaryItems),
                    emailComponentsService.InfoBox('Le restaurant s\'attelle à préparer vos délicieux plats avec soin.', '🍳'),
                ].join('\n') :
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.restaurant_name}`, '👨‍🍳'),
                    emailComponentsService.Message(`La commande #${orderData.reference} de ${orderData.customer_name} est activement en préparation.`),
                    emailComponentsService.Summary(restaurantOrderSummaryItems),
                ].join('\n'),
        },
        READY: {
            subject: '🍽️ Votre commande est prête à être récupérée/livrée !',
            content: type === 'customer' ?
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.customer_name}`, '🍽️'),
                    emailComponentsService.Message(`Excellente nouvelle ! Votre commande #${orderData.reference} de ${orderData.restaurant_name} est prête. Elle sera bientôt en livraison ou vous pouvez la récupérer.`),
                    emailComponentsService.Summary(customerOrderSummaryItems),
                    // emailComponentsService.CtaButton('Suivre ma commande', 'YOUR_CUSTOMER_ORDER_TRACKING_LINK_HERE'),
                ].join('\n') :
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.restaurant_name}`, '🍽️'),
                    emailComponentsService.Message(`La commande #${orderData.reference} pour ${orderData.customer_name} est prête. Veuillez informer le livreur ou le client pour la récupération.`),
                    emailComponentsService.Summary(restaurantOrderSummaryItems),
                    emailComponentsService.Alert('La commande est prête. N\'oubliez pas de marquer son statut comme "Prise en charge" ou "Collectée" une fois qu\'elle quitte le restaurant.', 'info'),
                ].join('\n'),
        },
        PICKED_UP: {
            subject: '🚗 Votre commande est en route !',
            content: type === 'customer' ?
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.customer_name}`, '🚗'),
                    emailComponentsService.Message(`Votre commande #${orderData.reference} de ${orderData.restaurant_name} est maintenant en cours de livraison. Elle arrivera bientôt !`),
                    emailComponentsService.Summary(customerOrderSummaryItems),
                    // emailComponentsService.CtaButton('Suivre ma commande en direct', 'YOUR_CUSTOMER_ORDER_TRACKING_LINK_HERE', 'secondary'), // Different button variant
                    emailComponentsService.ToastNotification('Préparez-vous à déguster votre repas !', 'success'),
                ].join('\n') :
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.restaurant_name}`, '🚗'),
                    emailComponentsService.Message(`La commande #${orderData.reference} de ${orderData.customer_name} a été prise en charge par le livreur.`),
                    emailComponentsService.Summary(restaurantOrderSummaryItems),
                    emailComponentsService.InfoBox('Le livreur est en route vers le client. Vous pouvez suivre l\'avancement via votre tableau de bord.', '🚚'),
                ].join('\n'),
        },
        COLLECTED: {
            subject: '📦 Votre commande a été collectée !',
            content: type === 'customer' ?
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.customer_name}`, '📦'),
                    emailComponentsService.Message(`Votre commande #${orderData.reference} de ${orderData.restaurant_name} a bien été collectée. Nous espérons que vous l'apprécierez !`),
                    emailComponentsService.Summary(customerOrderSummaryItems),
                ].join('\n') :
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.restaurant_name}`, '📦'),
                    emailComponentsService.Message(`La commande #${orderData.reference} de ${orderData.customer_name} a été collectée par le client ou le livreur.`),
                    emailComponentsService.Summary(restaurantOrderSummaryItems),
                ].join('\n'),
        },
        COMPLETED: {
            subject: '✅ Votre commande est terminée !',
            content: type === 'customer' ?
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.customer_name}`, '✅'),
                    emailComponentsService.Message(`Votre commande #${orderData.reference} de ${orderData.restaurant_name} a été livrée et terminée avec succès. Merci d'avoir commandé chez nous !`),
                    emailComponentsService.Summary(customerOrderSummaryItems),
                    // emailComponentsService.CtaButton('Laisser un avis', 'YOUR_CUSTOMER_REVIEW_LINK_HERE'), // Optional: add a review link
                    // emailComponentsService.CtaButton('Commander à nouveau', 'YOUR_CUSTOMER_ORDER_AGAIN_LINK_HERE'),
                    emailComponentsService.Quote('Un grand merci pour votre confiance et à très bientôt pour de nouvelles saveurs !', 'L\'équipe Chicken Nation'), // Using Quote for a closing message
                ].join('\n') :
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.restaurant_name}`, '✅'),
                    emailComponentsService.Message(`La commande #${orderData.reference} de ${orderData.customer_name} a été marquée comme terminée.`),
                    emailComponentsService.Summary(restaurantOrderSummaryItems),
                    emailComponentsService.StatsGrid([
                        { label: 'Montant Total', value: `${orderData.amount} XOF`, icon: '💰', color: emailComponentsService['theme'].colors.status.success },
                        { label: 'Client', value: orderData.customer_name, icon: '👤', color: emailComponentsService['theme'].colors.primary },
                    ]),
                ].join('\n'),
        },
        CANCELLED: {
            subject: '❌ Votre commande a été annulée',
            content: type === 'customer' ?
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.customer_name}`, '❌'),
                    emailComponentsService.Alert(`Votre commande #${orderData.reference} chez ${orderData.restaurant_name} a été annulée.`, 'error'), // Using Alert for cancellation
                    emailComponentsService.Message('Nous sommes désolés pour ce désagrément. Si vous avez des questions, n\'hésitez pas à nous contacter.'),
                    emailComponentsService.Summary(customerOrderSummaryItems),
                    emailComponentsService.InfoBox('Contacter le support')
                ].join('\n') :
                [
                    emailComponentsService.Greeting(`Bonjour ${orderData.restaurant_name}`, '❌'),
                    emailComponentsService.Alert(`La commande #${orderData.reference} de ${orderData.customer_name} a été annulée.`, 'error'),
                    emailComponentsService.Message('Veuillez noter cette annulation dans vos registres.'),
                    emailComponentsService.Summary(restaurantOrderSummaryItems),
                ].join('\n'),
        },
    };

    return statusConfig[orderData.status] || {
        subject: '📋 Mise à jour de votre commande',
        content: type === 'customer' ?
            [
                emailComponentsService.Greeting(`Bonjour ${orderData.customer_name}`, '📋'),
                emailComponentsService.Message(`Votre commande #${orderData.reference} a été mise à jour. Veuillez consulter les détails ci-dessous.`),
                emailComponentsService.Summary(customerOrderSummaryItems),
                emailComponentsService.CtaButton('Voir les détails de ma commande', 'YOUR_CUSTOMER_ORDER_TRACKING_LINK_HERE'),
            ].join('\n') :
            [
                emailComponentsService.Greeting(`Bonjour ${orderData.restaurant_name}`, '📋'),
                emailComponentsService.Message(`La commande #${orderData.reference} de ${orderData.customer_name} a été mise à jour.`),
                emailComponentsService.Summary(restaurantOrderSummaryItems),
                emailComponentsService.CtaButton('Voir la commande', 'YOUR_RESTAURANT_ORDER_LINK_HERE'),
            ].join('\n'),
    };
};
