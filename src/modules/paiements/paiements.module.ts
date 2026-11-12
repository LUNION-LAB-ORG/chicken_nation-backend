import { Module } from '@nestjs/common';
import { PaiementsService } from './services/paiements.service';
import { RemboursementService } from './services/remboursement.service';
import { PaiementsController } from './controllers/paiements.controller';
import { KkiapayModule } from 'src/kkiapay/kkiapay.module';
// import { PaymentListener } from './listeners/paiement.listener';
import { PaiementEvent } from './events/paiement.event';
import { PromoCodeModule } from 'src/modules/promo-code/promo-code.module';

@Module({
  imports: [KkiapayModule, PromoCodeModule],
  controllers: [PaiementsController],
  providers: [
    PaiementsService, // PaymentListener, 
  PaiementEvent,
    // Remboursement KKiaPay depuis l'onglet Paiement d'une commande (12/11).
    RemboursementService],
  exports: [PaiementsService, PaiementEvent]
})
export class PaiementsModule { }
