import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KkiapayWebhookDto } from './kkiapay.type';
import { KkiapayChannels } from './kkiapay-channels';

/**
 * Issue du traitement d'un paiement, telle que la rend le listener de commande.
 * `confirmed: false` = paiement encaissé mais commande NON confirmée, avec le
 * motif : c'est un abandon DÉLIBÉRÉ (pas une exception), donc invisible du
 * worker si on ne la remonte pas.
 */
export interface IssueTraitementPaiement {
  confirmed: boolean;
  reason?: string;
}


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
  async kkiapayTransactionSuccessEvent(
    payload: KkiapayWebhookDto,
  ): Promise<IssueTraitementPaiement | null> {
    const resultats = await this.eventEmitter.emitAsync(
      KkiapayChannels.TRANSACTION_SUCCESS,
      payload
    );
    // RENDRE l'issue, au lieu de la jeter. Le listener abandonne volontairement
    // (return, pas throw) quand la commande est introuvable, quand KKiaPay
    // dément la transaction, ou quand le montant ne couvre pas la commande. Sans
    // cette remontée, le worker voit un job réussi et le journal afficherait
    // « paiement réussi » sur une commande restée en attente : exactement le
    // contraire de ce qu'il doit montrer.
    const issue = (resultats ?? []).find(
      (r): r is IssueTraitementPaiement =>
        !!r && typeof r === 'object' && typeof (r as { confirmed?: unknown }).confirmed === 'boolean',
    );
    return issue ?? null;
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