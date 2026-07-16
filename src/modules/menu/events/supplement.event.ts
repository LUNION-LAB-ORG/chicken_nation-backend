import { Injectable } from '@nestjs/common';
import { Supplement } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class SupplementEvent {

  constructor(
    private eventEmitter: EventEmitter2,
  ) { }

  /**
   * Émet un événement de création de supplément
   */
  async createSupplement(payload: Supplement) {
    this.eventEmitter.emit(
      'supplement.created',
      payload
    );
  }

  /**
   * Émet un événement de mise à jour de supplément
   */
  async updateSupplement(payload: Supplement) {
    this.eventEmitter.emit(
      'supplement.updated',
      payload
    );
  }

  /**
   * Émet un événement de suppression de supplément
   */
  async deleteSupplement(payload: Supplement) {
    this.eventEmitter.emit(
      'supplement.deleted',
      payload
    );
  }
}
