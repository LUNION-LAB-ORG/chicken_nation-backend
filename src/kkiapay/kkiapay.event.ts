import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KkiapayWebhookDto } from './kkiapay.type';
import { KkiapayChannels } from './kkiapay-channels';


@Injectable()
export class KkiapayEvent {

  constructor(
    private eventEmitter: EventEmitter2,
  ) { }

  /**
   * Émet un événement de succès de transaction
   */
  async kkiapayTransactionSuccessEvent(payload: KkiapayWebhookDto) {
    this.eventEmitter.emit(
      KkiapayChannels.TRANSACTION_SUCCESS,
      payload
    );
  }

  /**
   * Émet un événement d'echec de transaction
   */
  async kkiapayTransactionFailedEvent(payload: KkiapayWebhookDto) {
    this.eventEmitter.emit(
      KkiapayChannels.TRANSACTION_FAILED,
      payload
    );
  }
}