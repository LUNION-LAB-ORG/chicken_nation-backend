import { Module } from '@nestjs/common';
import { OrderService } from './services/order.service';
import { OrderController } from './controllers/order.controller';
import { OrderItemService } from './services/order-item.service';
import { OrderItemController } from './controllers/order-item.controller';
import { OrderHelper } from './helpers/order.helper';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';
import { FidelityModule } from 'src/modules/fidelity/fidelity.module';
import { OrderListener } from './listeners/order.listener';
import { OrderEvent } from './events/order.event';
import { OrderTask } from './tasks/order.task';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { OrderWebSocketService } from './services/order-websocket.service';

@Module({
  imports: [JsonWebTokenModule, PaiementsModule, FidelityModule],
  controllers: [OrderController, OrderItemController],
  providers: [
    OrderService,
    OrderItemService,
    OrderHelper,
    OrderEvent,
    OrderListener,
    OrderTask,
    OrderWebSocketService,
  ],
})
export class OrderModule { }
