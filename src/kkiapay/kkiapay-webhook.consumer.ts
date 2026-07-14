import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { KkiapayService } from './kkiapay.service';
import { KkiapayWebhookDto } from './kkiapay.type';

/**
 * Worker durable des webhooks KKiaPay.
 *
 * Le contrôleur se contente d'enfiler le payload brut (Redis, disponible même
 * quand Neon a un blip) puis répond 200. Ce processeur fait le VRAI travail DB de
 * façon AWAITÉE : `handleEvent` attend le traitement du paiement et RELANCE les
 * erreurs transitoires (Neon P1001…) → BullMQ retente avec backoff jusqu'à ce que
 * Neon revienne. Les erreurs permanentes (commande inconnue, paiement non SUCCESS)
 * sont avalées en amont (ack sans retry) pour ne pas boucler à l'infini.
 */
@Processor('kkiapay-webhooks')
export class KkiapayWebhookConsumer extends WorkerHost {
  private readonly logger = new Logger(KkiapayWebhookConsumer.name);

  constructor(private readonly kkiapayService: KkiapayService) {
    super();
  }

  async process(job: Job<KkiapayWebhookDto>): Promise<void> {
    const attemptsMade = job.attemptsMade ?? 0;
    const maxAttempts = job.opts?.attempts ?? 1;
    this.logger.log(
      `Traitement webhook KKiaPay ${job.data?.event}:${job.data?.transactionId} ` +
        `(tentative ${attemptsMade + 1}/${maxAttempts})`,
    );

    // Une exception ici (erreur transitoire relancée par le processeur) déclenche
    // le retry BullMQ. Un retour normal = job traité (ack).
    await this.kkiapayService.handleEvent(job.data);
  }
}
