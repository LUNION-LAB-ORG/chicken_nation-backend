import { Injectable, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'src/database/services/prisma.service';
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
        private readonly prisma: PrismaService,
        @Inject('EMAIL_SERVICE') private readonly emailService: IEmailService,
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,

        private readonly categoryEmailTemplates: CategoryEmailTemplates,
        private readonly categoryNotificationsTemplate: CategoryNotificationsTemplate,
    ) { }

    @OnEvent('category.created')
    async userCreatedEventListener(payload: {
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        category: Category
    }) {
        // RECUPERATION DES RECEPTEURS
        const usersBackoffice = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const usersBackofficeEmail: string[] = usersBackoffice.map((user) => user.email!);
        const managers = await this.notificationRecipientService.getAllManagers();
        const managersEmail: string[] = managers.map((user) => user.email!);
        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);

        // ENVOIE DES EMAILS
        // 1- EMAIL AU BACKOFFICE
        await this.emailService.sendEmailTemplate(
            this.categoryEmailTemplates.NEW_CATEGORY_BACKOFFICE,
            {
                recipients: usersBackofficeEmail,
                data: payload,
            },
        );
        // 2- EMAIL AUX MANGERS DE RESTAURANT
        await this.emailService.sendEmailTemplate(
            this.categoryEmailTemplates.NEW_CATEGORY_RESTAURANT,
            {
                recipients: managersEmail,
                data: payload,
            },
        );
        // PREPARATION DES DONNEES DE NOTIFICATIONS
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
        // ENVOIE DES NOTIFICATIONS
        // 1- NOTIFICATION AU BACKOFFICE
        const notificationsUserBackoffice = await this.notificationsService.sendNotificationToMultiple(
            this.categoryNotificationsTemplate.NEW_CATEGORY_BACKOFFICE,
            notificationDataBackoffice,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationsUserBackoffice[0], usersBackoffice[0], true);

        // 2- NOTIFICATION AUX MANGERS DE RESTAURANT
        const notificationManagers = await this.notificationsService.sendNotificationToMultiple(
            this.categoryNotificationsTemplate.NEW_CATEGORY_RESTAURANT,
            notificationDataManagers,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        managers.forEach((manager) => {
            this.notificationsWebSocketService.emitNotification(notificationManagers[0], manager);
        });
    }
}
