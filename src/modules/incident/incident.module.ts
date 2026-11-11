import { Module } from '@nestjs/common';
import { VoucherModule } from 'src/modules/voucher/voucher.module';
import { IncidentAlertesService } from './incident-alertes.service';
import { IncidentReglagesService } from './incident-reglages.service';
import { IncidentRetardTask } from './incident-retard.task';
import { IncidentTraitementService } from './incident-traitement.service';
import { IncidentController } from './incident.controller';
import { IncidentService } from './incident.service';

/**
 * Incidents sur commande (11/11) : pont entre le CRM, les tickets et les
 * avis. Le bon de réduction est un bon d'achat du module Voucher ; la base,
 * les réglages, la cloche, les SMS et le temps réel viennent des modules
 * globaux.
 */
@Module({
  imports: [VoucherModule],
  controllers: [IncidentController],
  providers: [
    IncidentService,
    IncidentTraitementService,
    IncidentReglagesService,
    IncidentAlertesService,
    IncidentRetardTask,
  ],
  exports: [IncidentService],
})
export class IncidentModule {}
