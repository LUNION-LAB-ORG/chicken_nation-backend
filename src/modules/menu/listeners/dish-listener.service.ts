import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Dish, NotificationType, Prisma } from '@prisma/client';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { DishNotificationsTemplate } from '../templates/dish-notifications.template';

@Injectable()
export class DishListenerService {
    constructor(
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,
        private readonly dishNotificationsTemplate: DishNotificationsTemplate,
    ) { }

    @OnEvent('dish.created')
    async dishCreatedEventListener(payload: { // Renamed for clarity: userCreatedEventListener -> dishCreatedEventListener
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        dish: Dish
    }) {
        // Retrieve recipients
        const usersBackoffice = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const managers = await this.notificationRecipientService.getAllManagers();
        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);


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
            this.dishNotificationsTemplate.NEW_DISH_BACKOFFICE,
            notificationDataBackoffice,
            NotificationType.SYSTEM
        );
        // Real-time notification
        if (notificationsUserBackoffice.length > 0 && usersBackoffice.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationsUserBackoffice[0], usersBackoffice[0], true);
        }


        // 2- Notification to Restaurant Managers
        const notificationManagers = await this.notificationsService.sendNotificationToMultiple(
            this.dishNotificationsTemplate.NEW_DISH_RESTAURANT,
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

    @OnEvent('dish.updated')
    async dishUpdatedEventListener(payload: {
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        dish: Dish
    }) {
        // Retrieve recipients
        const usersBackoffice = await this.notificationRecipientService.getAllUsersByBackofficeAndRole();
        const managers = await this.notificationRecipientService.getAllManagers();
        const actorRecipient = this.notificationRecipientService.mapUserToNotificationRecipient(payload.actor);


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
            this.dishNotificationsTemplate.DISH_UPDATED_BACKOFFICE,
            notificationDataBackoffice,
            NotificationType.SYSTEM
        );
        // Real-time notification
        if (notificationsUserBackoffice.length > 0 && usersBackoffice.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationsUserBackoffice[0], usersBackoffice[0], true);
        }


        // 2- Notification to Restaurant Managers
        const notificationManagers = await this.notificationsService.sendNotificationToMultiple(
            this.dishNotificationsTemplate.DISH_UPDATED_RESTAURANT,
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