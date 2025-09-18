import { Injectable } from '@nestjs/common';
import { UpdateOrderDto } from '../dto/update-order.dto';
import { Order } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';
import { OrderChannels } from '../enums/order-channels';


@Injectable()
export class OrderEvent {

  constructor(
    private eventEmitter: EventEmitter2,
  ) { }

  /**
   * Émet un événement de création de commande
   */
  async orderCreatedEvent(payload: OrderCreatedEvent) {
    this.eventEmitter.emit(
      OrderChannels.ORDER_CREATED,
      payload
    );
  }

  /**
   * Émet un événement de mise à jour de statut de commande
   */
  async orderStatusUpdatedEvent(order: OrderCreatedEvent) {
    this.eventEmitter.emit(
      OrderChannels.ORDER_STATUS_UPDATED,
      order
    );
  }

  /**
   * Émet un événement de mise à jour de commande
   */
  async orderUpdatedEvent(order: Order, updateOrderDto: UpdateOrderDto) {
    this.eventEmitter.emit(
      OrderChannels.ORDER_UPDATED,
      order
    );

  }

  /**
   * Émet un événement de suppression de commande
   */

  async orderDeletedEvent(order: Order) {
    this.eventEmitter.emit(
      OrderChannels.ORDER_DELETED,
      order
    );

  }
}