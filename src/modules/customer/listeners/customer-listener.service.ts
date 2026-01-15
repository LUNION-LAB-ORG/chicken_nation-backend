import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType } from '@prisma/client';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { CUSTOMER_EVENTS } from '../contantes/customer-events.contante';
import { CustomerNotificationsTemplate } from '../templates/customer-notifications.template';

@Injectable()
export class CustomerListenerService {
    constructor(
        private readonly customerNotificationsTemplate: CustomerNotificationsTemplate,
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,
    ) { }

    @OnEvent(CUSTOMER_EVENTS.CUSTOMER_CREATED)
    async customerCreatedEventListener(payload: { customer: any }) {
        // Récupérer les administrateurs/backoffice
        const admins = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const adminsFiltered = admins.filter((u) => u.email !== payload.customer.email);

        // Préparer destinataire client
        const customerRecipient = this.notificationRecipientService.mapCustomerToNotificationRecipient(payload.customer);

        // Notifications aux admins
        const notificationsAdmin = await this.notificationsService.sendNotificationToMultiple(
            this.customerNotificationsTemplate.NEW_CUSTOMER,
            { actor: customerRecipient, recipients: adminsFiltered, data: payload },
            NotificationType.SYSTEM
        );
        for (const admin of adminsFiltered) {
            this.notificationsWebSocketService.emitNotification(notificationsAdmin[0], admin, true);
        }

        // Notification au client
        const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
            this.customerNotificationsTemplate.WELCOME_CUSTOMER,
            { actor: customerRecipient, recipients: [customerRecipient], data: payload },
            NotificationType.SYSTEM
        );
        this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], customerRecipient);
    }

    @OnEvent(CUSTOMER_EVENTS.CUSTOMER_ACTIVATED)
    async customerActivatedEventListener(payload: { customer: any }) {
        // TODO: envoi email + notifications pour l’activation
    }

    @OnEvent(CUSTOMER_EVENTS.CUSTOMER_DEACTIVATED)
    async customerDeactivatedEventListener(payload: { customer: any }) {
        // TODO: envoi email + notifications pour la désactivation
    }

    @OnEvent(CUSTOMER_EVENTS.CUSTOMER_DELETED)
    async customerDeletedEventListener(payload: { customer: any }) {
        // TODO: envoi email + notifications pour la suppression
    }
}
