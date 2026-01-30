import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ExpoPushService } from './expo-push.service';
import { SendNotificationDto } from './dto/send-notification.dto';

@ApiTags('Expo Push')
@Controller('expo-push')
export class ExpoPushController {
    constructor(private readonly pushService: ExpoPushService) { }

    @Post('send')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Envoyer une notification Push',
        description: 'Envoie une notification à une liste de tokens via Expo. Gère le chunking automatiquement.'
    })
    @ApiResponse({
        status: 200,
        description: 'Notifications transmises à Expo avec succès (Tickets créés).'
    })
    @ApiResponse({
        status: 400,
        description: 'Données invalides (validation DTO).'
    })
    async sendNotification(@Body() payload: SendNotificationDto) {
        return this.pushService.sendPushNotifications(payload);
    }
}