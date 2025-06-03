import { Injectable } from '@nestjs/common';
import { NotificationType, NotificationTarget } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationsTemplates } from '../templates/notifications.template';
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

        const [restaurantUsers, backofficeUsers, restaurant] = await Promise.all([
            this.recipientsService.getRestaurantUsers(payload.order.restaurant_id),
            this.recipientsService.getBackofficeUsers(),
            this.prisma.restaurant.findUnique({
                where: { id: payload.order.restaurant_id },
                select: { name: true }
            })
        ]);

        const orderData = {
            reference: payload.order.reference,
            amount: payload.order.amount,
            restaurant_name: restaurant?.name || 'Restaurant'
        };

        // Notification au client
        await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplates.ORDER_CREATED_CUSTOMER,
            { actor, recipients: [actor], data: orderData },
            NotificationType.ORDER
        );

        // Notifications au restaurant
        if (restaurantUsers.length > 0) {
            await this.notificationsService.sendNotificationToMultiple(
                NotificationsTemplates.ORDER_CREATED_RESTAURANT,
                { actor, recipients: restaurantUsers, data: orderData },
                NotificationType.ORDER
            );
        }

        // Notifications au back office
        if (backofficeUsers.length > 0) {
            await this.notificationsService.sendNotificationToMultiple(
                NotificationsTemplates.ORDER_CREATED_BACKOFFICE,
                { actor, recipients: backofficeUsers, data: orderData },
                NotificationType.ORDER
            );
        }
    }

    /**
     * Gère les notifications pour un changement de statut de commande
     */
    async handleOrderStatusUpdate(order: any, customer: any, updatedByUser?: any) {
        const customerRecipient = await this.recipientsService.getCustomer(order.customer_id);
        if (!customerRecipient) return;

        const actor: NotificationRecipient = updatedByUser ? {
            id: updatedByUser.id,
            type: updatedByUser.type === 'BACKOFFICE' ? 'backoffice_user' : 'restaurant_user',
            name: updatedByUser.fullname
        } : customerRecipient;

        const orderData = {
            reference: order.reference,
            status: order.status,
            amount: order.amount
        };

        // Toujours notifier le client du changement de statut
        await this.notificationsService.sendNotificationToMultiple(
            NotificationsTemplates.ORDER_STATUS_UPDATED_CUSTOMER,
            { actor, recipients: [customerRecipient], data: orderData },
            NotificationType.ORDER
        );

        // Si c'est une commande terminée, notifier aussi le back office
        if (order.status === 'COMPLETED') {
            const backofficeUsers = await this.recipientsService.getBackofficeUsers();
            if (backofficeUsers.length > 0) {
                await this.notificationsService.sendNotificationToMultiple(
                    {
                        title: (ctx) => `✅ Commande terminée`,
                        message: (ctx) => `Commande ${ctx.data.reference} terminée avec succès. Montant: ${ctx.data.amount} XOF`,
                        icon: (ctx) => notificationIcons.collected.url,
                        iconBgColor: (ctx) => notificationIcons.collected.color,
                        showChevron: true
                    },
                    { actor, recipients: backofficeUsers, data: orderData },
                    NotificationType.ORDER
                );
            }
        }
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
            NotificationsTemplates.PAYMENT_SUCCESS_CUSTOMER,
            { actor, recipients: [customerRecipient], data: paymentData },
            NotificationType.ORDER
        );

        // Notification au restaurant
        if (restaurantUsers.length > 0) {
            await this.notificationsService.sendNotificationToMultiple(
                NotificationsTemplates.PAYMENT_SUCCESS_RESTAURANT,
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
            NotificationsTemplates.LOYALTY_POINTS_EARNED,
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
            NotificationsTemplates.LOYALTY_LEVEL_UP,
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
            NotificationsTemplates.PROMOTION_USED,
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