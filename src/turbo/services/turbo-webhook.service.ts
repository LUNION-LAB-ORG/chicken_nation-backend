import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WebhookResponseDto } from '../dto/turbo-webhook.dto';
import { WebhookEvent } from '../enums/webhook-event.enum';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { PrismaService } from 'src/database/services/prisma.service';
import { OrderStatus } from '@prisma/client';
import { OrderChannels } from 'src/modules/order/enums/order-channels';

/**
 * Réception des webhooks de suivi de livraison Turbo (Turbo → CN).
 *
 * ⚠️ Contrat Turbo (fixe) : `{ alias, data: { numero, courierId } }` où
 * `numero` = RÉFÉRENCE de la commande CN (jamais l'UUID — CN n'envoie que la
 * référence à la création). On retrouve donc la commande par `reference`.
 * Sur `created`, `courierId` porte l'id de la COURSE (aucun livreur assigné) →
 * on ne l'interprète JAMAIS comme un livreur.
 *
 * Chaque étape met à jour le statut de la commande CN et déclenche exactement
 * le même flux qu'une mise à jour de statut normale : temps réel (app +
 * backoffice + resto via AppGateway) + effets métier (fidélité sur COMPLETED,
 * notifications…) via l'EventEmitter `order:statusUpdated`. Tolérant : jamais
 * d'exception (donc plus de 500/400), idempotent, no-op si commande absente.
 */
@Injectable()
export class TurboWebhookService {
  private readonly logger = new Logger(TurboWebhookService.name);

  constructor(
    private readonly appGateway: AppGateway,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) { }

  private ack(event: WebhookEvent, process = true): WebhookResponseDto {
    return { event, received: true, process };
  }

  /** Retrouve la commande CN par la RÉFÉRENCE portée par `data.numero`. */
  private async resolveOrder(numero?: string) {
    if (!numero) return null;
    return this.prisma.order.findFirst({
      where: { reference: numero },
      include: {
        restaurant: true,
        customer: { include: { notification_settings: true } },
      },
    });
  }

  private statusMessage(status: OrderStatus): string {
    switch (status) {
      case OrderStatus.PICKED_UP:
        return 'Commande en livraison';
      case OrderStatus.COMPLETED:
        return 'Commande terminée';
      case OrderStatus.CANCELLED:
        return 'Commande annulée';
      default:
        return 'Statut mis à jour';
    }
  }

  /**
   * Applique un nouveau statut à la commande (idempotent) et propage :
   *  - temps réel UI (AppGateway → client, backoffice, restaurant) ;
   *  - effets métier via l'EventEmitter (fidélité, notifications…).
   */
  private async syncStatus(
    numero: string,
    newStatus: OrderStatus,
    alias: WebhookEvent,
  ): Promise<WebhookResponseDto> {
    const order = await this.resolveOrder(numero);
    if (!order) {
      this.logger.warn(`Webhook Turbo ${alias} : commande « ${numero} » introuvable.`);
      return this.ack(alias, false);
    }
    if (order.status === newStatus) {
      return this.ack(alias); // déjà à ce statut → rien à faire
    }

    const previousStatus = order.status;
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: newStatus,
        updated_at: new Date(),
        ...(newStatus === OrderStatus.PICKED_UP && { picked_up_at: new Date() }),
        ...(newStatus === OrderStatus.COMPLETED && { completed_at: new Date() }),
        ...(newStatus === OrderStatus.CANCELLED && {
          cancelled_at: new Date(),
          cancelled_reason: 'Annulée par Turbo',
        }),
      },
      include: {
        restaurant: true,
        customer: { include: { notification_settings: true } },
      },
    });

    // Temps réel UI — même canal/payload que les mises à jour de statut normales.
    const statusData = {
      order: updated,
      message: this.statusMessage(newStatus),
      previousStatus,
    };
    this.appGateway.emitToUser(updated.customer_id, 'customer', OrderChannels.ORDER_STATUS_UPDATED, statusData);
    this.appGateway.emitToBackoffice(OrderChannels.ORDER_STATUS_UPDATED, statusData);
    this.appGateway.emitToRestaurant(updated.restaurant_id, OrderChannels.ORDER_STATUS_UPDATED, statusData);

    // Effets métier (fidélité sur COMPLETED, notifications…) : même événement que
    // partout ailleurs → réutilise les listeners existants. Le listener Turbo
    // n'agit que sur READY → pas de boucle.
    this.eventEmitter.emit(OrderChannels.ORDER_STATUS_UPDATED, {
      order: updated,
      expo_token: updated.customer?.notification_settings?.expo_push_token,
    });

    this.logger.log(`Webhook Turbo ${alias} → commande ${numero} : ${previousStatus} → ${newStatus}.`);
    return this.ack(alias);
  }

  // ── Handlers par événement ────────────────────────────────────────────────

  /** Course créée côté Turbo : la commande est DÉJÀ READY (c'est ce qui a
   *  déclenché l'envoi). On accuse simplement réception — `courierId` = id de
   *  course, pas un livreur, donc on n'y touche pas. */
  async handleDeliveryCreated(data: any): Promise<WebhookResponseDto> {
    this.logger.log(`Course Turbo confirmée pour la commande ${data?.numero}.`);
    return this.ack(WebhookEvent.DELIVERY_CREATED);
  }

  async handleCourierAssigned(data: any): Promise<WebhookResponseDto> {
    this.logger.log(`Livreur Turbo assigné (commande ${data?.numero}).`);
    return this.ack(WebhookEvent.DELIVERY_COURIER_ASSIGNED);
  }

  async handlePickupStarted(data: any): Promise<WebhookResponseDto> {
    return this.syncStatus(data?.numero, OrderStatus.PICKED_UP, WebhookEvent.DELIVERY_PICKUP_STARTED);
  }

  async handlePickedUp(data: any): Promise<WebhookResponseDto> {
    return this.syncStatus(data?.numero, OrderStatus.PICKED_UP, WebhookEvent.DELIVERY_PICKED_UP);
  }

  async handleInTransit(data: any): Promise<WebhookResponseDto> {
    // Pas de statut « en transit » distinct côté CN : reste EN LIVRAISON (PICKED_UP).
    return this.syncStatus(data?.numero, OrderStatus.PICKED_UP, WebhookEvent.DELIVERY_IN_TRANSIT);
  }

  async handleDelivered(data: any): Promise<WebhookResponseDto> {
    return this.syncStatus(data?.numero, OrderStatus.COMPLETED, WebhookEvent.DELIVERY_DELIVERED);
  }

  async handleCancelled(data: any): Promise<WebhookResponseDto> {
    return this.syncStatus(data?.numero, OrderStatus.CANCELLED, WebhookEvent.DELIVERY_CANCELLED);
  }

  async handleLocationUpdated(data: any): Promise<WebhookResponseDto> {
    // Position livreur : pas de persistance côté CN pour l'instant.
    return this.ack(WebhookEvent.COURIER_LOCATION_UPDATED);
  }

  async handleEmergency(data: any): Promise<WebhookResponseDto> {
    this.logger.error(`🚨 Urgence Turbo (commande ${data?.numero}): ${JSON.stringify(data)}`);
    return this.ack(WebhookEvent.DELIVERY_EMERGENCY);
  }
}
