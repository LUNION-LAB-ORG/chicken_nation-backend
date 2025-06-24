import { Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { NotificationsTemplate } from '../templates/notifications.template';
import { NotificationsService } from './notifications.service';
import { NotificationsWebSocketService } from '../websockets/notifications-websocket.service';
import { NotificationRecipientService } from '../recipients/notification-recipient.service';

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
}