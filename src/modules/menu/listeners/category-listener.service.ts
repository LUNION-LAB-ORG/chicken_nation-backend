import { Injectable, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Category, NotificationType, Prisma } from '@prisma/client';
import { IEmailService } from 'src/modules/email/interfaces/email-service.interface';
import { CategoryEmailTemplates } from '../templates/category-email.template';
import { CategoryNotificationsTemplate } from '../templates/category-notifications.template';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';

@Injectable()
export class CategoryListenerService {
    constructor(
        @Inject('EMAIL_SERVICE') private readonly emailService: IEmailService,
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,

        private readonly categoryEmailTemplates: CategoryEmailTemplates,
        private readonly categoryNotificationsTemplate: CategoryNotificationsTemplate,
    ) { }

    @OnEvent('category.created')
    async categoryCreatedEventListener(payload: { // Renamed for clarity: userCreatedEventListener -> categoryCreatedEventListener
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        category: Category
    }) {
        // Retrieve recipients
        const usersBackoffice = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const usersBackofficeEmail: string[] = usersBackoffice.map((user) => user.email!).filter(Boolean) as string[];
        const managers = await this.notificationRecipientService.getAllManagers();
        const managersEmail: string[] = managers.map((user) => user.email!).filter(Boolean) as string[];
        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);

        // Send Emails
        // 1- Email to Backoffice
        if (usersBackofficeEmail.length > 0) {
            await this.emailService.sendEmailTemplate(
                this.categoryEmailTemplates.NEW_CATEGORY_BACKOFFICE,
                {
                    recipients: usersBackofficeEmail,
                    data: payload,
                },
            );
        }
        // 2- Email to Restaurant Managers
        if (managersEmail.length > 0) {
            await this.emailService.sendEmailTemplate(
                this.categoryEmailTemplates.NEW_CATEGORY_RESTAURANT,
                {
                    recipients: managersEmail,
                    data: payload,
                },
            );
        }

        // Prepare Notification Data
        const notificationDataBackoffice = {
            actor: actorRecipient,
            recipients: usersBackoffice,
            data: payload,
        };
        const notificationDataManagers = {
            actor: actorRecipient,
            recipients: managers,
            data: payload,
        };

        // Send Notifications
        // 1- Notification to Backoffice
        const notificationsUserBackoffice = await this.notificationsService.sendNotificationToMultiple(
            this.categoryNotificationsTemplate.NEW_CATEGORY_BACKOFFICE,
            notificationDataBackoffice,
            NotificationType.SYSTEM
        );
        // Real-time notification
        if (notificationsUserBackoffice.length > 0 && usersBackoffice.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationsUserBackoffice[0], usersBackoffice[0], true);
        }


        // 2- Notification to Restaurant Managers
        const notificationManagers = await this.notificationsService.sendNotificationToMultiple(
            this.categoryNotificationsTemplate.NEW_CATEGORY_RESTAURANT,
            notificationDataManagers,
            NotificationType.SYSTEM
        );
        // Real-time notification
        notificationManagers.forEach((notification) => { // Iterate through all sent notifications
            const correspondingRecipient = managers.find(m => m.id === notification.user_id); // Find recipient for this specific notification
            if (correspondingRecipient) {
                this.notificationsWebSocketService.emitNotification(notification, correspondingRecipient);
            }
        });
    }

    @OnEvent('category.updated')
    async categoryUpdatedEventListener(payload: {
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        category: Category
    }) {
        // Retrieve recipients
        const usersBackoffice = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const usersBackofficeEmail: string[] = usersBackoffice.map((user) => user.email!).filter(Boolean) as string[];
        const managers = await this.notificationRecipientService.getAllManagers();
        const managersEmail: string[] = managers.map((user) => user.email!).filter(Boolean) as string[];
        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);

        // Send Emails
        // 1- Email to Backoffice
        if (usersBackofficeEmail.length > 0) {
            await this.emailService.sendEmailTemplate(
                this.categoryEmailTemplates.CATEGORY_UPDATED_BACKOFFICE,
                {
                    recipients: usersBackofficeEmail,
                    data: payload,
                },
            );
        }
        // 2- Email to Restaurant Managers
        if (managersEmail.length > 0) {
            await this.emailService.sendEmailTemplate(
                this.categoryEmailTemplates.CATEGORY_UPDATED_RESTAURANT,
                {
                    recipients: managersEmail,
                    data: payload,
                },
            );
        }

        // Prepare Notification Data
        const notificationDataBackoffice = {
            actor: actorRecipient,
            recipients: usersBackoffice,
            data: payload,
        };
        const notificationDataManagers = {
            actor: actorRecipient,
            recipients: managers,
            data: payload,
        };

        // Send Notifications
        // 1- Notification to Backoffice
        const notificationsUserBackoffice = await this.notificationsService.sendNotificationToMultiple(
            this.categoryNotificationsTemplate.CATEGORY_UPDATED_BACKOFFICE,
            notificationDataBackoffice,
            NotificationType.SYSTEM
        );
        // Real-time notification
        if (notificationsUserBackoffice.length > 0 && usersBackoffice.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationsUserBackoffice[0], usersBackoffice[0], true);
        }


        // 2- Notification to Restaurant Managers
        const notificationManagers = await this.notificationsService.sendNotificationToMultiple(
            this.categoryNotificationsTemplate.CATEGORY_UPDATED_RESTAURANT,
            notificationDataManagers,
            NotificationType.SYSTEM
        );
        // Real-time notification
        notificationManagers.forEach((notification) => { // Iterate through all sent notifications
            const correspondingRecipient = managers.find(m => m.id === notification.user_id); // Find recipient for this specific notification
            if (correspondingRecipient) {
                this.notificationsWebSocketService.emitNotification(notification, correspondingRecipient);
            }
        });
    }
}