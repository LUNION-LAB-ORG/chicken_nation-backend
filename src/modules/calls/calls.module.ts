import { Module } from '@nestjs/common';
import { DeliverersModule } from 'src/modules/deliverers/deliverers.module';
import { CallsController } from './calls.controller';
import { CallsLivreurController } from './calls-livreur.controller';
import { AppelsLivreurService } from './services/appels-livreur.service';
import { CallsService } from './services/calls.service';
import { CallsConfigService } from './services/calls-config.service';
import { LunionMeetService } from './services/lunion-meet.service';

/**
 * Appels audio internes (Lunion Meet).
 * Dépendances globales : PrismaService (DatabaseModule), SettingsService,
 * AppGateway (SocketIoModule @Global), ConfigService, AuditService.
 * DeliverersModule : notification `appel_entrant` au livreur appelé (24/10).
 */
@Module({
  imports: [DeliverersModule],
  // ⚠ ORDRE : `calls/deliverer` (jeton livreur) avant `calls` (jeton du
  // personnel), pour qu'aucune route `/calls/deliverer/...` ne soit prise par
  // un motif `/calls/:id...` du personnel.
  controllers: [CallsLivreurController, CallsController],
  providers: [CallsService, CallsConfigService, LunionMeetService, AppelsLivreurService],
})
export class CallsModule {}
