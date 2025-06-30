import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseUUIDPipe,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { NotificationsService } from '../services/notifications.service';
import { NotificationType, NotificationTarget } from '@prisma/client';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import { NotificationResponseDto } from '../dto/response-notification.dto';
import { UpdateNotificationDto } from '../dto/update-notification.dto';
import { NotificationStatsDto } from '../dto/notifications-stats.dto';
import { QueryNotificationDto } from '../dto/query-notification.dto';

@ApiTags('🔔 Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationService: NotificationsService) { }

  @Post()
  @ApiOperation({
    summary: 'Créer une nouvelle notification',
    description: 'Permet de créer une nouvelle notification pour un utilisateur ou client spécifique.',
  })
  @ApiCreatedResponse({
    description: 'Notification créée avec succès',
    type: NotificationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Données invalides fournies',
  })
  async create(@Body() createNotificationDto: CreateNotificationDto) {
    return this.notificationService.create(createNotificationDto);
  }

  @Get()
  @ApiOperation({
    summary: 'Obtenir toutes les notifications',
    description: 'Récupère toutes les notifications avec pagination et filtres optionnels.',
  })
  @ApiOkResponse({
    description: 'Liste des notifications récupérée avec succès',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: { $ref: '#/components/schemas/NotificationResponseDto' },
        },
        pagination: {
          type: 'object',
          properties: {
            current_page: { type: 'number', example: 1 },
            per_page: { type: 'number', example: 10 },
            total: { type: 'number', example: 50 },
            total_pages: { type: 'number', example: 5 },
          },
        },
      },
    },
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Numéro de la page',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Nombre d\'éléments par page',
    example: 10,
  })
  @ApiQuery({
    name: 'userId',
    required: false,
    description: 'Filtrer par identifiant utilisateur',
  })
  @ApiQuery({
    name: 'target',
    required: false,
    enum: NotificationTarget,
    description: 'Filtrer par cible de notification',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: NotificationType,
    description: 'Filtrer par type de notification',
  })
  @ApiQuery({
    name: 'isRead',
    required: false,
    description: 'Filtrer par statut de lecture',
    type: Boolean,
  })
  async findAll(@Query() query: QueryNotificationDto) {
    return this.notificationService.findAll(query);
  }

  @Get('user/:userId/:target')
  @ApiOperation({
    summary: 'Obtenir les notifications d\'un utilisateur',
    description: 'Récupère toutes les notifications d\'un utilisateur spécifique avec pagination.',
  })
  @ApiParam({
    name: 'userId',
    description: 'Identifiant de l\'utilisateur',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiParam({
    name: 'target',
    enum: NotificationTarget,
    description: 'Cible de la notification (USER ou CUSTOMER)',
  })
  @ApiOkResponse({
    description: 'Notifications de l\'utilisateur récupérées avec succès',
  })
  async findByUser(@Query() query: Omit<QueryNotificationDto, 'userId' | 'target'>, @Param('userId', ParseUUIDPipe) userId: string, @Param('target') target: NotificationTarget) {
    return this.notificationService.findByUser(query, userId, target);
  }

  @Get('stats/:userId/:target')
  @ApiOperation({
    summary: 'Obtenir les statistiques des notifications',
    description: 'Récupère les statistiques des notifications d\'un utilisateur (total, non lues, par type).',
  })
  @ApiParam({
    name: 'userId',
    description: 'Identifiant de l\'utilisateur',
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
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('target') target: NotificationTarget,
  ) {
    return this.notificationService.getStatsByUser(userId, target);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtenir une notification par ID',
    description: 'Récupère les détails d\'une notification spécifique.',
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
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Mettre à jour une notification',
    description: 'Met à jour les informations d\'une notification existante.',
  })
  @ApiParam({
    name: 'id',
    description: 'Identifiant de la notification',
  })
  @ApiOkResponse({
    description: 'Notification mise à jour avec succès',
    type: NotificationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Notification non trouvée',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateNotificationDto: UpdateNotificationDto,
  ) {
    return this.notificationService.update(id, updateNotificationDto);
  }

  @Patch(':id/read')
  @ApiOperation({
    summary: 'Marquer une notification comme lue',
    description: 'Change le statut d\'une notification à "lue".',
  })
  @ApiParam({
    name: 'id',
    description: 'Identifiant de la notification',
  })
  @ApiOkResponse({
    description: 'Notification marquée comme lue',
    type: NotificationResponseDto,
  })
  async markAsRead(@Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.markAsRead(id);
  }

  @Patch(':id/unread')
  @ApiOperation({
    summary: 'Marquer une notification comme non lue',
    description: 'Change le statut d\'une notification à "non lue".',
  })
  @ApiParam({
    name: 'id',
    description: 'Identifiant de la notification',
  })
  @ApiOkResponse({
    description: 'Notification marquée comme non lue',
    type: NotificationResponseDto,
  })
  async markAsUnread(@Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.markAsUnread(id);
  }

  @Patch('user/:userId/:target/read-all')
  @ApiOperation({
    summary: 'Marquer toutes les notifications comme lues',
    description: 'Marque toutes les notifications non lues d\'un utilisateur comme lues.',
  })
  @ApiParam({
    name: 'userId',
    description: 'Identifiant de l\'utilisateur',
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
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('target') target: NotificationTarget,
  ) {
    return this.notificationService.markAllAsReadByUser(userId, target);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Supprimer une notification',
    description: 'Supprime définitivement une notification.',
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
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.remove(id);
  }

  @Delete('user/:userId/:target')
  @ApiOperation({
    summary: 'Supprimer toutes les notifications d\'un utilisateur',
    description: 'Supprime toutes les notifications d\'un utilisateur.',
  })
  @ApiParam({
    name: 'userId',
    description: 'Identifiant de l\'utilisateur',
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
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('target') target: NotificationTarget,
  ) {
    return this.notificationService.removeAllByUser(userId, target);
  }
}