import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LoyaltyPointType, NotificationType, OrderStatus } from '@prisma/client';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';
import { PromotionService } from 'src/modules/fidelity/services/promotion.service';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { OrderChannels } from '../enums/order-channels';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';
import { OrderNotificationsTemplate } from '../templates/order-notifications.template';

@Injectable()
export class OrderListenerService {
    constructor(
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly notificationsService: NotificationsService,
        private promotionService: PromotionService,
        private loyaltyService: LoyaltyService,

        private readonly orderNotificationsTemplate: OrderNotificationsTemplate,
    ) { }

    @OnEvent(OrderChannels.ORDER_CREATED)
    @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
    @OnEvent(OrderChannels.ORDER_UPDATED)
    @OnEvent(OrderChannels.ORDER_DELETED)
    async orderCreatedEventListener(payload: OrderCreatedEvent) {
        // PROMOTION USAGE
        if (payload.order.promotion_id) {
            if (payload.order.status === OrderStatus.PENDING && payload.totalDishes && payload.orderItems) {
                await this.promotionService.usePromotion(
                    payload.order.promotion_id,
                    payload.order.customer_id,
                    payload.order.id,
                    payload.totalDishes,
                    payload.orderItems,
                    payload.loyalty_level
                );
            }
        }

        // LOYALTY POINTS
        if (payload.order.points > 0) {
            //Utilisation des points
            if (payload.order.status === OrderStatus.PENDING) {
                await this.loyaltyService.redeemPoints({
                    customer_id: payload.order.customer_id,
                    points: payload.order.points,
                    reason: `Utilisation de ${payload.order.points} points de fidélité pour la commande #${payload.order.reference}` // Add order reference for clarity
                });
            }
        }

        // Attribution des points
        if (payload.order.status === OrderStatus.COMPLETED) {
            const pts = await this.loyaltyService.calculatePointsForOrder(payload.order.net_amount);
            console.log("pts", pts)
            if (pts > 0) {
                await this.loyaltyService.addPoints({
                    customer_id: payload.order.customer_id,
                    points: pts,
                    type: LoyaltyPointType.EARNED,
                    reason: `Vous avez gagné ${pts} points de fidélité pour votre commande`,
                    order_id: payload.order.id
                })
            }
        }

        // RECUPERATION DES RECEPTEURS
        const usersRestaurant = (await this.notificationRecipientService.getAllUsersByRestaurantAndRole(payload.order.restaurant_id));
        const customer = await this.notificationRecipientService.getCustomer(payload.order.customer_id);

        // PREPARATION DES DONNEES DE NOTIFICATIONS
        const notificationDataUsersRestaurant = {
            actor: customer,
            recipients: usersRestaurant,
            data: {
                reference: payload.order.reference,
                status: payload.order.status,
                amount: payload.order.amount,
                restaurant_name: payload.order.restaurant.name,
                customer_name: customer.name,
            },
        };
        const notificationDataRecipient = {
            actor: customer,
            recipients: [customer],
            data: {
                reference: payload.order.reference,
                status: payload.order.status,
                amount: payload.order.amount,
                restaurant_name: payload.order.restaurant.name,
                customer_name: customer.name,
            },
        };

        // ENVOIE DES NOTIFICATIONS
        // 1- NOTIFICATION AU RESTAURANT
        const notificationsUsersRestaurant = await this.notificationsService.sendNotificationToMultiple(
            this.orderNotificationsTemplate.NOTIFICATION_ORDER_RESTAURANT,
            notificationDataUsersRestaurant,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationsUsersRestaurant[0], usersRestaurant[0], true);

        // 2- NOTIFICATION AU CLIENT
        const notificationCustomer = await this.notificationsService.sendNotificationToMultiple(
            this.orderNotificationsTemplate.NOTIFICATION_ORDER_CUSTOMER,
            notificationDataRecipient,
            NotificationType.SYSTEM
        );
        // Notifier en temps réel
        this.notificationsWebSocketService.emitNotification(notificationCustomer[0], customer);

    }


}
