import { Injectable } from '@nestjs/common';
import { NotificationType, PaymentMethod, UserRole } from '@prisma/client';
import { NotificationsTemplate } from '../templates/notifications.template';
import { NotificationsService } from './notifications.service';
import { NotificationsWebSocketService } from '../websockets/notifications-websocket.service';
import { NotificationRecipientService } from '../recipients/notification-recipient.service';
import { NotificationTemplate } from '../interfaces/notifications.interface';
import { getOrderNotificationContent } from 'src/modules/order/constantes/order-notifications.constante';

@Injectable()
export class NotificationsSenderService {
    constructor(
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsService: NotificationsService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
    ) { }

    /**
     * Gère les notifications de paiement
     */
    async handlePaymentCompleted(payment: any, order: any, customer: any) {
        const customerRecipient = await this.notificationRecipientService.getCustomer(customer.id);
        if (!customerRecipient) return;

        const restaurantUsers = await this.notificationRecipientService.getAllUsersByRestaurantAndRole(order.restaurant_id);

        const paymentData = {
            reference: order.reference,
            amount: payment.amount,
            mode: payment.mode
        };

        const actor = customerRecipient;

        // Notification au client
        const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.PAYMENT_SUCCESS_CUSTOMER,
            { actor, recipients: [customerRecipient], data: paymentData },
            NotificationType.ORDER
        );
        this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], actor);

        // Notification au restaurant
        if (restaurantUsers.length > 0) {
            const notificationsRestaurant = await this.notificationsService.sendNotificationToMultiple(
                NotificationsTemplate.PAYMENT_SUCCESS_RESTAURANT,
                { actor, recipients: restaurantUsers, data: paymentData },
                NotificationType.ORDER
            );
            this.notificationsWebSocketService.emitNotification(notificationsRestaurant[0], restaurantUsers[0]);
        }
    }

    /**
     * Notification CLOCHE « commande » au staff du restaurant (caisse / manager /
     * assistant-manager). Réutilise les contenus riches par statut de
     * getOrderNotificationContent. Persiste 1 ligne/destinataire + diffuse en temps
     * réel à la room du restaurant (event `notification:new` → cloche + bip).
     * `order` doit porter : id, reference, status, amount, restaurant_id, restaurant?.name,
     * fullname, payment_method.
     */
    async sendOrderBell(order: any) {
        if (!order?.restaurant_id) return;

        const recipients = await this.notificationRecipientService.getAllUsersByRestaurantAndRole(
            order.restaurant_id,
            [UserRole.CAISSIER, UserRole.MANAGER, UserRole.ASSISTANT_MANAGER],
        );
        if (recipients.length === 0) return;

        const content = getOrderNotificationContent(
            {
                reference: order.reference,
                status: order.status,
                amount: order.amount ?? 0,
                restaurant_name: order.restaurant?.name ?? '',
                customer_name: order.fullname ?? 'Client',
                payment_method: order.payment_method ?? PaymentMethod.ONLINE,
            },
            'restaurant',
        );

        // getOrderNotificationContent renvoie un objet PLAT ; le template attend des fonctions.
        const template: NotificationTemplate<any> = {
            title: () => content.title,
            message: () => content.message,
            icon: () => content.icon,
            iconBgColor: () => content.iconBgColor,
        };

        const notifications = await this.notificationsService.sendNotificationToMultiple(
            template,
            {
                actor: recipients[0],
                recipients,
                data: order,
                meta: { order_id: order.id, reference: order.reference, status: order.status },
            },
            NotificationType.ORDER,
        );
        // group=true → broadcast à la room restaurant_{id} (le client invalide sur notification:new).
        this.notificationsWebSocketService.emitNotification(notifications[0], recipients[0], true);
    }
}