import { Injectable, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationType, Prisma, Dish } from '@prisma/client';
import { IEmailService } from 'src/modules/email/interfaces/email-service.interface';
import { DishEmailTemplates } from '../templates/dish-email.template';
import { DishNotificationsTemplate } from '../templates/dish-notifications.template';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/services/notifications-websocket.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';

@Injectable()
export class DishListenerService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject('EMAIL_SERVICE') private readonly emailService: IEmailService,
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,

        private readonly dishEmailTemplates: DishEmailTemplates,
        private readonly dishNotificationsTemplate: DishNotificationsTemplate,
    ) { }

    @OnEvent('dish.created')
    async userCreatedEventListener(payload: {
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        dish: Dish
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
            this.dishEmailTemplates.NEW_DISH_BACKOFFICE,
            {
                recipients: usersBackofficeEmail,
                data: payload,
            },
        );
        // 2- EMAIL AUX MANGERS DE RESTAURANT
        await this.emailService.sendEmailTemplate(
            this.dishEmailTemplates.NEW_DISH_RESTAURANT,
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
            this.dishNotificationsTemplate.NEW_DISH_BACKOFFICE,
            notificationDataBackoffice,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationsUserBackoffice[0], usersBackoffice[0], true);

        // 2- NOTIFICATION AUX MANGERS DE RESTAURANT
        const notificationManagers = await this.notificationsService.sendNotificationToMultiple(
            this.dishNotificationsTemplate.NEW_DISH_RESTAURANT,
            notificationDataManagers,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        managers.forEach((manager) => {
            this.notificationsWebSocketService.emitNotification(notificationManagers[0], manager);
        });
    }
}
