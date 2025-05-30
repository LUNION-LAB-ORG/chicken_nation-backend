import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { NotificationType, NotificationTarget, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import { UpdateNotificationDto } from '../dto/update-notification.dto';
import { NotificationStatsDto } from '../dto/notifications-stats.dto';
import { QueryNotificationDto } from '../dto/query-notification.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { NotificationResponseDto } from '../dto/response-notification.dto';

@Injectable()
export class NotificationsService {
    constructor(private readonly prisma: PrismaService) { }

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
        const notificationData = this.getOrderNotificationContent(status, orderReference);

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
            icon: 'https://cdn-icons-png.flaticon.com/512/3514/3514491.png',
            icon_bg_color: '#FF6B35',
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
            icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524659.png',
            icon_bg_color: '#6C757D',
            show_chevron: false,
            data: additionalData,
        });
    }

    /**
     * Utilitaire pour obtenir le contenu des notifications de commande
     */
    private getOrderNotificationContent(status: string, orderReference: string) {
        const statusConfig = {
            PENDING: {
                title: '⏳ Commande en attente',
                message: `Votre commande ${orderReference} est en attente de confirmation.`,
                icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524335.png',
                iconBgColor: '#FFC107',
            },
            ACCEPTED: {
                title: '✅ Commande acceptée',
                message: `Votre commande ${orderReference} a été acceptée et est en préparation.`,
                icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524388.png',
                iconBgColor: '#28A745',
            },
            IN_PROGRESS: {
                title: '👨‍🍳 Commande en préparation',
                message: `Votre commande ${orderReference} est actuellement en préparation.`,
                icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524456.png',
                iconBgColor: '#17A2B8',
            },
            READY: {
                title: '🍽️ Commande prête',
                message: `Votre commande ${orderReference} est prête pour la livraison/récupération.`,
                icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524567.png',
                iconBgColor: '#28A745',
            },
            PICKED_UP: {
                title: '🚗 Commande en livraison',
                message: `Votre commande ${orderReference} est en cours de livraison.`,
                icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524678.png',
                iconBgColor: '#007BFF',
            },
            DELIVERED: {
                title: '📦 Commande livrée',
                message: `Votre commande ${orderReference} a été livrée avec succès.`,
                icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524789.png',
                iconBgColor: '#28A745',
            },
            CANCELLED: {
                title: '❌ Commande annulée',
                message: `Votre commande ${orderReference} a été annulée.`,
                icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524890.png',
                iconBgColor: '#DC3545',
            },
        };

        return statusConfig[status] || {
            title: '📋 Mise à jour de commande',
            message: `Votre commande ${orderReference} a été mise à jour.`,
            icon: 'https://cdn-icons-png.flaticon.com/512/3524/3524335.png',
            iconBgColor: '#6C757D',
        };
    }
}