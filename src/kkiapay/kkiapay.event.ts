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
   * Émet un événement de succès de transaction et ATTEND ses listeners.
   *
   * emitAsync attend la résolution de tous les handlers @OnEvent et propage leur
   * rejet éventuel. C'est ce qui rend le traitement du paiement synchrone à l'ack
   * du job BullMQ : une erreur transitoire relancée par le listener remonte jusqu'au
   * worker, qui retente.
   */
  async kkiapayTransactionSuccessEvent(payload: KkiapayWebhookDto) {
    await this.eventEmitter.emitAsync(
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