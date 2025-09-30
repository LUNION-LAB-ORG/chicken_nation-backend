import { Controller, Post, Body, Headers, UnauthorizedException } from '@nestjs/common';
import { TurboService } from '../services/turbo.service';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WebhookEventDto, WebhookResponseDto } from '../dto/turbo-webhook.dto';
import { TurboWebhookService } from '../services/turbo-webhook.service';
import { TURBO_API_KEY } from '../constantes/turbo.constante';
import { WebhookEvent } from '../enums/webhook-event.enum';

@ApiTags('Turbo')
@Controller('turbo')
export class TurboController {
  constructor(private readonly turboService: TurboService,
    private readonly turboWebhookService: TurboWebhookService
  ) { }

  @Post('creer-course')
  async creerCourse(@Body() body: { order_id: string, apikey: string }) {
    return this.turboService.creerCourse(body.order_id, body.apikey);
  }

  @Post('obtenir-frais-livraison')
  async obtenirFraisLivraison(@Body() body: { apikey: string, latitude: number, longitude: number }) {
    return this.turboService.obtenirFraisLivraison(body);
  }

  @Post('obtenir-frais-livraison-par-restaurant')
  async obtenirFraisLivraisonParRestaurant(@Body() body: { apikey: string }) {
    return this.turboService.obtenirFraisLivraisonParRestaurant(body.apikey);
  }

  @Post('webhook')
  @ApiOperation({
    summary: 'Réception des événements webhook Turbo',
    description: 'Cet endpoint reçoit les différents statuts de livraison en temps réel.'
  })
  @ApiHeader({
    name: 'X-API-KEY',
    description: 'Clé API sécurisant le webhook',
    required: true,
  })
  @ApiBody({ type: WebhookEventDto })
  @ApiResponse({ status: 200, description: 'Webhook reçu avec succès', type: WebhookResponseDto })
  async handleEvent(
    @Body() body: WebhookEventDto,
    @Headers('X-API-KEY') apiKey: string,
  ) {
    if (!apiKey || apiKey !== TURBO_API_KEY) {
      return new UnauthorizedException({
        event: 'unauthorized',
        received: true,
        process: false,
      });
    }

    const { alias, data } = body;

    switch (alias) {
      // Lorsqu'une course est créée
      case WebhookEvent.DELIVERY_CREATED:
        return await this.turboWebhookService.handleDeliveryCreated(data);

      // Lorsqu'un livreur est affecté
      case WebhookEvent.DELIVERY_COURIER_ASSIGNED:
        return await this.turboWebhookService.handleCourierAssigned(data);

      // Lorsqu'une course est prise en charge
      case WebhookEvent.DELIVERY_PICKUP_STARTED:
        return await this.turboWebhookService.handlePickupStarted(data);

      // Lorsqu'une course est récupérée
      case WebhookEvent.DELIVERY_PICKED_UP:
        return await this.turboWebhookService.handlePickedUp(data);

      // Lorsqu'une course est en cours de livraison
      case WebhookEvent.DELIVERY_IN_TRANSIT:
        return await this.turboWebhookService.handleInTransit(data);

      // Lorsqu'une course est livrée
      case WebhookEvent.DELIVERY_DELIVERED:
        return await this.turboWebhookService.handleDelivered(data);

      // Lorsqu'une course est annulée
      case WebhookEvent.DELIVERY_CANCELLED:
        return await this.turboWebhookService.handleCancelled(data);

      // Lorsqu'une course est annulée
      case WebhookEvent.COURIER_LOCATION_UPDATED:
        return await this.turboWebhookService.handleLocationUpdated(data);

      // Lorsqu'une course est en urgence
      case WebhookEvent.DELIVERY_EMERGENCY:
        return await this.turboWebhookService.handleEmergency(data);

      default:
        console.warn(`⚠️ Event non géré: ${event}`);
        return {
          event,
          received: true,
          process: false,
        };
    }
  }
}
