import { Module } from '@nestjs/common';
import { ReferralService } from './referral.service';
import { ReferralController } from './referral.controller';
import { ReferralAdminController } from './referral-admin.controller';
import { VoucherModule } from '../voucher/voucher.module';

/**
 * Parrainage. Importe VoucherModule (bon de bienvenue du filleul via
 * `createForCustomer`). SettingsService est global. Exporte ReferralService pour
 * le hook de qualification (1ère commande payée) branché côté paiement/commande.
 */
@Module({
  imports: [VoucherModule],
  controllers: [ReferralController, ReferralAdminController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
