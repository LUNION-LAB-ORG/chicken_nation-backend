import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { AlertesService, CodeAlerte } from 'src/modules/alertes/alertes.service';
import {
  EvenementPaiementPaystack,
  EvenementRemboursementPaystack,
  IssuePaiementPaystack,
  PaystackChannels,
} from './paystack.channels';

export interface TravailWebhookPaystack {
  type: string;
  reference: string;
  statut?: string;
}

/**
 * Traitement durable des webhooks Paystack (25/11), comme pour KKiaPay : le
 * contrôleur enfile et répond 200, ce travailleur fait le vrai travail et
 * relance les erreurs passagères (base ou Paystack injoignable) pour que la
 * file réessaie. Le corps du webhook n'est jamais la vérité : le traitement
 * revérifie la transaction chez Paystack.
 */
@Processor('paystack-webhooks')
export class PaystackWebhookConsumer extends WorkerHost {
  private readonly logger = new Logger(PaystackWebhookConsumer.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly alertes: AlertesService,
  ) {
    super();
  }

  async process(job: Job<TravailWebhookPaystack>): Promise<void> {
    const { type, reference, statut } = job.data ?? ({} as TravailWebhookPaystack);
    if (!reference) return;
    if (type === 'charge.success') {
      const resultats = await this.eventEmitter.emitAsync(PaystackChannels.PAIEMENT_A_CONFIRMER, {
        reference,
      } satisfies EvenementPaiementPaystack);
      const issue = (resultats ?? []).find(
        (r): r is IssuePaiementPaystack => !!r && typeof r === 'object' && 'confirmed' in (r as object),
      );
      this.logger.log(`Webhook Paystack ${reference} : ${issue?.confirmed ? 'commande confirmée' : `non confirmée (${issue?.reason ?? 'sans motif'})`}.`);
      // Argent reçu chez Paystack, commande non confirmée : quelqu'un doit le savoir.
      if (issue && !issue.confirmed && !/déjà/i.test(issue.reason ?? '')) {
        this.alertes.signaler({
          code: CodeAlerte.PAIEMENT_NON_CONFIRME,
          restaurantId: issue.restaurantId ?? null,
          reference: issue.orderReference ?? null,
          details: [`Paiement Paystack ${reference}`, `Motif : ${issue.reason ?? 'non précisé'}`],
          meta: { reference, motif: issue.reason ?? null, fournisseur: 'PAYSTACK' },
        });
      }
      return;
    }
    if (type.startsWith('refund.')) {
      await this.eventEmitter.emitAsync(PaystackChannels.REMBOURSEMENT, {
        reference,
        statut: statut ?? type.slice('refund.'.length),
      } satisfies EvenementRemboursementPaystack);
    }
  }
}
