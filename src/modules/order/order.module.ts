import { Module } from '@nestjs/common';
import { OrderService } from './services/order.service';
import { OrderController } from './controllers/order.controller';
import { OrderItemService } from './services/order-item.service';
import { OrderHelper } from './helpers/order.helper';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';
import { FidelityModule } from 'src/modules/fidelity/fidelity.module';
// import { OrderListenerService } from './listeners/order.listener.service';
import { OrderEvent } from './events/order.event';
// import { OrderTask } from './tasks/order.task';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { OrderWebSocketService } from './websockets/order-websocket.service';
import { RestaurantModule } from '../restaurant/restaurant.module';
import { OrderNotificationsTemplate } from './templates/order-notifications.template';
import { ReceiptsService } from './services/receipts.service';
import { TurboModule } from 'src/turbo/turbo.module';
import { TurboListenerService } from './listeners/turbo.listener.service';
import { KkiapayOrderListenerService } from './listeners/kkiapay-order.listener.service';
import { OrderV2Helper } from './helpers/orderv2.helper';

@Module({
  imports: [JsonWebTokenModule, PaiementsModule, FidelityModule, RestaurantModule, TurboModule],
  controllers: [OrderController],
  providers: [
    OrderService,
    OrderItemService,
    OrderHelper,
    OrderV2Helper,
    OrderEvent,
    // OrderListenerService,
    // OrderTask,
    OrderWebSocketService,
    OrderNotificationsTemplate,
    ReceiptsService,
    TurboListenerService,
    KkiapayOrderListenerService
  ],
})
export class OrderModule { }
