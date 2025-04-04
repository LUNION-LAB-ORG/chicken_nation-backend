import { Controller, Get, Put, UseGuards, Request, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { NotificationSettingsService } from '../services/notification-settings.service';
import { UpdateNotificationSettingsDto } from '../dto/update-notification-settings.dto';

@ApiTags('notification-settings')
@Controller('user-profile/notification-settings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotificationSettingsController {
  constructor(private readonly notificationSettingsService: NotificationSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Récupérer les paramètres de notification' })
  @ApiResponse({ status: 200, description: 'Paramètres récupérés avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  async getNotificationSettings(@Request() req) {
    return this.notificationSettingsService.getNotificationSettings(req.user.userId);
  }

  @Put()
  @ApiOperation({ summary: 'Mettre à jour les paramètres de notification' })
  @ApiResponse({ status: 200, description: 'Paramètres mis à jour avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  async updateNotificationSettings(
    @Request() req,
    @Body() updateDto: UpdateNotificationSettingsDto,
  ) {
    return this.notificationSettingsService.updateNotificationSettings(req.user.userId, updateDto);
  }
}
