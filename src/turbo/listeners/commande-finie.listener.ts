import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderStatus, OrderType } from '@prisma/client';

import { OrderChannels } from 'src/modules/order/enums/order-channels';
import type { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';

import { TurboWebhookService } from '../services/turbo-webhook.service';

const STATUTS_COMMANDE_FINIE: OrderStatus[] = [OrderStatus.COLLECTED, OrderStatus.COMPLETED, OrderStatus.CANCELLED];

/**
 * Commande à livrer récupérée, terminée ou annulée : si elle est confiée à
 * Turbo, sa livraison et sa course se ferment (`fermerSuiviCommandeFinie`).
 */
@Injectable()
export class CommandeFinieListener {
  private readonly logger = new Logger(CommandeFinieListener.name);

  constructor(private readonly turboWebhook: TurboWebhookService) {}

  @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
  async onStatutCommande(payload: OrderCreatedEvent) {
    const order = payload?.order;
    if (!order || order.type !== OrderType.DELIVERY || !STATUTS_COMMANDE_FINIE.includes(order.status)) return;
    try {
      await this.turboWebhook.fermerSuiviCommandeFinie(order.id, order.status === OrderStatus.CANCELLED);
    } catch (err) {
      // Ne casse jamais la mise à jour de la commande, déjà enregistrée.
      this.logger.error(
        `Fermeture de la course de la commande ${order.reference} impossible : ${(err as Error)?.message}`,
      );
    }
  }
}
