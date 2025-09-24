import { Injectable, Logger } from '@nestjs/common';
import { WebhookResponseDto } from '../dto/turbo-webhook.dto';
import { WebhookEvent } from '../enums/webhook-event.enum';

@Injectable()
export class TurboWebhookService {
  private readonly logger = new Logger(TurboWebhookService.name);

  // Lorsqu'une course est créée
  async handleDeliveryCreated(data: any): Promise<WebhookResponseDto> {
    this.logger.log(`✅ Livraison créée: ${JSON.stringify(data)}`);
    return {
      event: WebhookEvent.DELIVERY_CREATED,
      received: true,
      process: true,
    };
  }

  // Lorsqu'un livreur est affecté
  async handleCourierAssigned(data: any): Promise<WebhookResponseDto> {
    this.logger.log(`👷 Coursier assigné: ${JSON.stringify(data)}`);
    return {
      event: WebhookEvent.DELIVERY_COURIER_ASSIGNED,
      received: true,
      process: true,
    };
    // 👉 Ex: mise à jour en DB avec courier_id
  }

  // Lorsqu'une course est prise en charge
  async handlePickupStarted(data: any): Promise<WebhookResponseDto> {
    this.logger.log(`🚗 Pickup démarré: ${JSON.stringify(data)}`);
    return {
      event: WebhookEvent.DELIVERY_PICKUP_STARTED,
      received: true,
      process: true,
    };
  }

  // Lorsqu'une course est récupérée
  async handlePickedUp(data: any): Promise<WebhookResponseDto> {
    this.logger.log(`📦 Commande récupérée: ${JSON.stringify(data)}`);
    return {
      event: WebhookEvent.DELIVERY_PICKED_UP,
      received: true,
      process: true,
    };
  }

  // Lorsqu'une course est en cours de livraison
  async handleInTransit(data: any): Promise<WebhookResponseDto> {
    this.logger.log(`🛵 En transit: ${JSON.stringify(data)}`);
    return {
      event: WebhookEvent.DELIVERY_IN_TRANSIT,
      received: true,
      process: true,
    };
  }

  // Lorsqu'une course est livrée
  async handleDelivered(data: any): Promise<WebhookResponseDto> {
    this.logger.log(`🎉 Livraison terminée: ${JSON.stringify(data)}`);
    return {
      event: WebhookEvent.DELIVERY_DELIVERED,
      received: true,
      process: true,
    };
  }

  // Lorsqu'une course est annulée
  async handleCancelled(data: any): Promise<WebhookResponseDto> {
    this.logger.warn(`❌ Livraison annulée: ${JSON.stringify(data)}`);
    return {
      event: WebhookEvent.DELIVERY_CANCELLED,
      received: true,
      process: true,
    };
  }

  // Lorsqu'une course est annulée
  async handleLocationUpdated(data: any): Promise<WebhookResponseDto> {
    this.logger.debug(`📍 Position mise à jour: ${JSON.stringify(data)}`);
    return {
      event: WebhookEvent.COURIER_LOCATION_UPDATED,
      received: true,
      process: true,
    };
  }

  // Lorsqu'une course est annulée
  async handleEmergency(data: any): Promise<WebhookResponseDto> {
    this.logger.error(`🚨 Urgence détectée: ${JSON.stringify(data)}`);
    return {
      event: WebhookEvent.DELIVERY_EMERGENCY,
      received: true,
      process: true,
    };
  }
}
