import { Injectable } from '@nestjs/common';
import { NotificationType, NotificationTarget, Order } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationsTemplate } from '../templates/notifications.template';
import { NotificationRecipientsService } from './notifications-recipients.service';
import { NotificationsService } from './notifications.service';
import { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';
import { NotificationRecipient } from '../interfaces/notifications.interface';
import { notificationIcons } from '../constantes/notifications.constante';

@Injectable()
export class NotificationsSenderService {
    constructor(private readonly prisma: PrismaService, private readonly recipientsService: NotificationRecipientsService, private readonly notificationsService: NotificationsService) { }

    /**
     * Gère les notifications pour une commande créée
     */
    async handleOrderCreated(payload: OrderCreatedEvent) {

        const actor: NotificationRecipient | null = await this.recipientsService.getCustomer(payload.order.customer_id);

        if (!actor) return;

        const restaurantUsers = await this.recipientsService.getRestaurantUsers(payload.order.restaurant_id);

        const orderData = {
            reference: payload.order.reference,
            amount: payload.order.amount,
            restaurant_name: restaurantUsers[0]?.restaurant_name || 'Restaurant'
        };

        // Notification au client
        await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.ORDER_CREATED_CUSTOMER,
            { actor, recipients: [actor], data: orderData },
            NotificationType.ORDER
        );

        // Notifications au restaurant
        if (restaurantUsers.length > 0) {
            await this.notificationsService.sendNotificationToMultiple(
                NotificationsTemplate.ORDER_CREATED_RESTAURANT,
                { actor, recipients: restaurantUsers, data: orderData },
                NotificationType.ORDER
            );
        }
    }

    /**
     * Gère les notifications pour un changement de statut de commande
     */
    async handleOrderStatusUpdate(order: Order) {
        const actor = await this.recipientsService.getCustomer(order.customer_id);

        if (!actor) return;

        const restaurantUsers = await this.recipientsService.getRestaurantUsers(order.restaurant_id);

        const orderData = {
            reference: order.reference,
            status: order.status,
            amount: order.amount,
            restaurant_name: restaurantUsers[0]?.restaurant_name || 'Restaurant',
            customer_name: actor.name
        };

        // Toujours notifier le client du changement de statut
        await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.ORDER_STATUS_UPDATED_CUSTOMER,
            { actor, recipients: [actor], data: orderData },
            NotificationType.ORDER
        );
        // Toujours notifier le restaurant du changement de statut
        await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.ORDER_STATUS_UPDATED_RESTAURANT,
            { actor, recipients: restaurantUsers, data: orderData },
            NotificationType.ORDER
        );
    }

    /**
     * Gère les notifications de paiement
     */
    async handlePaymentCompleted(payment: any, order: any, customer: any) {
        const customerRecipient = await this.recipientsService.getCustomer(customer.id);
        if (!customerRecipient) return;

        const restaurantUsers = await this.recipientsService.getRestaurantUsers(order.restaurant_id);

        const paymentData = {
            reference: order.reference,
            amount: payment.amount,
            mode: payment.mode
        };

        const actor = customerRecipient;

        // Notification au client
        await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.PAYMENT_SUCCESS_CUSTOMER,
            { actor, recipients: [customerRecipient], data: paymentData },
            NotificationType.ORDER
        );

        // Notification au restaurant
        if (restaurantUsers.length > 0) {
            await this.notificationsService.sendNotificationToMultiple(
                NotificationsTemplate.PAYMENT_SUCCESS_RESTAURANT,
                { actor, recipients: restaurantUsers, data: paymentData },
                NotificationType.ORDER
            );
        }
    }

    /**
     * Gère les notifications de fidélité
     */
    async handleLoyaltyPointsEarned(customer: any, points: number, totalPoints: number, reason?: string) {
        const customerRecipient = await this.recipientsService.getCustomer(customer.id);
        if (!customerRecipient) return;

        await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.LOYALTY_POINTS_EARNED,
            {
                actor: customerRecipient,
                recipients: [customerRecipient],
                data: { points, total_points: totalPoints, reason }
            },
            NotificationType.SYSTEM
        );
    }

    async handleLoyaltyLevelUp(customer: any, newLevel: string, bonusPoints: number) {
        const customerRecipient = await this.recipientsService.getCustomer(customer.id);
        if (!customerRecipient) return;

        await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.LOYALTY_LEVEL_UP,
            {
                actor: customerRecipient,
                recipients: [customerRecipient],
                data: { new_level: newLevel, bonus_points: bonusPoints }
            },
            NotificationType.SYSTEM
        );
    }

    /**
     * Gère les notifications de promotions
     */
    async handlePromotionUsed(customer: any, promotion: any, discountAmount: number) {
        const customerRecipient = await this.recipientsService.getCustomer(customer.id);
        if (!customerRecipient) return;

        await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.PROMOTION_USED,
            {
                actor: customerRecipient,
                recipients: [customerRecipient],
                data: {
                    promotion_title: promotion.title,
                    discount_amount: discountAmount
                }
            },
            NotificationType.PROMOTION
        );
    }

    private getTargetFromRecipientType(type: string): NotificationTarget {
        return type === 'customer' ? NotificationTarget.CUSTOMER : NotificationTarget.USER;
    }
}