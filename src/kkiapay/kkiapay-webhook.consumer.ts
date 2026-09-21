import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AuditService } from 'src/modules/audit/audit.service';
import { KkiapayService } from './kkiapay.service';
import { KkiapayWebhookDto } from './kkiapay.type';
import {
  journalPaiementConfirme,
  journalPaiementEchoue,
  journalPaiementNonConfirme,
  journalTraitementEnEchec,
} from './kkiapay-audit.helper';

/**
 * Worker durable des webhooks KKiaPay.
 *
 * Le contrôleur se contente d'enfiler le payload brut (Redis, disponible même
 * quand Neon a un blip) puis répond 200. Ce processeur fait le VRAI travail DB de
 * façon AWAITÉE : `handleEvent` attend le traitement du paiement et RELANCE les
 * erreurs transitoires (Neon P1001…) → BullMQ retente avec backoff jusqu'à ce que
 * Neon revienne. Les erreurs permanentes (commande inconnue, paiement non SUCCESS)
 * sont avalées en amont (ack sans retry) pour ne pas boucler à l'infini.
 *
 * C'est aussi ici que chaque paiement laisse sa trace dans Audits → Logs :
 * réussi, refusé par KKiaPay, ou encaissé mais non traité chez nous.
 */
@Processor('kkiapay-webhooks')
export class KkiapayWebhookConsumer extends WorkerHost {
  private readonly logger = new Logger(KkiapayWebhookConsumer.name);

  constructor(
    private readonly kkiapayService: KkiapayService,
    private readonly auditService: AuditService,
  ) {
    super();
  }

  async process(job: Job<KkiapayWebhookDto>): Promise<void> {
    const attemptsMade = job.attemptsMade ?? 0;
    const maxAttempts = job.opts?.attempts ?? 1;
    const payload = job.data;

    this.logger.log(
      `Traitement webhook KKiaPay ${payload?.event}:${payload?.transactionId} ` +
        `(tentative ${attemptsMade + 1}/${maxAttempts})`,
    );

    try {
      // Une exception ici (erreur transitoire relancée par le processeur) déclenche
      // le retry BullMQ. Un retour normal = job traité (ack).
      const issue = await this.kkiapayService.handleEvent(payload);

      /**
       * UNE ligne, écrite APRÈS le traitement, qui dit ce qui s'est réellement
       * passé. Surtout pas avant : le corps du webhook n'est pas la source de
       * vérité, le traitement revérifie la transaction auprès de KKiaPay et
       * contrôle que le montant couvre la commande. Il renonce alors
       * DÉLIBÉRÉMENT, sans lever d'exception — une ligne posée d'avance
       * afficherait « paiement réussi » en vert sur une commande restée en
       * attente, soit l'exact inverse de ce que cet écran doit montrer.
       *
       * Le job se terminant ici, cette ligne n'est écrite qu'une fois, quel que
       * soit le nombre de tentatives.
       */
      if (payload?.event === 'transaction.failed') {
        this.auditService.record(journalPaiementEchoue(payload));
      } else if (payload?.event === 'transaction.success') {
        this.auditService.record(
          issue?.confirmed
            ? journalPaiementConfirme(payload)
            : journalPaiementNonConfirme(payload, issue?.reason),
        );
      }
    } catch (err) {
      /**
       * Toutes tentatives épuisées : l'argent est encaissé chez KKiaPay mais la
       * commande ne sera pas confirmée sans intervention humaine. C'est la ligne
       * la plus importante du lot, et la seule qui appelle une action.
       */
      if (attemptsMade + 1 >= maxAttempts && payload) {
        this.auditService.record(
          journalTraitementEnEchec(
            payload,
            attemptsMade + 1,
            (err as Error)?.message ?? 'cause inconnue',
          ),
        );
      }
      throw err;
    }
  }
}
