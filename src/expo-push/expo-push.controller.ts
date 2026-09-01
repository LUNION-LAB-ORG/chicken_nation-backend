import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ExpoPushService } from './expo-push.service';
import { SendNotificationDto } from './dto/send-notification.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';

/**
 * ⚠️ Cette route n'avait AUCUNE garde, et il n'existe aucun garde global dans
 * le projet. Vérifié en production : elle répondait 400 et non 401, donc bien
 * joignable sans jeton. N'importe qui pouvant se procurer un jeton Expo
 * pouvait donc pousser une notification arbitraire au nom de la marque, et
 * brûler le quota d'envoi.
 *
 * Elle est conservée plutôt que supprimée, car un envoi de test a une valeur
 * réelle pour l'exploitation, mais elle est désormais réservée au marketing.
 */
@ApiTags('Expo Push')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
@Controller('expo-push')
export class ExpoPushController {
    constructor(private readonly pushService: ExpoPushService) { }

    @Post('send')
    @RequirePermission(Modules.MARKETING, Action.CREATE)
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