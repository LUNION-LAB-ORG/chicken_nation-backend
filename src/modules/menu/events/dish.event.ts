import { Injectable } from '@nestjs/common';
import { Dish, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class DishEvent {

  constructor(
    private eventEmitter: EventEmitter2,
  ) { }

  /**
   * Émet un événement de création de plat
   */
  async createDish(payload: {
    actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
    dish: Dish
  }) {
    this.eventEmitter.emit(
      'dish.created',
      payload
    );
  }

  /**
   * Émet un événement de mise à jour de plat
   */
  async updateDish(payload: Dish) {
    this.eventEmitter.emit(
      'dish.updated',
      payload
    );
  }
}