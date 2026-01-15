import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { NotificationType } from "@prisma/client";
import { NotificationRecipientService } from "src/modules/notifications/recipients/notification-recipient.service";
import { NotificationsService } from "src/modules/notifications/services/notifications.service";
import { NotificationsWebSocketService } from "src/modules/notifications/websockets/notifications-websocket.service";
import { LoyaltyLevelUpEvent, LoyaltyPointsAddedEvent, LoyaltyPointsExpiredEvent, LoyaltyPointsExpiringSoonEvent, LoyaltyPointsRedeemedEvent } from "../interfaces/loyalty-event.interface";
import { LoyaltyNotificationsTemplate } from "../templates/loyalty-notifications.template";

@Injectable()
export class LoyaltyListenerService {
    constructor(
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,

        private readonly loyaltyNotificationsTemplate: LoyaltyNotificationsTemplate,
    ) { }

    /**
     * Handles the 'loyalty.pointsAdded' event.
     * Notifies the customer about new points earned.
     */
    @OnEvent('loyalty.pointsAdded')
    async handleLoyaltyPointsAdded(payload: LoyaltyPointsAddedEvent) {
        // --- Recipients ---
        const customer = await this.notificationRecipientService.getCustomer(payload.customer.id);

        // --- Notifications ---
        const notificationDataCustomer = {
            actor: customer,
            recipients: [customer],
            data: {
                actor: payload.customer,
                points: payload.points,
                orderReference: payload.orderReference,
            },
        };

        const notificationCustomer = await this.notificationsService.sendNotificationToMultiple(
            this.loyaltyNotificationsTemplate.LOYALTY_POINTS_ADDED,
            notificationDataCustomer,
            NotificationType.SYSTEM
        );

        // Notify in real-time
        if (notificationCustomer.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationCustomer[0], customer);
        }
    }

    /**
     * Handles the 'loyalty.pointsRedeemed' event.
     * Notifies the customer about points used.
     */
    @OnEvent('loyalty.pointsRedeemed')
    async handleLoyaltyPointsRedeemed(payload: LoyaltyPointsRedeemedEvent) {
        // --- Recipients ---
        const customer = await this.notificationRecipientService.getCustomer(payload.customer.id);

        // --- Notifications ---
        const notificationDataCustomer = {
            actor: customer,
            recipients: [customer],
            data: {
                actor: payload.customer,
                points: payload.points,
                orderReference: payload.orderReference,
            },
        };

        const notificationCustomer = await this.notificationsService.sendNotificationToMultiple(
            this.loyaltyNotificationsTemplate.LOYALTY_POINTS_REDEEMED,
            notificationDataCustomer,
            NotificationType.SYSTEM
        );

        // Notify in real-time
        if (notificationCustomer.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationCustomer[0], customer);
        }
    }

    /**
     * Handles the 'loyalty.levelUp' event.
     * Notifies the customer about reaching a new loyalty level.
     */
    @OnEvent('loyalty.levelUp')
    async handleLoyaltyLevelUp(payload: LoyaltyLevelUpEvent) {
        // --- Recipients ---
        const customer = await this.notificationRecipientService.getCustomer(payload.customer.id);

        // --- Notifications ---
        const notificationDataCustomer = {
            actor: customer,
            recipients: [customer],
            data: {
                actor: payload.customer,
                new_level: payload.new_level,
                bonus_points: payload.bonus_points,
            },
        };

        const notificationCustomer = await this.notificationsService.sendNotificationToMultiple(
            this.loyaltyNotificationsTemplate.LOYALTY_LEVEL_UP,
            notificationDataCustomer,
            NotificationType.SYSTEM
        );

        // Notify in real-time
        if (notificationCustomer.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationCustomer[0], customer);
        }
    }

    /**
     * Handles the 'loyalty.pointsExpiringSoon' event.
     * Notifies the customer about points nearing expiration.
     */
    @OnEvent('loyalty.pointsExpiringSoon')
    async handleLoyaltyPointsExpiringSoon(payload: LoyaltyPointsExpiringSoonEvent) {
        // --- Recipients ---
        const customer = await this.notificationRecipientService.getCustomer(payload.customer.id);

        // --- Notifications ---
        const notificationDataCustomer = {
            actor: customer,
            recipients: [customer],
            data: {
                actor: payload.customer,
                expiring_points: payload.expiring_points,
                days_remaining: payload.days_remaining,
            },
        };

        const notificationCustomer = await this.notificationsService.sendNotificationToMultiple(
            this.loyaltyNotificationsTemplate.POINTS_EXPIRING_SOON,
            notificationDataCustomer,
            NotificationType.SYSTEM
        );

        // Notify in real-time
        if (notificationCustomer.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationCustomer[0], customer);
        }
    }

    /**
     * Handles the 'loyalty.pointsExpired' event.
     * Notifies the customer about points that have expired.
     */
    @OnEvent('loyalty.pointsExpired')
    async handleLoyaltyPointsExpired(payload: LoyaltyPointsExpiredEvent) {
        // --- Recipients ---
        const customer = await this.notificationRecipientService.getCustomer(payload.customer.id);

        // --- Notifications ---
        const notificationDataCustomer = {
            actor: customer,
            recipients: [customer],
            data: {
                actor: payload.customer,
                expired_points: payload.expired_points,
            },
        };

        const notificationCustomer = await this.notificationsService.sendNotificationToMultiple(
            this.loyaltyNotificationsTemplate.POINTS_EXPIRED,
            notificationDataCustomer,
            NotificationType.SYSTEM
        );

        // Notify in real-time
        if (notificationCustomer.length > 0) {
            this.notificationsWebSocketService.emitNotification(notificationCustomer[0], customer);
        }
    }
}