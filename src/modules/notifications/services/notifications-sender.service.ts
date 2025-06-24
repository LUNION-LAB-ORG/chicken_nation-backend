import { Injectable } from '@nestjs/common';
import { NotificationType, Order, Category, Dish, Promotion, EntityStatus } from '@prisma/client';
import { NotificationsTemplate } from '../templates/notifications.template';
import { NotificationsService } from './notifications.service';
import { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';
import { NotificationRecipient } from '../interfaces/notifications.interface';
import { NotificationsWebSocketService } from './notifications-websocket.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationRecipientService } from '../recipients/notification-recipient.service';

@Injectable()
export class NotificationsSenderService {
    constructor(
        private readonly notificationRecipientService: NotificationRecipientService,
        private readonly notificationsService: NotificationsService,
        private readonly notificationsWebSocketService: NotificationsWebSocketService,
        private readonly prisma: PrismaService
    ) { }

    /**
     * Gère les notifications pour une commande créée
     */
    // async handleOrderCreated(payload: OrderCreatedEvent) {

    //     const actor: NotificationRecipient | null = await this.recipientsService.getCustomer(payload.order.customer_id);

    //     if (!actor) return;

    //     const restaurantUsers = await this.recipientsService.getRestaurantUsers(payload.order.restaurant_id);

    //     const orderData = {
    //         reference: payload.order.reference,
    //         amount: payload.order.amount,
    //         restaurant_name: restaurantUsers[0]?.restaurant_name || 'Restaurant'
    //     };

    //     // Notification au client
    //     const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
    //         NotificationsTemplate.ORDER_CREATED_CUSTOMER,
    //         { actor, recipients: [actor], data: orderData },
    //         NotificationType.ORDER
    //     );

    //     // Émettre l'événement de création de commande
    //     this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], actor);

    //     if (restaurantUsers.length > 0) {
    //         const notificationsRestaurant = await this.notificationsService.sendNotificationToMultiple(
    //             NotificationsTemplate.ORDER_CREATED_RESTAURANT,
    //             { actor, recipients: restaurantUsers, data: orderData },
    //             NotificationType.ORDER,
    //             true
    //         );
    //         this.notificationsWebSocketService.emitNotification(notificationsRestaurant[0], restaurantUsers[0], true);
    //     }
    // }

    /**
     * Gère les notifications pour un changement de statut de commande
     */
    async handleOrderStatusUpdate(order: Order) {
        const actor = await this.notificationRecipientService.getCustomer(order.customer_id);

        if (!actor) return;

        const restaurantUsers = await this.notificationRecipientService.getAllUsersByRestaurantAndRole(order.restaurant_id);

        const orderData = {
            reference: order.reference,
            status: order.status,
            amount: order.amount,
            restaurant_name: restaurantUsers[0]?.restaurant_name || 'Restaurant',
            customer_name: actor.name
        };

        // Toujours notifier le client du changement de statut
        const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.ORDER_STATUS_UPDATED_CUSTOMER,
            { actor, recipients: [actor], data: orderData },
            NotificationType.ORDER
        );
        this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], actor);

        // Toujours notifier le restaurant du changement de statut
        const notificationsRestaurant = await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.ORDER_STATUS_UPDATED_RESTAURANT,
            { actor, recipients: restaurantUsers, data: orderData },
            NotificationType.ORDER
        );
        this.notificationsWebSocketService.emitNotification(notificationsRestaurant[0], restaurantUsers[0]);
    }

    /**
     * Gère les notifications de paiement
     */
    async handlePaymentCompleted(payment: any, order: any, customer: any) {
        const customerRecipient = await this.notificationRecipientService.getCustomer(customer.id);
        if (!customerRecipient) return;

        const restaurantUsers = await this.notificationRecipientService.getAllUsersByRestaurantAndRole(order.restaurant_id);

        const paymentData = {
            reference: order.reference,
            amount: payment.amount,
            mode: payment.mode
        };

        const actor = customerRecipient;

        // Notification au client
        const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.PAYMENT_SUCCESS_CUSTOMER,
            { actor, recipients: [customerRecipient], data: paymentData },
            NotificationType.ORDER
        );
        this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], actor);

        // Notification au restaurant
        if (restaurantUsers.length > 0) {
            const notificationsRestaurant = await this.notificationsService.sendNotificationToMultiple(
                NotificationsTemplate.PAYMENT_SUCCESS_RESTAURANT,
                { actor, recipients: restaurantUsers, data: paymentData },
                NotificationType.ORDER
            );
            this.notificationsWebSocketService.emitNotification(notificationsRestaurant[0], restaurantUsers[0]);
        }
    }

    /**
     * Gère les notifications de fidélité
     */
    // async handleLoyaltyPointsEarned(customer: any, points: number, totalPoints: number, reason?: string) {
    //     const customerRecipient = await this.recipientsService.getCustomer(customer.id);
    //     if (!customerRecipient) return;

    //     const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
    //         NotificationsTemplate.LOYALTY_POINTS_EARNED,
    //         {
    //             actor: customerRecipient,
    //             recipients: [customerRecipient],
    //             data: { points, total_points: totalPoints, reason }
    //         },
    //         NotificationType.SYSTEM,
    //         true
    //     );
    //     this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], customerRecipient);
    // }

    async handleLoyaltyLevelUp(customer: any, newLevel: string, bonusPoints: number) {
        const customerRecipient = await this.notificationRecipientService.getCustomer(customer.id);
        if (!customerRecipient) return;

        const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplate.LOYALTY_LEVEL_UP,
            {
                actor: customerRecipient,
                recipients: [customerRecipient],
                data: { new_level: newLevel, bonus_points: bonusPoints }
            },
            NotificationType.SYSTEM
        );
        this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], customerRecipient);
    }

    /**
     * Gère les notifications de promotions
     */
    async handlePromotionUsed(customer: any, promotion: any, discountAmount: number) {
        const customerRecipient = await this.notificationRecipientService.getCustomer(customer.id);
        if (!customerRecipient) return;

        const notificationsCustomer = await this.notificationsService.sendNotificationToMultiple(
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
        this.notificationsWebSocketService.emitNotification(notificationsCustomer[0], customerRecipient);
    }

    /**
     * Gère les notifications de promotions
     */
    async handlePromotionCreated(promotion: Promotion) {
        // Notifier les restaurants
        const restaurants = await this.prisma.restaurant.findMany({
            where: { entity_status: EntityStatus.ACTIVE }, include: {
                users: true
            }
        });

        // restaurants.forEach(async (restaurant) => {
        //     const restaurantUsers = restaurant.users;
        //     if (!restaurantUsers) return;

        //     const notificationsRestaurant = await this.notificationsService.sendNotificationToMultiple(
        //         NotificationsTemplate.PROMOTION_AVAILABLE,
        //         {
        //             actor: { id: restaurant.id, type: 'restaurant_user', name: restaurant.name },
        //             recipients: restaurantUsers,
        //             data: {
        //                 promotion_title: promotion.title,
        //                 promotion_description: promotion.description
        //             }
        //         },
        //         NotificationType.PROMOTION,
        //         true
        //     );
        //     this.notificationsWebSocketService.emitNotification(notificationsRestaurant[0], restaurantUsers[0], true);
        // });

        // const restaurantUsers = await this.recipientsService.getAllRestaurantUsers();
        // const clients = await this.recipientsService.getCustomers();
        // const users = await this.recipientsService.getBackofficeUsers();

        // if (!restaurantUsers) return;

        // const notificationsRestaurant = await this.notificationsService.sendNotificationToMultiple(
        //     NotificationsTemplate.PROMOTION_AVAILABLE,
        //     {
        //         actor: restaurantUsers[0],
        //         recipients: [...restaurantUsers, ...clients, ...users],
        //         data: {
        //             promotion_title: promotion.title,
        //             promotion_description: promotion.description
        //         }
        //     },
        //     NotificationType.PROMOTION,
        //     true
        // );
        // this.notificationsWebSocketService.emitNotification(notificationsRestaurant[0], restaurantUsers[0], true);

    }

    /**
     * Gère les notifications de catégories
     */
    async handleCategoryCreatedOrUpdate(category: Category, update?: boolean) {
        const allRestaurantUsers = await this.notificationRecipientService.getAllManagers();
        if (!allRestaurantUsers) return;

        const notificationsRestaurant = await this.notificationsService.sendNotificationToMultiple(
            update ? NotificationsTemplate.CATEGORY_UPDATED : NotificationsTemplate.CATEGORY_CREATED,
            {
                actor: allRestaurantUsers[0],
                recipients: allRestaurantUsers,
                data: { category_name: category.name }
            },
            NotificationType.SYSTEM
        );
        this.notificationsWebSocketService.emitNotification(notificationsRestaurant[0], allRestaurantUsers[0]);
    }

    /**
     * Gère les notifications de plats
     */
    async handleDishCreatedOrUpdate(dish: Dish, update?: boolean) {
        const allRestaurantUsers = await this.notificationRecipientService.getAllManagers();
        if (!allRestaurantUsers) return;

        const notificationsRestaurant = await this.notificationsService.sendNotificationToMultiple(
            update ? NotificationsTemplate.DISH_UPDATED : NotificationsTemplate.DISH_CREATED,
            {
                actor: allRestaurantUsers[0],
                recipients: allRestaurantUsers,
                data: { dish_name: dish.name }
            },
            NotificationType.SYSTEM
        );
        this.notificationsWebSocketService.emitNotification(notificationsRestaurant[0], allRestaurantUsers[0]);
    }

}