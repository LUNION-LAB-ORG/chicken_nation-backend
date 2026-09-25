import { Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType, NotificationTarget, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import { NotificationStatsDto } from '../dto/notifications-stats.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { NotificationResponseDto } from '../dto/response-notification.dto';
import { NotificationContext, NotificationTemplate } from '../interfaces/notifications.interface';
import { NotificationOwner, normalizeNotificationPagination } from './notification-owner.util';

@Injectable()
export class NotificationsService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Créer une nouvelle notification.
     * Usage INTERNE uniquement (sendNotificationToMultiple et les producteurs du serveur) :
     * la route HTTP POST /notifications a été retirée, aucune application ne l'appelait.
     */
    async create(createNotificationDto: CreateNotificationDto) {
        const notification = await this.prisma.notification.create({
            data: createNotificationDto,
        });

        return notification;
    }

    /**
     * Obtenir les notifications d'un propriétaire (personnel ou client), avec pagination.
     * Le propriétaire est établi par le contrôleur à partir du jeton : on ne liste jamais
     * la cloche d'un autre. La taille de page est plafonnée (voir normalizeNotificationPagination).
     */
    async findByUser(
        owner: NotificationOwner,
        filters: { page?: number; limit?: number; type?: NotificationType; isRead?: boolean } = {},
    ): Promise<QueryResponseDto<NotificationResponseDto>> {
        const { page, limit, skip } = normalizeNotificationPagination(filters.page, filters.limit);

        const where: Prisma.NotificationWhereInput = {
            user_id: owner.user_id,
            target: owner.target,
        };

        if (filters.type) where.type = filters.type;
        if (filters.isRead !== undefined) where.is_read = filters.isRead;

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
     * Obtenir une notification par son ID, à condition qu'elle appartienne au propriétaire.
     * 404 dans le cas contraire : on ne confirme pas l'existence de la notification d'un autre.
     */
    async findOne(id: string, owner: NotificationOwner) {
        const notification = await this.prisma.notification.findFirst({
            where: { id, user_id: owner.user_id, target: owner.target },
        });

        if (!notification) {
            throw new NotFoundException('Notification non trouvée');
        }

        return notification;
    }

    /**
     * Changer l'état de lecture d'une notification du propriétaire.
     * updateMany filtré sur le propriétaire : l'appartenance et l'écriture se vérifient dans
     * la même requête. Seul is_read change ; la notification relue est renvoyée.
     */
    private async setReadState(id: string, owner: NotificationOwner, isRead: boolean) {
        const result = await this.prisma.notification.updateMany({
            where: { id, user_id: owner.user_id, target: owner.target },
            data: {
                is_read: isRead,
                updated_at: new Date(),
            },
        });

        if (result.count === 0) {
            throw new NotFoundException('Notification non trouvée');
        }

        return this.findOne(id, owner);
    }

    /**
     * Marquer une notification comme lue
     */
    async markAsRead(id: string, owner: NotificationOwner) {
        return this.setReadState(id, owner, true);
    }

    /**
     * Marquer une notification comme non lue
     */
    async markAsUnread(id: string, owner: NotificationOwner) {
        return this.setReadState(id, owner, false);
    }

    /**
     * Marquer toutes les notifications d'un propriétaire comme lues
     */
    async markAllAsReadByUser(owner: NotificationOwner) {
        const result = await this.prisma.notification.updateMany({
            where: {
                user_id: owner.user_id,
                target: owner.target,
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
     * Supprimer une notification du propriétaire (404 si elle n'est pas à lui)
     */
    async remove(id: string, owner: NotificationOwner) {
        const result = await this.prisma.notification.deleteMany({
            where: { id, user_id: owner.user_id, target: owner.target },
        });

        if (result.count === 0) {
            throw new NotFoundException('Notification non trouvée');
        }

        return { message: 'Notification supprimée avec succès' };
    }

    /**
     * Supprimer toutes les notifications d'un propriétaire
     */
    async removeAllByUser(owner: NotificationOwner) {
        const result = await this.prisma.notification.deleteMany({
            where: {
                user_id: owner.user_id,
                target: owner.target,
            },
        });

        return {
            message: `${result.count} notification(s) supprimée(s)`,
            count: result.count,
        };
    }

    /**
     * Obtenir les statistiques des notifications d'un propriétaire
     */
    async getStatsByUser(owner: NotificationOwner): Promise<NotificationStatsDto> {
        const where = { user_id: owner.user_id, target: owner.target };

        const [total, unread, typeStats] = await Promise.all([
            this.prisma.notification.count({
                where,
            }),
            this.prisma.notification.count({
                where: { ...where, is_read: false },
            }),
            this.prisma.notification.groupBy({
                by: ['type'],
                where,
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