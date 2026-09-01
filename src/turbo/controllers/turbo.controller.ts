import { Controller, Post, Body, Headers, HttpCode, UnauthorizedException, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { TurboService } from '../services/turbo.service';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WebhookEventDto, WebhookResponseDto } from '../dto/turbo-webhook.dto';
import { TurboWebhookService } from '../services/turbo-webhook.service';
import { WebhookEvent } from '../enums/webhook-event.enum';

@ApiTags('Turbo')
@Controller('turbo')
export class TurboController {
  constructor(private readonly turboService: TurboService,
    private readonly turboWebhookService: TurboWebhookService
  ) { }

  /**
   * ⚠️ Route sans aucune garde, et sans appelant identifié dans les trois
   * façades. La clé passée dans le corps n'est pas vérifiée côté Chicken
   * Nation, elle est seulement transmise à Turbo : le seul garde-fou était
   * l'état de la commande. Réservée au personnel.
   *
   * ⚠️ Le webhook du même contrôleur reste volontairement hors garde : il est
   * appelé par Turbo, et son contrôle passe par la clé d'API.
   */
  @Post('creer-course')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  async creerCourse(@Body() body: { order_id: string, apikey: string }) {
    return this.turboService.creerCourse(body.order_id, body.apikey);
  }

  @Post('obtenir-frais-livraison')
  async obtenirFraisLivraison(@Body() body: { apikey: string, latitude: number, longitude: number }) {
    return this.turboService.obtenirFraisLivraison(body);
  }

  @Post('obtenir-frais-livraison-par-restaurant')
  async obtenirFraisLivraisonParRestaurant(@Body() body: { apikey: string}, @Query() query: { page?: number, size?: number }) {
    return this.turboService.obtenirFraisLivraisonParRestaurant(body.apikey, query?.page, query?.size);
  }

  /**
   * Validation du CODE CLIENT (4 chiffres) par un livreur Turbo.
   * Le code ne transite jamais chez eux : leur app nous envoie le code saisi,
   * nous répondons valide/invalide et clôturons la livraison si c'est bon.
   */
  @Post('livraison/valider-code')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Valider le code client saisi par un livreur Turbo',
    description:
      'Le livreur externe saisit le code à 4 chiffres communiqué par le client. ' +
      'Chicken Nation vérifie et clôture la livraison. La clé API doit être celle du restaurant de la commande.',
  })
  @ApiHeader({ name: 'X-API-KEY', description: 'Clé API du restaurant', required: true })
  @ApiResponse({ status: 200, description: '{ valid, message }' })
  async validerCodeClient(
    @Body()
    body: {
      numero: string;
      code: string;
      /** Encaissement à la livraison : code fermé du contrat (cash, orange-ci, mtn-ci, moov-ci, wave, card). */
      moyenPaiement?: string;
      /** Montant réellement encaissé (défaut : montant TTC de la commande). */
      montantEncaisse?: number;
      /** PAIEMENT PARTAGÉ : liste [{moyenPaiement, montantEncaisse}], une entrée par moyen. */
      encaissements?: { moyenPaiement?: string; montantEncaisse?: number }[];
    },
    @Headers('X-API-KEY') apiKey: string,
  ) {
    return this.turboWebhookService.validerCodeClient({
      numero: body?.numero,
      code: body?.code,
      apiKey,
      moyenPaiement: body?.moyenPaiement,
      montantEncaisse: body?.montantEncaisse,
      encaissements: body?.encaissements,
    });
  }

  @Post('webhook')
  @HttpCode(200)
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
    // 🔒 La clé doit appartenir à un restaurant connu (mode souple par défaut :
    // une clé inconnue est journalisée ; `TURBO_WEBHOOK_STRICT=true` la rejette).
    const auth = await this.turboWebhookService.verifierCleApi(apiKey);
    if (auth.reject) {
      return { event: 'unauthorized', received: true, process: false };
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
