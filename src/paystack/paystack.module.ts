import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PaiementEnLigneService } from './paiement-en-ligne.service';
import { PaystackWebhookConsumer } from './paystack-webhook.consumer';
import { PaystackController } from './paystack.controller';
import { PaystackService } from './paystack.service';

/**
 * PAYSTACK (25/11). Ne dépend ni des commandes ni des paiements (événements
 * internes, cf. paystack.channels.ts) : les modules des commandes et des
 * paiements l'importent sans cycle.
 */
@Module({
  imports: [
    // Même file durable que KKiaPay : 10 essais, attente croissante dès 5 s.
    BullModule.registerQueue({
      name: 'paystack-webhooks',
      defaultJobOptions: {
        attempts: 10,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: { age: 1209600, count: 1000 },
      },
    }),
  ],
  controllers: [PaystackController],
  providers: [PaystackService, PaiementEnLigneService, PaystackWebhookConsumer],
  exports: [PaystackService, PaiementEnLigneService],
})
export class PaystackModule {}
