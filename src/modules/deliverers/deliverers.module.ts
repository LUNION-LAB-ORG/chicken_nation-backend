import { Module } from '@nestjs/common';

import { AuthDelivererModule } from 'src/modules/auth-deliverer/auth-deliverer.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { SettingsModule } from 'src/modules/settings/settings.module';

import { DeliverersAdminController } from './controllers/deliverers-admin.controller';
import { DeliverersSelfController } from './controllers/deliverers-self.controller';
import { DelivererEvent } from './events/deliverer.event';
import { DelivererScoringSettingsHelper } from './helpers/deliverer-scoring-settings.helper';
import { DelivererListenerService } from './listeners/deliverer.listener.service';
import { ExpoPushModule } from 'src/expo-push/expo-push.module';

import { DelivererAdminNotificationService } from './services/deliverer-admin-notification.service';
import { DelivererInfoService } from './services/deliverer-info.service';
import { DelivererPushService } from './services/deliverer-push.service';
import { DelivererQueueService } from './services/deliverer-queue.service';
import { DelivererRewardsService } from './services/deliverer-rewards.service';
import { DelivererScoringService } from './services/deliverer-scoring.service';
import { DeliverersService } from './services/deliverers.service';
import { DeliverersTask } from './tasks/deliverers.task';
import { DeliverersWebSocketService } from './websockets/deliverers-websocket.service';

@Module({
  imports: [AuthDelivererModule, SettingsModule, ExpoPushModule, NotificationsModule],
  // ⚠ ORDRE IMPORTANT : `DeliverersSelfController` (`@Controller('deliverers/me')`)
  // doit être enregistré AVANT `DeliverersAdminController` (`@Controller('deliverers')`).
  // Sans ça, Express matche `/deliverers/me/scoring-info` sur le pattern
  // `/deliverers/:id/scoring-info` du admin (où `:id = 'me'`) et applique le
  // mauvais guard (`JwtAuthGuard` USER au lieu de `JwtDelivererAuthGuard`),
  // d'où des 401 sur tous les endpoints `/me/*` non-triviaux.
  controllers: [DeliverersSelfController, DeliverersAdminController],
  providers: [
    DeliverersService,
    DelivererEvent,
    DeliverersWebSocketService,
    DelivererListenerService,
    DeliverersTask,
    DelivererScoringSettingsHelper,
    DelivererScoringService,
    DelivererQueueService,
    DelivererInfoService,
    DelivererPushService,
    DelivererRewardsService,
    DelivererAdminNotificationService,
  ],
  exports: [
    DeliverersService,
    DelivererEvent,
    DeliverersWebSocketService,
    // Exportés pour que le module course (P3 grouping + P4 scoring + P5 queue) consomme.
    DelivererScoringSettingsHelper,
    DelivererScoringService,
    DelivererQueueService,
    DelivererInfoService,
    // P-push livreur : exporté pour que les modules course / schedule envoient des push
    DelivererPushService,
    // I-admin notif : exporté pour que les listeners auth-deliverer / queue
    // émettent les emails au moment opportun (inscription, auto-pause).
    DelivererAdminNotificationService,
  ],
})
export class DeliverersModule {}
