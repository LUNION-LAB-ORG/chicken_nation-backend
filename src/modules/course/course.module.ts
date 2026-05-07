import { Module } from '@nestjs/common';

import { AuthDelivererModule } from 'src/modules/auth-deliverer/auth-deliverer.module';
import { DeliverersModule } from 'src/modules/deliverers/deliverers.module';

import { CourseAdminController } from './controllers/course-admin.controller';
import { CourseDelivererController } from './controllers/course-deliverer.controller';
import { CourseOperationsController } from './controllers/course-operations.controller';
import { CourseEvent } from './events/course.event';
import { CourseHelper } from './helpers/course.helper';
import { CourseSettingsHelper } from './helpers/course-settings.helper';
import { CourseListenerService } from './listeners/course.listener.service';
import { OrderBridgeListenerService } from './listeners/order-bridge.listener.service';
import { CourseActionService } from './services/course-action.service';
import { CourseGroupingService } from './services/course-grouping.service';
import { CourseOfferService } from './services/course-offer.service';
import { CourseQueryService } from './services/course-query.service';
import { DeliveryActionService } from './services/delivery-action.service';
import { CourseBatchTask } from './tasks/course-batch.task';
import { CourseTask } from './tasks/course.task';
import { CourseWebSocketService } from './websockets/course-websocket.service';

@Module({
  imports: [AuthDelivererModule, DeliverersModule],
  controllers: [CourseDelivererController, CourseAdminController, CourseOperationsController],
  providers: [
    // Helpers
    CourseHelper,
    CourseSettingsHelper,
    // Services métier
    CourseOfferService,
    CourseActionService,
    CourseQueryService,
    CourseGroupingService, // Phase P3 : regroupement intelligent
    DeliveryActionService,
    // Events + WS
    CourseEvent,
    CourseWebSocketService,
    // Listeners
    CourseListenerService,
    OrderBridgeListenerService,
    // Cron
    CourseTask,
    CourseBatchTask, // Phase P3 : flush des batches matures toutes les 10 s
  ],
  exports: [
    CourseOfferService,
    CourseActionService,
    CourseQueryService,
    CourseGroupingService,
  ],
})
export class CourseModule {}
