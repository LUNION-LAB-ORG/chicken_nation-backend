import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { NotificationType, NotificationTarget, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import { UpdateNotificationDto } from '../dto/update-notification.dto';
import { NotificationStatsDto } from '../dto/notifications-stats.dto';
import { QueryNotificationDto } from '../dto/query-notification.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { NotificationResponseDto } from '../dto/response-notification.dto';
import { getOrderNotificationContent, notificationIcons } from '../constantes/notifications.constante';
import { NotificationsTemplates } from '../templates/notifications.template';
import { NotificationRecipientsService } from './notifications-recipients.service';
import { NotificationContext, NotificationRecipient, NotificationTemplate } from '../interfaces/notifications.interface';

@Injectable()
export class NotificationsService {
    constructor(private readonly prisma: PrismaService, private readonly recipientsService: NotificationRecipientsService) { }

    /**
     * Créer une nouvelle notification
     */
    async create(createNotificationDto: CreateNotificationDto) {
        const notification = await this.prisma.notification.create({
            data: createNotificationDto,
        });

        return notification;
    }

    /**
     * Obtenir toutes les notifications avec pagination et filtres
     */
    async findAll(query: QueryNotificationDto): Promise<QueryResponseDto<NotificationResponseDto>> {
        const page = Number(query.page ?? 1);
        const limit = Number(query.limit ?? 10);
        const skip = (page - 1) * limit;

        const where: Prisma.NotificationWhereInput = {};

        if (query.userId) where.user_id = query.userId;
        if (query.target) where.target = query.target;
        if (query.type) where.type = query.type;
        if (query.isRead !== undefined) where.is_read = query.isRead;

        const [notifications, total] = await Promise.all([
            this.prisma.notification.findMany({
                where,
                skip,
                take: limit,
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.notification.count({ where }),
        ]);

        return {
            data: notifications,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Obtenir les notifications d'un utilisateur spécifique
     */
    async findByUser(query: Omit<QueryNotificationDto, 'userId' | 'target'>, userId: string, target: NotificationTarget): Promise<QueryResponseDto<NotificationResponseDto>> {
        const page = Number(query.page ?? 1);
        const limit = Number(query.limit ?? 10);
        const skip = (page - 1) * limit;

        const where: Prisma.NotificationWhereInput = {
            user_id: userId,
            target,
        };

        if (query.type) where.type = query.type;
        if (query.isRead !== undefined) where.is_read = query.isRead;

        const [notifications, total] = await Promise.all([
            this.prisma.notification.findMany({
                where,
                skip,
                take: limit,
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.notification.count({ where }),
        ]);

        return {
            data: notifications,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Obtenir une notification par son ID
     */
    async findOne(id: string) {
        const notification = await this.prisma.notification.findUnique({
            where: { id },
        });

        if (!notification) {
            throw new NotFoundException('Notification non trouvée');
        }

        return notification;
    }

    /**
     * Mettre à jour une notification
     */
    async update(id: string, updateNotificationDto: UpdateNotificationDto) {
        try {
            const notification = await this.prisma.notification.update({
                where: { id },
                data: {
                    ...updateNotificationDto,
                    updated_at: new Date(),
                },
            });

            return notification;
        } catch (error) {
            if (error.code === 'P2025') {
                throw new NotFoundException('Notification non trouvée');
            }
            throw new BadRequestException('Erreur lors de la mise à jour de la notification');
        }
    }

    /**
     * Marquer une notification comme lue
     */
    async markAsRead(id: string) {
        return this.update(id, { is_read: true });
    }

    /**
     * Marquer une notification comme non lue
     */
    async markAsUnread(id: string) {
        return this.update(id, { is_read: false });
    }

    /**
     * Marquer toutes les notifications d'un utilisateur comme lues
     */
    async markAllAsReadByUser(userId: string, target: NotificationTarget) {
        const result = await this.prisma.notification.updateMany({
            where: {
                user_id: userId,
                target,
                is_read: false,
            },
            data: {
                is_read: true,
                updated_at: new Date(),
            },
        });

        return {
            message: `${result.count} notification(s) marquée(s) comme lue(s)`,
            count: result.count,
        };
    }

    /**
     * Supprimer une notification
     */
    async remove(id: string) {
        try {
            await this.prisma.notification.delete({
                where: { id },
            });

            return { message: 'Notification supprimée avec succès' };
        } catch (error) {
            if (error.code === 'P2025') {
                throw new NotFoundException('Notification non trouvée');
            }
            throw new BadRequestException('Erreur lors de la suppression de la notification');
        }
    }

    /**
     * Supprimer toutes les notifications d'un utilisateur
     */
    async removeAllByUser(userId: string, target: NotificationTarget) {
        const result = await this.prisma.notification.deleteMany({
            where: {
                user_id: userId,
                target,
            },
        });

        return {
            message: `${result.count} notification(s) supprimée(s)`,
            count: result.count,
        };
    }

    /**
     * Obtenir les statistiques des notifications d'un utilisateur
     */
    async getStatsByUser(userId: string, target: NotificationTarget): Promise<NotificationStatsDto> {
        const [total, unread, typeStats] = await Promise.all([
            this.prisma.notification.count({
                where: { user_id: userId, target },
            }),
            this.prisma.notification.count({
                where: { user_id: userId, target, is_read: false },
            }),
            this.prisma.notification.groupBy({
                by: ['type'],
                where: { user_id: userId, target },
                _count: { type: true },
            }),
        ]);

        const byType = typeStats.reduce((acc, stat) => {
            acc[stat.type] = stat._count.type;
            return acc;
        }, {} as Record<string, number>);

        return {
            total,
            unread,
            read: total - unread,
            by_type: byType,
        };
    }

    /**
     * Nettoyer les anciennes notifications (plus de X jours)
     */
    async cleanupOldNotifications(daysOld: number = 30) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysOld);

        const result = await this.prisma.notification.deleteMany({
            where: {
                created_at: {
                    lt: cutoffDate,
                },
                is_read: true,
            },
        });

        return {
            message: `${result.count} ancienne(s) notification(s) supprimée(s)`,
            count: result.count,
        };
    }

    /**
     * Créer une notification de commande
     */
    async createOrderNotification(
        userId: string,
        target: NotificationTarget,
        orderReference: string,
        status: string,
        additionalData?: any
    ) {
        const notificationData = getOrderNotificationContent(status, orderReference);

        return this.create({
            title: notificationData.title,
            message: notificationData.message,
            type: NotificationType.ORDER,
            user_id: userId,
            target,
            icon: notificationData.icon,
            icon_bg_color: notificationData.iconBgColor,
            show_chevron: true,
            data: {
                order_reference: orderReference,
                status,
                ...additionalData,
            },
        });
    }

    /**
     * Créer une notification de promotion
     */
    async createPromotionNotification(
        userId: string,
        target: NotificationTarget,
        promotionTitle: string,
        promotionDescription: string,
        additionalData?: any
    ) {
        return this.create({
            title: `🎉 Nouvelle promotion: ${promotionTitle}`,
            message: promotionDescription,
            type: NotificationType.PROMOTION,
            user_id: userId,
            target,
            icon: notificationIcons.promotion.url,
            icon_bg_color: notificationIcons.promotion.color,
            show_chevron: true,
            data: {
                promotion_title: promotionTitle,
                ...additionalData,
            },
        });
    }

    /**
     * Créer une notification système
     */
    async createSystemNotification(
        userId: string,
        target: NotificationTarget,
        title: string,
        message: string,
        additionalData?: any
    ) {
        return this.create({
            title,
            message,
            type: NotificationType.SYSTEM,
            user_id: userId,
            target,
            icon: notificationIcons.setting.url,
            icon_bg_color: notificationIcons.setting.color,
            show_chevron: false,
            data: additionalData,
        });
    }

    /**
   * Envoie une notification à plusieurs destinataires avec un template
   */
    async sendNotificationToMultiple(
        template: NotificationTemplate,
        context: NotificationContext,
        notificationType: NotificationType
    ) {
        const notifications = context.recipients.map(recipient => {
            const notificationContext = { ...context, currentRecipient: recipient };

            return this.create({
                title: template.title(notificationContext),
                message: template.message(notificationContext),
                type: notificationType,
                user_id: recipient.id,
                target: this.getTargetFromRecipientType(recipient.type),
                icon: template.icon(notificationContext),
                icon_bg_color: template.iconBgColor(notificationContext),
                show_chevron: template.showChevron || false,
                data: context.data
            });
        });

        return Promise.all(notifications);
    }

    /**
     * Gère les notifications pour une commande créée
     */
    async handleOrderCreated(order: any, customer: any) {
        const actor: NotificationRecipient = {
            id: customer.id,
            type: 'customer',
            name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
        };

        const [restaurantUsers, backofficeUsers] = await Promise.all([
            this.recipientsService.getRestaurantUsers(order.restaurant_id),
            this.recipientsService.getBackofficeUsers()
        ]);

        const orderData = {
            reference: order.reference,
            amount: order.amount,
            restaurant_name: order.restaurant?.name || 'Restaurant'
        };

        // Notification au client
        await this.sendNotificationToMultiple(
            NotificationsTemplates.ORDER_CREATED_CUSTOMER,
            { actor, recipients: [actor], data: orderData },
            NotificationType.ORDER
        );

        // Notifications au restaurant
        if (restaurantUsers.length > 0) {
            await this.sendNotificationToMultiple(
                NotificationsTemplates.ORDER_CREATED_RESTAURANT,
                { actor, recipients: restaurantUsers, data: orderData },
                NotificationType.ORDER
            );
        }

        // Notifications au back office
        if (backofficeUsers.length > 0) {
            await this.sendNotificationToMultiple(
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
        await this.sendNotificationToMultiple(
            NotificationsTemplates.ORDER_STATUS_UPDATED_CUSTOMER,
            { actor, recipients: [customerRecipient], data: orderData },
            NotificationType.ORDER
        );

        // Si c'est une commande terminée, notifier aussi le back office
        if (order.status === 'COMPLETED') {
            const backofficeUsers = await this.recipientsService.getBackofficeUsers();
            if (backofficeUsers.length > 0) {
                await this.sendNotificationToMultiple(
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
        await this.sendNotificationToMultiple(
            NotificationsTemplates.PAYMENT_SUCCESS_CUSTOMER,
            { actor, recipients: [customerRecipient], data: paymentData },
            NotificationType.ORDER
        );

        // Notification au restaurant
        if (restaurantUsers.length > 0) {
            await this.sendNotificationToMultiple(
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

        await this.sendNotificationToMultiple(
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

        await this.sendNotificationToMultiple(
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

        await this.sendNotificationToMultiple(
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