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
        // Récupérer les administrateurs/backoffice — en respectant la préférence
        // in-app de chaque membre (opt-out => ni persistance ni socket).
        const admins = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const adminsFiltered = admins.filter(
            (u) => u.email !== payload.customer.email && u.in_app_notifications_enabled !== false,
        );

        // Préparer destinataire client
        const customerRecipient = this.notificationRecipientService.mapCustomerToNotificationRecipient(payload.customer);

        // Notifications aux admins
        if (adminsFiltered.length > 0) {
            const fullname = `${payload.customer.first_name ?? ''} ${payload.customer.last_name ?? ''}`.trim();
            const notificationsAdmin = await this.notificationsService.sendNotificationToMultiple(
                this.customerNotificationsTemplate.NEW_CUSTOMER,
                {
                    actor: customerRecipient,
                    recipients: adminsFiltered,
                    data: payload,
                    // Persisté dans Notification.data → payload de navigation du front
                    // (clic cloche → page Clients filtrée sur ce client).
                    meta: {
                        kind: 'new_customer',
                        customer_id: payload.customer.id,
                        search: fullname || payload.customer.phone || '',
                    },
                },
                NotificationType.SYSTEM
            );
            // Emit CIBLÉ par admin (1 notification ↔ 1 destinataire). L'ancien code
            // broadcastait `group=true` DANS la boucle → la room backoffice recevait
            // N fois le même event (doublons visuels + N bips).
            notificationsAdmin.forEach((notif, i) => {
                this.notificationsWebSocketService.emitNotification(notif, adminsFiltered[i]);
            });
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
