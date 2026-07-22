import { Module } from '@nestjs/common';
import { ReferralService } from './referral.service';
import { ReferralController } from './referral.controller';
import { ReferralAdminController } from './referral-admin.controller';
import { VoucherModule } from '../voucher/voucher.module';
import { ExpoPushModule } from 'src/expo-push/expo-push.module';

/**
 * Parrainage v2. Le filleul reçoit un CADEAU À GRATTER à l'inscription ; le
 * parrain est récompensé quand le filleul UTILISE ce cadeau sur une commande
 * (hook `accrueForPaidOrder` branché côté paiement). Cadeaux configurables au
 * back office (fixe ou aléatoire). ExpoPushModule : notifications push client.
 */
@Module({
  imports: [VoucherModule, ExpoPushModule],
  controllers: [ReferralController, ReferralAdminController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
