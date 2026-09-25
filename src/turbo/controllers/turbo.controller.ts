import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { assertCanAccessRestaurant } from 'src/modules/order/helpers/restaurant-scope.helper';
import { TurboService } from '../services/turbo.service';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WebhookEventDto, WebhookResponseDto } from '../dto/turbo-webhook.dto';
import { TurboWebhookService } from '../services/turbo-webhook.service';
import { WebhookEvent } from '../enums/webhook-event.enum';

@ApiTags('Turbo')
@Controller('turbo')
export class TurboController {
  constructor(private readonly turboService: TurboService,
    private readonly turboWebhookService: TurboWebhookService,
    private readonly prisma: PrismaService,
  ) { }

  /**
   * Crée une course Turbo pour une commande prête (READY, livraison TURBO).
   *
   * ⚠️ Sans appelant identifié dans les applications : les courses partent
   * par le flux des courses (`creerCourseGroupe`). Réservée au personnel, et
   * seulement pour une commande de son restaurant ; un compte BACKOFFICE voit
   * tous les restaurants.
   *
   * La clé Turbo est celle du restaurant de la commande, lue en base. La clé
   * `apikey` du corps de la requête, autrefois transmise telle quelle à Turbo,
   * est ignorée : elle permettait d'envoyer le nom, le téléphone, l'e-mail et
   * l'adresse du client d'une commande de n'importe quel restaurant vers le
   * compte Turbo de son choix.
   *
   * ⚠️ Le webhook du même contrôleur reste volontairement hors garde : il est
   * appelé par Turbo, et son contrôle passe par la clé d'API.
   */
  @Post('creer-course')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  async creerCourse(@Req() req: Request, @Body() body: { order_id?: unknown }) {
    const orderId = body?.order_id;
    if (typeof orderId !== 'string' || !isUUID(orderId)) {
      throw new BadRequestException('Identifiant de commande invalide.');
    }

    const commande = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { restaurant_id: true, restaurant: { select: { apikey: true } } },
    });
    if (!commande) {
      throw new NotFoundException('Commande introuvable.');
    }
    assertCanAccessRestaurant(req.user as User, commande.restaurant_id);

    const cle = commande.restaurant?.apikey;
    if (!cle) {
      throw new BadRequestException("Ce restaurant n'a pas de clé Turbo.");
    }
    return this.turboService.creerCourse(orderId, cle);
  }

  // Les relais POST obtenir-frais-livraison et obtenir-frais-livraison-par-restaurant
  // ont été retirés. Sans garde ni limite de débit, ils transmettaient à Turbo
  // la clé fournie dans le corps de la requête : relais anonyme attribué à
  // l'adresse du serveur, et moyen de tester la validité d'une clé. Aucune
  // application ne les appelait. Les frais s'estiment par GET
  // /orders/frais-livraison, qui lit la clé du restaurant en base
  // (DeliveryFeeHelper) et ne la reçoit jamais de l'appelant.

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
        // `alias` et non `event` : ce nom ne désigne aucune variable ici, et
        // Node levait une ReferenceError (500) sur tout événement inconnu.
        console.warn(`Événement Turbo non géré : ${alias}`);
        return {
          event: alias,
          received: true,
          process: false,
        };
    }
  }
}
