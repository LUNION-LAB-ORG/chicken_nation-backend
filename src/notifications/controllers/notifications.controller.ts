import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  UseGuards,
  Req,
  Patch,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from '../services/notifications.service';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import { UpdateNotificationPreferenceDto } from '../dto/update-notification-preference.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { Notification } from 'src/notifications/entities/notification.entity';
import { NotificationPreference } from 'src/notifications/entities/notification-preference.entity';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) { }

  @Post()
  @ApiOperation({ summary: 'Créer une nouvelle notification' })
  @ApiResponse({ status: 201, description: 'Notification créée avec succès', type: Notification })
  create(@Body() createNotificationDto: CreateNotificationDto): Promise<Notification> {
    return this.notificationsService.create(createNotificationDto);
  }

  @Get('user')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Récupérer les notifications de l\'utilisateur connecté' })
  @ApiResponse({ status: 200, description: 'Liste des notifications', type: [Notification] })
  findUserNotifications(@Req() req): Promise<Notification[]> {
    return this.notificationsService.findByUserId(req.user.id);
  }

  @Get('count')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Compter les notifications non lues de l\'utilisateur connecté' })
  @ApiResponse({ status: 200, description: 'Nombre de notifications non lues' })
  async countUnread(@Req() req): Promise<{ count: number }> {
    const notifications = await this.notificationsService.findByUserId(req.user.id);
    const unreadCount = notifications.filter(notif => !notif.isRead).length;
    return { count: unreadCount };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer une notification par ID' })
  @ApiResponse({ status: 200, description: 'Détails de la notification', type: Notification })
  findOne(@Param('id') id: string): Promise<Notification> {
    return this.notificationsService.findOne(id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Marquer une notification comme lue' })
  @ApiResponse({ status: 200, description: 'Notification mise à jour', type: Notification })
  markAsRead(@Param('id') id: string): Promise<Notification> {
    return this.notificationsService.markAsRead(id);
  }

  @Patch('read-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Marquer toutes les notifications de l\'utilisateur comme lues' })
  @ApiResponse({ status: 200, description: 'Notifications mises à jour' })
  @HttpCode(HttpStatus.OK)
  markAllAsRead(@Req() req): Promise<{ count: number }> {
    return this.notificationsService.markAllAsRead(req.user.id)
      .then(count => ({ count }));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer une notification' })
  @ApiResponse({ status: 200, description: 'Notification supprimée' })
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): Promise<{ success: boolean }> {
    return this.notificationsService.remove(id)
      .then(success => ({ success }));
  }

  @Get('preferences')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Récupérer les préférences de notification de l\'utilisateur' })
  @ApiResponse({ status: 200, description: 'Préférences de notification', type: NotificationPreference })
  getPreferences(@Req() req): Promise<NotificationPreference> {
    return this.notificationsService.getPreferences(req.user.id);
  }

  @Patch('preferences')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour les préférences de notification de l\'utilisateur' })
  @ApiResponse({ status: 200, description: 'Préférences mises à jour', type: NotificationPreference })
  updatePreferences(
    @Req() req,
    @Body() updateDto: UpdateNotificationPreferenceDto,
  ): Promise<NotificationPreference> {
    return this.notificationsService.updatePreferences(req.user.id, updateDto);
  }
}
