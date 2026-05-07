import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DeliveryService, OrderStatus, OrderType } from '@prisma/client';

import { OrderChannels } from 'src/modules/order/enums/order-channels';
import type { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';

import { CourseGroupingService } from '../services/course-grouping.service';

/**
 * Pont event : écoute les transitions de statut de Order et déclenche le
 * **regroupement intelligent** (Phase P3) quand une commande passe en READY.
 *
 * Conditions :
 *  - `Order.status === READY`
 *  - `Order.type === DELIVERY` (pas PICKUP ni TABLE)
 *  - `Order.delivery_service === CHICKEN_NATION` (livreurs internes uniquement)
 *
 * Flow :
 *  - `CourseGroupingService.tryGroupOrder()` rattache l'order à un batch existant
 *    compatible ou en crée un nouveau avec TTL (`course.batch_window_seconds`).
 *  - La Course n'est créée qu'au **flush** du batch (early si plafond atteint,
 *    sinon via le cron `CourseBatchTask` toutes les 10 s).
 *  - Plus de « 1 order = 1 course immédiate » — on maximise le grouping.
 */
@Injectable()
export class OrderBridgeListenerService {
  private readonly logger = new Logger(OrderBridgeListenerService.name);

  constructor(private readonly groupingService: CourseGroupingService) {}

  @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
  async onOrderStatusUpdated(payload: OrderCreatedEvent) {
    const { order } = payload;

    if (order.status !== OrderStatus.READY) return;
    if (order.type !== OrderType.DELIVERY) return;
    if (order.delivery_service !== DeliveryService.CHICKEN_NATION) return;

    this.logger.log(`Order ${order.reference} READY → tryGroupOrder`);

    try {
      const result = await this.groupingService.tryGroupOrder(order.id);
      this.logger.debug(
        `Order ${order.reference} → batch ${result.batchId}${result.flushed ? ' (flush immédiat)' : ''}`,
      );
    } catch (err) {
      // Ne casse pas le flow principal : log et continue
      this.logger.error(
        `Échec grouping pour order ${order.reference}: ${(err as Error).message}`,
      );
    }
  }
}
