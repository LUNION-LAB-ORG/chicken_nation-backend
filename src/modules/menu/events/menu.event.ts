import { Injectable } from '@nestjs/common';
import { Category, Dish } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';


@Injectable()
export class MenuEvent {

  constructor(
    private eventEmitter: EventEmitter2,
  ) { }

  /**
   * Émet un événement de création de catégorie
   */
  async createCategory(payload: Category) {
    this.eventEmitter.emit(
      'category.created',
      payload
    );
  }

  /**
   * Émet un événement de mise à jour de catégorie
   */
  async updateCategory(payload: Category) {
    this.eventEmitter.emit(
      'category.updated',
      payload
    );
  }

  /**
   * Émet un événement de création de plat
   */
  async createDish(payload: Dish) {
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