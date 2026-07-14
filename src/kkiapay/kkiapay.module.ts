import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { KkiapayController } from 'src/kkiapay/kkiapay.controller';
import { KkiapayService } from 'src/kkiapay/kkiapay.service';
import { KkiapayEvent } from 'src/kkiapay/kkiapay.event';
import { KkiapayWebhookConsumer } from 'src/kkiapay/kkiapay-webhook.consumer';

@Module({
  imports: [
    // File durable des webhooks KKiaPay : découple l'ack de KKiaPay de la
    // disponibilité de Neon. Le job est conservé dans Redis et rejoué jusqu'à
    // succès (10 tentatives, backoff exponentiel 5s → ~85min de fenêtre).
    BullModule.registerQueue({
      name: 'kkiapay-webhooks',
      defaultJobOptions: {
        attempts: 10,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        // Dead-letter à rétention FINIE (≈14 j / 1000 jobs). removeOnFail:false
        // gardait les jobs échoués POUR TOUJOURS : comme le jobId est fixe
        // (`event:transactionId`), un job épuisé bloquait à jamais toute nouvelle
        // livraison du même transactionId (dédup permanente) → la transaction ne
        // pouvait plus JAMAIS être ré-ingérée. Avec une rétention finie, le job
        // s'efface après ~14 j et une re-livraison KKiaPay (ou un rejeu manuel)
        // peut de nouveau être prise en charge. On garde assez d'historique pour
        // l'audit sans transformer l'échec en blocage définitif.
        removeOnFail: { age: 1209600, count: 1000 }, // 1209600 s = 14 jours
      },
    }),
  ],
  controllers: [KkiapayController],
  providers: [KkiapayService, KkiapayEvent, KkiapayWebhookConsumer],
  exports: [KkiapayService],
})
export class KkiapayModule {}
