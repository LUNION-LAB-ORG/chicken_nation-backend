import {
  Controller,
  Get,
  Patch,
  Param,
  Delete,
  Query,
  ParseUUIDPipe,
  ParseEnumPipe,
  ParseIntPipe,
  ParseBoolPipe,
  HttpStatus,
  UseGuards,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
  ApiOkResponse,
} from '@nestjs/swagger';
import { NotificationsService } from '../services/notifications.service';
import { NotificationType, NotificationTarget } from '@prisma/client';
import { NotificationResponseDto } from '../dto/response-notification.dto';
import { NotificationStatsDto } from '../dto/notifications-stats.dto';
import {
  NOTIFICATIONS_PAGE_MAX,
  NotificationOwner,
  notificationOwnerOf,
  ownsNotifications,
} from '../services/notification-owner.util';

/**
 * Cloche de notifications du personnel (backoffice) et des clients (appli).
 *
 * Chaque route ne touche QUE les notifications du porteur du jeton : le propriétaire est le
 * couple (id du principal, USER pour le personnel ou CUSTOMER pour le client).
 * - Routes user/:userId/:target et stats : le couple du chemin doit être celui du jeton (403).
 * - Routes par :id : la notification d'un autre répond 404, comme une notification inexistante.
 *
 * Retirées faute d'appelant, car elles ouvraient la cloche des autres :
 * POST / (création libre pour n'importe qui), GET / (liste de tout le monde) et
 * PATCH /:id (réécriture libre, y compris du destinataire). La création reste interne
 * (NotificationsService.create, sendNotificationToMultiple).
 *
 * PAS de CacheInterceptor : sa clé est l'URL seule, partagée entre tous les jetons, et il
 * répondait avant le contrôle du propriétaire. Les fronts ont déjà leur propre cache.
 */
@ApiTags('🔔 Notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(AuthGuard(['jwt', 'jwt-customer']))
export class NotificationsController {
  constructor(private readonly notificationService: NotificationsService) { }

  /**
   * Propriétaire des notifications accessibles au porteur du jeton (User OU Customer).
   */
  private ownerOf(req: Request): NotificationOwner {
    const owner = notificationOwnerOf(req.user);
    if (!owner) {
      throw new ForbiddenException('Accès non autorisé à ces notifications');
    }
    return owner;
  }

  /**
   * Empêche un utilisateur de lire/vider les notifications d'un AUTRE : le chemin porte un
   * couple (userId, target), on le compare à celui du jeton. 403 si l'un des deux diffère.
   */
  private assertSelf(req: Request, userId: string, target: NotificationTarget): NotificationOwner {
    const owner = notificationOwnerOf(req.user);
    if (!ownsNotifications(owner, userId, target)) {
      throw new ForbiddenException('Accès non autorisé à ces notifications');
    }
    return owner;
  }

  @Get('user/:userId/:target')
  @ApiOperation({
    summary: 'Obtenir les notifications d\'un utilisateur',
    description: `Récupère les notifications du porteur du jeton avec pagination (${NOTIFICATIONS_PAGE_MAX} au plus par page).`,
  })
  @ApiParam({
    name: 'userId',
    description: 'Identifiant de l\'utilisateur (celui du jeton)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiParam({
    name: 'target',
    enum: NotificationTarget,
    description: 'Cible de la notification (USER pour le personnel, CUSTOMER pour un client)',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Numéro de la page', example: 1 })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Nombre d'éléments par page (${NOTIFICATIONS_PAGE_MAX} au plus)`,
    example: 10,
  })
  @ApiQuery({ name: 'type', required: false, enum: NotificationType, description: 'Filtrer par type de notification' })
  @ApiQuery({ name: 'isRead', required: false, type: Boolean, description: 'Filtrer par statut de lecture' })
  @ApiOkResponse({
    description: 'Notifications de l\'utilisateur récupérées avec succès',
  })
  async findByUser(
    @Req() req: Request,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('target', new ParseEnumPipe(NotificationTarget)) target: NotificationTarget,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('type', new ParseEnumPipe(NotificationType, { optional: true })) type?: NotificationType,
    @Query('isRead', new ParseBoolPipe({ optional: true })) isRead?: boolean,
  ) {
    const owner = this.assertSelf(req, userId, target);
    return this.notificationService.findByUser(owner, { page, limit, type, isRead });
  }

  @Get('stats/:userId/:target')
  @ApiOperation({
    summary: 'Obtenir les statistiques des notifications',
    description: 'Récupère les statistiques des notifications d\'un utilisateur (total, non lues, par type).',
  })
  @ApiParam({
    name: 'userId',
    description: 'Identifiant de l\'utilisateur (celui du jeton)',
  })
  @ApiParam({
    name: 'target',
    enum: NotificationTarget,
    description: 'Cible de la notification',
  })
  @ApiOkResponse({
    description: 'Statistiques récupérées avec succès',
    type: NotificationStatsDto,
  })
  async getStats(
    @Req() req: Request,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('target', new ParseEnumPipe(NotificationTarget)) target: NotificationTarget,
  ) {
    const owner = this.assertSelf(req, userId, target);
    return this.notificationService.getStatsByUser(owner);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtenir une notification par ID',
    description: 'Récupère les détails d\'une notification du porteur du jeton.',
  })
  @ApiParam({
    name: 'id',
    description: 'Identifiant de la notification',
  })
  @ApiOkResponse({
    description: 'Notification récupérée avec succès',
    type: NotificationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Notification non trouvée',
  })
  async findOne(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.findOne(id, this.ownerOf(req));
  }

  @Patch(':id/read')
  @ApiOperation({
    summary: 'Marquer une notification comme lue',
    description: 'Change le statut d\'une notification du porteur du jeton à "lue".',
  })
  @ApiParam({
    name: 'id',
    description: 'Identifiant de la notification',
  })
  @ApiOkResponse({
    description: 'Notification marquée comme lue',
    type: NotificationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Notification non trouvée',
  })
  async markAsRead(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.markAsRead(id, this.ownerOf(req));
  }

  @Patch(':id/unread')
  @ApiOperation({
    summary: 'Marquer une notification comme non lue',
    description: 'Change le statut d\'une notification du porteur du jeton à "non lue".',
  })
  @ApiParam({
    name: 'id',
    description: 'Identifiant de la notification',
  })
  @ApiOkResponse({
    description: 'Notification marquée comme non lue',
    type: NotificationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Notification non trouvée',
  })
  async markAsUnread(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.markAsUnread(id, this.ownerOf(req));
  }

  @Patch('user/:userId/:target/read-all')
  @ApiOperation({
    summary: 'Marquer toutes les notifications comme lues',
    description: 'Marque toutes les notifications non lues d\'un utilisateur comme lues.',
  })
  @ApiParam({
    name: 'userId',
    description: 'Identifiant de l\'utilisateur (celui du jeton)',
  })
  @ApiParam({
    name: 'target',
    enum: NotificationTarget,
    description: 'Cible de la notification',
  })
  @ApiOkResponse({
    description: 'Notifications marquées comme lues',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: '5 notification(s) marquée(s) comme lue(s)' },
        count: { type: 'number', example: 5 },
      },
    },
  })
  async markAllAsRead(
    @Req() req: Request,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('target', new ParseEnumPipe(NotificationTarget)) target: NotificationTarget,
  ) {
    const owner = this.assertSelf(req, userId, target);
    return this.notificationService.markAllAsReadByUser(owner);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Supprimer une notification',
    description: 'Supprime définitivement une notification du porteur du jeton.',
  })
  @ApiParam({
    name: 'id',
    description: 'Identifiant de la notification',
  })
  @ApiOkResponse({
    description: 'Notification supprimée avec succès',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Notification supprimée avec succès' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Notification non trouvée',
  })
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.remove(id, this.ownerOf(req));
  }

  @Delete('user/:userId/:target')
  @ApiOperation({
    summary: 'Supprimer toutes les notifications d\'un utilisateur',
    description: 'Supprime toutes les notifications d\'un utilisateur.',
  })
  @ApiParam({
    name: 'userId',
    description: 'Identifiant de l\'utilisateur (celui du jeton)',
  })
  @ApiParam({
    name: 'target',
    enum: NotificationTarget,
    description: 'Cible de la notification',
  })
  @ApiOkResponse({
    description: 'Toutes les notifications de l\'utilisateur supprimées avec succès',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Toutes les notifications de l\'utilisateur supprimées avec succès' },
        count: { type: 'number', example: 5 },
      },
    },
  })
  async removeAllByUser(
    @Req() req: Request,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('target', new ParseEnumPipe(NotificationTarget)) target: NotificationTarget,
  ) {
    const owner = this.assertSelf(req, userId, target);
    return this.notificationService.removeAllByUser(owner);
  }
}
