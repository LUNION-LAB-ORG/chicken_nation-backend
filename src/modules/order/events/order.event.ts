import { Injectable } from '@nestjs/common';
import { UpdateOrderDto } from '../dto/update-order.dto';
import { Order, OrderStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';


@Injectable()
export class OrderEvent {

  constructor(
    private eventEmitter: EventEmitter2,
  ) { }

  /**
   * Émet un événement de création de commande
   */
  async create(payload: OrderCreatedEvent) {
    this.eventEmitter.emit(
      'order.created',
      payload
    );
  }

  /**
   * Émet un événement de mise à jour de statut de commande
   */
  async updateStatus(order: Order) {
    this.eventEmitter.emit(
      'order.statusUpdated',
      order
    );

  }
  /**
   * Émet un événement de mise à jour de commande
   */
  async update(order: Order, updateOrderDto: UpdateOrderDto) {
    this.eventEmitter.emit(
      'order.updated',
      order
    );

  }

  /**
   * Émet un événement de suppression de commande
   */

  async remove(order: Order) {
    this.eventEmitter.emit(
      'order.deleted',
      order
    );

  }
}