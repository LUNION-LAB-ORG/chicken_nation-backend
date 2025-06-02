import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Order } from '@prisma/client';

@Injectable()
export class OrderListener {
  constructor() { }

  @OnEvent('order.created')
  async handleOrderCreated(payload: Order) {
    // console.log("handleOrderCreated", payload);
  }

  @OnEvent('order.statusUpdated')
  async handleOrderCompleted(payload: Order) {
    // console.log("handleOrderCompleted", payload);
  }
}