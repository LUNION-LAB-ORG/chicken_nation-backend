import { Module } from '@nestjs/common';
import { OrderService } from './services/order.service';
import { OrderController } from './controllers/order.controller';
import { OrderItemService } from './services/order-item.service';
import { OrderItemController } from './controllers/order-item.controller';
import { OrderHelper } from './helpers/order.helper';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';
import { FidelityModule } from 'src/modules/fidelity/fidelity.module';
import { OrderListenerService } from './listeners/order.listener.service';
import { OrderEvent } from './events/order.event';
import { OrderTask } from './tasks/order.task';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { OrderWebSocketService } from './websockets/order-websocket.service';
import { RestaurantModule } from '../restaurant/restaurant.module';
import { OrderEmailTemplates } from './templates/order-email.template';
import { OrderNotificationsTemplate } from './templates/order-notifications.template';

@Module({
  imports: [JsonWebTokenModule, PaiementsModule, FidelityModule, RestaurantModule],
  controllers: [OrderController, OrderItemController],
  providers: [
    OrderService,
    OrderItemService,
    OrderHelper,
    OrderEvent,
    OrderListenerService,
    OrderTask,
    OrderWebSocketService,
    OrderEmailTemplates,
    OrderNotificationsTemplate,
  ],
})
export class OrderModule { }
