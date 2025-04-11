import {
  Controller,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';

@ApiTags('admin-notifications')
@Controller('admin/notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class AdminNotificationsController {
  // constructor(private readonly adminNotificationService: AdminNotificationService) {}

  // @Post('send-to-users')
  // @Roles('admin')
  // @ApiOperation({ summary: 'Envoyer une notification u00e0 plusieurs utilisateurs spu00e9cifiques' })
  // @ApiResponse({ status: 201, description: 'Notifications envoyu00e9es avec succu00e8s', type: [Notification] })
  // sendToUsers(@Body() adminNotificationDto: AdminNotificationToUsersDto): Promise<Notification[]> {
  //   return this.adminNotificationService.sendToUsers(adminNotificationDto);
  // }

  // @Post('broadcast')
  // @Roles('admin')
  // @ApiOperation({ summary: 'Diffuser une notification u00e0 tous les utilisateurs' })
  // @ApiResponse({ status: 201, description: 'Notification diffusu00e9e avec succu00e8s' })
  // broadcast(@Body() broadcastDto: AdminBroadcastNotificationDto): Promise<{ count: number }> {
  //   return this.adminNotificationService.broadcast(broadcastDto);
  // }

  // @Delete('cleanup')
  // @Roles('admin')
  // @HttpCode(HttpStatus.OK)
  // @ApiOperation({ summary: 'Nettoyer les anciennes notifications d\'un certain type' })
  // @ApiResponse({ status: 200, description: 'Notifications supprimu00e9es avec succu00e8s' })
  // cleanupOldNotifications(
  //   @Query('type') type: string,
  //   @Query('olderThan') olderThan?: string,
  // ): Promise<{ count: number }> {
  //   const olderThanDate = olderThan ? new Date(olderThan) : undefined;
  //   return this.adminNotificationService.cleanupOldNotifications(type, olderThanDate);
  // }
}
