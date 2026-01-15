import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType, Prisma, Restaurant } from '@prisma/client';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { RestaurantNotificationsTemplate } from '../templates/restaurant-notifications.template';

@Injectable()
export class RestaurantListenerService {
    constructor(
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,
        private readonly restaurantNotificationsTemplate: RestaurantNotificationsTemplate,
    ) { }

    @OnEvent('restaurant.created')
    async userCreatedEventListener(payload: {
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        restaurant: Restaurant
    }) {
        // RECUPERATION DES RECEPTEURS
        const usersBackoffice = (await this.notificationRecipientService.getAllUsersByBackofficeAndRole());

        const manager = (await this.notificationRecipientService.getManagerByRestaurant(payload.restaurant.id))[0];

        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);

        // PREPARATION DES DONNEES DE NOTIFICATIONS
        const notificationDataBackoffice = {
            actor: actorRecipient,
            recipients: usersBackoffice,
            data: payload,
        };
        const notificationDataRecipient = {
            actor: actorRecipient,
            recipients: [manager],
            data: payload,
        };
        // ENVOIE DES NOTIFICATIONS
        // 1- NOTIFICATION AU BACKOFFICE
        const notificationsUserBackoffice = await this.notificationsService.sendNotificationToMultiple(
            this.restaurantNotificationsTemplate.NEW_RESTAURANT_BACKOFFICE,
            notificationDataBackoffice,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationsUserBackoffice[0], usersBackoffice[0], true);

        // 2- NOTIFICATION AU MEMBRE
        const notificationmanager = await this.notificationsService.sendNotificationToMultiple(
            this.restaurantNotificationsTemplate.WELCOME_RESTAURANT,
            notificationDataRecipient,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationmanager[0], manager);
    }
}
