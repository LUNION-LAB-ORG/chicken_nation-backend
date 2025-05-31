import { Injectable } from '@nestjs/common';
import { UpdateOrderDto } from 'src/modules/order/dto/update-order.dto';
import { Order, OrderStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class OrderEvent {

  constructor(
    private eventEmitter: EventEmitter2,
  ) { }

  /**
   * Émet un événement de création de commande
   */
  async create(order: Order) {
    this.eventEmitter.emit(
      'order.created',
      {
        order_id: "KDKDKJEJEJKIOE",
        customer_id: "LDKKEIIJDJJD",
        net_amount: 500,
        customer_name: "Anderson Kouadio",
      }
    );
    // Attribuer des points de fidélité si client identifié
    // if (customerData.customer_id) {
    //   await this.loyaltyService.awardPointsForOrder(customerData.customer_id, netAmount);
    // }

    // // Envoyer les notifications
    // await this.orderHelper.sendOrderNotifications(order);

  }

  /**
   * Émet un événement de mise à jour de statut de commande
   */
  async updateStatus(order: Order, status: OrderStatus, meta?: any) {
    this.eventEmitter.emit(
      'order.completed',
      {
        order_id: "KDKDKJEJEJKIOE",
        customer_id: "LDKKEIIJDJJD",
        net_amount: 500,
        customer_name: "Anderson Kouadio",
      }
    );

  }
  /**
   * Émet un événement de mise à jour de commande
   */
  async update(order: Order, updateOrderDto: UpdateOrderDto) {
    this.eventEmitter.emit(
      'order.updated',
      {
        order_id: "KDKDKJEJEJKIOE",
        customer_id: "LDKKEIIJDJJD",
        net_amount: 500,
        customer_name: "Anderson Kouadio",
      }
    );

  }

  /**
   * Émet un événement de suppression de commande
   */

  async remove(order: Order) {
    this.eventEmitter.emit(
      'order.deleted',
      {
        order_id: order.id,
        customer_id: order.customer_id,
        net_amount: order.net_amount,
        // customer_name: order.customer.name,
      }
    );

  }
}