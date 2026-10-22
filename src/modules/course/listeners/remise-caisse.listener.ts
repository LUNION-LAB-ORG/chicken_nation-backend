import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderStatus, OrderType } from '@prisma/client';

import { OrderChannels } from 'src/modules/order/enums/order-channels';
import type { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';

import { CourseEnLivraisonService } from '../services/course-en-livraison.service';

/**
 * Bouton « Livreur a récupéré » de la caisse Sunmi et du backoffice
 * (`PATCH /orders/:id/status` vers PICKED_UP) : la course de la commande part
 * en livraison, comme par le code de retrait (CourseEnLivraisonService).
 *
 * Les autres chemins vers PICKED_UP ne passent pas ici ou n'y font rien : la
 * validation par code et la route du livreur écrivent la commande sans cet
 * événement, et le webhook Turbo ne concerne que des courses confiées à
 * Turbo, ignorées.
 */
@Injectable()
export class RemiseCaisseListener {
  private readonly logger = new Logger(RemiseCaisseListener.name);

  constructor(private readonly enLivraison: CourseEnLivraisonService) {}

  @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
  async onStatutCommande(payload: OrderCreatedEvent) {
    const order = payload?.order;
    if (!order || order.status !== OrderStatus.PICKED_UP || order.type !== OrderType.DELIVERY) return;
    try {
      await this.enLivraison.surCommandeRemise({ id: order.id, reference: order.reference });
    } catch (err) {
      // Ne casse jamais la mise à jour de la commande, déjà enregistrée.
      this.logger.error(
        `Départ de la course de la commande ${order.reference} impossible : ${(err as Error)?.message}`,
      );
    }
  }
}
