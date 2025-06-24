import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { NotificationType, NotificationTarget, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import { UpdateNotificationDto } from '../dto/update-notification.dto';
import { NotificationStatsDto } from '../dto/notifications-stats.dto';
import { QueryNotificationDto } from '../dto/query-notification.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { NotificationResponseDto } from '../dto/response-notification.dto';
import { NotificationContext, NotificationTemplate } from '../interfaces/notifications.interface';

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
       * Envoie une notification à plusieurs destinataires avec un template
       */
    async sendNotificationToMultiple<T>(
        template: NotificationTemplate<T>,
        context: NotificationContext<T>,
        notificationType: NotificationType,
    ) {
        const notifications = context.recipients.map(async recipient => {
            const notificationContext = { ...context, currentRecipient: recipient };

            const notification = this.create({
                title: template.title(notificationContext),
                message: template.message(notificationContext),
                type: notificationType,
                user_id: recipient.id,
                target: this.getTargetFromRecipientType(recipient.type),
                icon: template.icon(notificationContext),
                icon_bg_color: template.iconBgColor(notificationContext),
                show_chevron: template.showChevron || false,
                data: context.meta
            });
            return notification;
        });

        return Promise.all(notifications);
    }

    private getTargetFromRecipientType(type: string): NotificationTarget {
        return type === 'customer' ? NotificationTarget.CUSTOMER : NotificationTarget.USER;
    }
}