import { Injectable, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationType, Prisma, User } from '@prisma/client';
import { IEmailService } from 'src/modules/email/interfaces/email-service.interface';
import { UserEmailTemplates } from '../templates/user-email.template';
import { UserNotificationsTemplate } from '../templates/user-notifications.template';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';

@Injectable()
export class UserListenerService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject('EMAIL_SERVICE') private readonly emailService: IEmailService,
        private readonly userEmailTemplates: UserEmailTemplates,
        private readonly userNotificationsTemplate: UserNotificationsTemplate,
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,
    ) { }

    @OnEvent('user.created')
    async userCreatedEventListener(payload: {
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
    }) {
        // RECUPERATION DES RECEPTEURS
        const usersBackoffice = (await this.notificationRecipientService.getAllUsersByBackofficeAndRole()).filter((user) => user.email !== payload.user.email);
        const usersBackofficeEmail: string[] = usersBackoffice.map((user) => user.email!);
        const userRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.user);
        const userRecipientEmail: string[] = [userRecipient.email!];
        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);

        // ENVOIE DES EMAILS
        // 1- EMAIL AU BACKOFFICE
        await this.emailService.sendEmailTemplate(
            this.userEmailTemplates.NEW_USER,
            {
                recipients: usersBackofficeEmail,
                data: payload,
            },
        );
        // 2- EMAIL AU MEMBRE
        await this.emailService.sendEmailTemplate(
            this.userEmailTemplates.WELCOME_USER,
            {
                recipients: userRecipientEmail,
                data: payload,
            },
        );
        // PREPARATION DES DONNEES DE NOTIFICATIONS
        const notificationDataBackoffice = {
            actor: actorRecipient,
            recipients: usersBackoffice,
            data: payload,
        };
        const notificationDataRecipient = {
            actor: actorRecipient,
            recipients: [userRecipient],
            data: payload,
        };
        // ENVOIE DES NOTIFICATIONS
        // 1- NOTIFICATION AU BACKOFFICE
        const notificationsUserBackoffice = await this.notificationsService.sendNotificationToMultiple(
            this.userNotificationsTemplate.NEW_USER_BACKOFFICE,
            notificationDataBackoffice,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationsUserBackoffice[0], usersBackoffice[0], true);

        // 2- NOTIFICATION AU MEMBRE
        const notificationUserRecipient = await this.notificationsService.sendNotificationToMultiple(
            this.userNotificationsTemplate.WELCOME_USER,
            notificationDataRecipient,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationUserRecipient[0], userRecipient);

    }

    @OnEvent('member.created')
    async memberCreatedEventListener(payload: {
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
    }) {
        // RECUPERATION DES RECEPTEURS
        const usersRestaurant = (await this.notificationRecipientService.getAllUsersByRestaurantAndRole(payload.actor.restaurant_id ?? "")).filter((user) => user.email !== payload.user.email);
        const usersRestaurantEmail: string[] = usersRestaurant.map((user) => user.email!);
        const userRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.user);
        const userRecipientEmail: string[] = [userRecipient.email!];
        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);

        // ENVOIE DES EMAILS
        // 1- EMAIL AU RESTAURANT
        await this.emailService.sendEmailTemplate(
            this.userEmailTemplates.NEW_MEMBER,
            {
                recipients: usersRestaurantEmail,
                data: payload,
            },
        );
        // 2- EMAIL AU MEMBRE
        await this.emailService.sendEmailTemplate(
            this.userEmailTemplates.WELCOME_USER,
            {
                recipients: userRecipientEmail,
                data: payload,
            },
        );

        // PREPARATION DES DONNEES DE NOTIFICATIONS
        const notificationDataRestaurant = {
            actor: actorRecipient,
            recipients: usersRestaurant,
            data: payload,
        };
        const notificationDataRecipient = {
            actor: actorRecipient,
            recipients: [userRecipient],
            data: payload,
        };

        // ENVOIE DES NOTIFICATIONS
        // 1- NOTIFICATION AU RESTAURANT
        const notificationsMemberRestaurant = await this.notificationsService.sendNotificationToMultiple(
            this.userNotificationsTemplate.NEW_USER_RESTAURANT,
            notificationDataRestaurant,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationsMemberRestaurant[0], usersRestaurant[0], true);

        // 2- NOTIFICATION AU MEMBRE
        const notificationMemberRecipient = await this.notificationsService.sendNotificationToMultiple(
            this.userNotificationsTemplate.WELCOME_USER,
            notificationDataRecipient,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationMemberRecipient[0], userRecipient);
    }

    @OnEvent('user.activated')
    async userActivatedEventListener(payload: { actor: User, data: User }) {
        // TODO : Envoie email et notification au backoffice ou au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        console.log('User activated: ', payload);
    }

    @OnEvent('user.deactivated')
    async userDeactivatedEventListener(payload: { actor: User, data: User }) {
        // TODO : Envoie email et notification au backoffice ou au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        console.log('User deactivated: ', payload);
    }

    @OnEvent('user.deleted')
    async userDeletedEventListener(payload: { actor: User, data: User }) {
        // TODO : Envoie email et notification au backoffice ou au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        console.log('User deleted: ', payload);
    }

}
