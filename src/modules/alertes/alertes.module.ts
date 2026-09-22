import { Global, Module } from '@nestjs/common';
import { AlertesService } from './alertes.service';

/**
 * Alertes opérationnelles. @Global à dessein : un incident se produit
 * n'importe où (paiement, commande, livraison, webhook), et signaler ne doit
 * jamais obliger à remonter une chaîne d'imports ni risquer un cycle de
 * modules. Même parti pris que le journal d'audit.
 */
@Global()
@Module({
  providers: [AlertesService],
  exports: [AlertesService],
})
export class AlertesModule {}
