import { Injectable } from '@nestjs/common';
import { Category, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class CategoryEvent {

  constructor(
    private eventEmitter: EventEmitter2,
  ) { }

  /**
   * Émet un événement de création de catégorie
   */
  async createCategory(payload: {
    actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
    category: Category
  }) {
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
}