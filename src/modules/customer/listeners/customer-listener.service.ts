import { Injectable, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType } from '@prisma/client';
import { IEmailService } from 'src/modules/email/interfaces/email-service.interface';
import { CustomerEmailTemplates } from '../templates/customer-email.template';
import { CustomerNotificationsTemplate } from '../templates/customer-notifications.template';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { CUSTOMER_EVENTS } from '../contantes/customer-events.contante';

@Injectable()
export class CustomerListenerService {
    constructor(
        @Inject('EMAIL_SERVICE') private readonly emailService: IEmailService,
        private readonly customerEmailTemplates: CustomerEmailTemplates,
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
        const adminEmails = adminsFiltered.map((u) => u.email!);

        // Préparer destinataire client
        const customerRecipient = this.notificationRecipientService.mapCustomerToNotificationRecipient(payload.customer);
        const customerEmail = [customerRecipient.email!];

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

        // Envoi emails
        await this.emailService.sendEmailTemplate(
            this.customerEmailTemplates.NEW_CUSTOMER,
            { recipients: [...adminEmails, 'cedric.assah@lunion-lab.com', 'anderson.kouadio@lunion-lab.com'], data: payload }
        );

        await this.emailService.sendEmailTemplate(
            this.customerEmailTemplates.WELCOME_CUSTOMER,
            { recipients: customerEmail, data: payload }
        );
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
