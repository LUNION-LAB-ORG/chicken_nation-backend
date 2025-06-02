import { Module } from '@nestjs/common';
import { PaiementsService } from './services/paiements.service';
import { PaiementsController } from './controllers/paiements.controller';
import { KkiapayModule } from 'src/kkiapay/kkiapay.module';
import { PaymentListener } from './listeners/paiement.listener';
import { PaiementEvent } from './events/paiement.event';

@Module({
  imports: [KkiapayModule],
  controllers: [PaiementsController],
  providers: [PaiementsService, PaymentListener, PaiementEvent],
  exports: [PaiementsService, PaiementEvent]
})
export class PaiementsModule { }
