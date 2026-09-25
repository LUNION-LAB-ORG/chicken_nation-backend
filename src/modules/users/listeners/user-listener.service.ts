import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType } from '@prisma/client';
import { UtilisateurAvecRestaurant } from 'src/modules/restaurant/constantes/restaurant-public.select';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { UserNotificationsTemplate } from '../templates/user-notifications.template';
import { CompteSansMotDePasse } from '../events/user.event';

@Injectable()
export class UserListenerService {
    private readonly logger = new Logger(UserListenerService.name);

    constructor(
        private readonly userNotificationsTemplate: UserNotificationsTemplate,
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,
    ) { }

    @OnEvent('user.created')
    async userCreatedEventListener(payload: {
        actor: UtilisateurAvecRestaurant,
        user: UtilisateurAvecRestaurant
    }) {
        // RECUPERATION DES RECEPTEURS
        const usersBackoffice = (await this.notificationRecipientService.getAllUsersByBackofficeAndRole()).filter((user) => user.email !== payload.user.email);
        const userRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.user);
        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);


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
        actor: UtilisateurAvecRestaurant,
        user: UtilisateurAvecRestaurant
    }) {
        // RECUPERATION DES RECEPTEURS
        const usersRestaurant = (await this.notificationRecipientService.getAllUsersByRestaurantAndRole(payload.actor.restaurant_id ?? "")).filter((user) => user.email !== payload.user.email);
        const userRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.user);
        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);

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

    /**
     * Les trois écouteurs suivants écrivaient la charge ENTIÈRE dans le journal,
     * haché du mot de passe compris, pour l'acteur comme pour la cible. On ne
     * garde que les identifiants et le rôle.
     */
    @OnEvent('user.activated')
    async userActivatedEventListener(payload: { actor: CompteSansMotDePasse, data: CompteSansMotDePasse }) {
        // TODO : Envoie email et notification au backoffice ou au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        this.logger.log(this.resume('réactivé', payload));
    }

    @OnEvent('user.deactivated')
    async userDeactivatedEventListener(payload: { actor: CompteSansMotDePasse, data: CompteSansMotDePasse }) {
        // TODO : Envoie email et notification au backoffice ou au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        this.logger.log(this.resume('suspendu', payload));
    }

    @OnEvent('user.deleted')
    async userDeletedEventListener(payload: { actor: CompteSansMotDePasse, data: CompteSansMotDePasse }) {
        // TODO : Envoie email et notification au backoffice ou au restaurant

        // TODO : Envoie email et notification à l'utilisateur
        this.logger.log(this.resume('supprimé', payload));
    }

    private resume(action: string, payload: { actor?: { id?: string } | null, data?: { id?: string, role?: string } | null }): string {
        return `Compte ${payload?.data?.id ?? 'inconnu'} (${payload?.data?.role ?? 'rôle inconnu'}) ${action} par ${payload?.actor?.id ?? 'inconnu'}`;
    }

}
