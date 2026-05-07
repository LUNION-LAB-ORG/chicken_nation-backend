import { Module } from '@nestjs/common';

import { AuthDelivererModule } from 'src/modules/auth-deliverer/auth-deliverer.module';
import { DeliverersModule } from 'src/modules/deliverers/deliverers.module';
import { SettingsModule } from 'src/modules/settings/settings.module';

import { SocketIoModule } from 'src/socket-io/socket-io.module';

import { ScheduleAdminController } from './controllers/schedule-admin.controller';
import { ScheduleSelfController } from './controllers/schedule-self.controller';
import { ScheduleEvent } from './events/schedule.event';
import { ScheduleSettingsHelper } from './helpers/schedule-settings.helper';
import { ScheduleListenerService } from './listeners/schedule.listener.service';
import { SchedulePlanningService } from './services/schedule-planning.service';
import { ScheduleQueryService } from './services/schedule-query.service';
import { ScheduleSelfService } from './services/schedule-self.service';
import { ScheduleTask } from './tasks/schedule.task';
import { ScheduleWebSocketService } from './websockets/schedule-websocket.service';

/**
 * Module Schedule (P7) — créneaux & disponibilité livreurs.
 *
 * Architecture progressive (sous-phases P7.1 → P7.7) :
 *   - P7.1 ✓ Schema Prisma + ScheduleSettingsHelper (ce fichier)
 *   - P7.2   SchedulePlanningService (génération auto rotation + slots)
 *   - P7.3   Endpoints REST admin (CRUD plan/shift/repos) + livreur (mon planning)
 *   - P7.4   Crons (auto-send planning, check-in 8h, marquage absences) + WS events
 *
 * Exports : `ScheduleSettingsHelper` consommé par d'autres modules au besoin
 * (ex : `course` pourrait checker la dispo planning avant d'offrir).
 */
@Module({
  // P-push livreur : importer DeliverersModule pour DelivererPushService
  imports: [SettingsModule, AuthDelivererModule, SocketIoModule, DeliverersModule],
  controllers: [ScheduleAdminController, ScheduleSelfController],
  providers: [
    ScheduleSettingsHelper,
    SchedulePlanningService,
    ScheduleQueryService,
    ScheduleSelfService,
    ScheduleEvent,
    ScheduleListenerService,
    ScheduleWebSocketService,
    ScheduleTask,
  ],
  exports: [
    ScheduleSettingsHelper,
    SchedulePlanningService,
    ScheduleQueryService,
    ScheduleSelfService,
    ScheduleEvent,
  ],
})
// Renommé `SchedulingModule` (et non `ScheduleModule`) pour éviter la collision
// avec `ScheduleModule` de `@nestjs/schedule` (le runner de crons).
export class SchedulingModule {}
