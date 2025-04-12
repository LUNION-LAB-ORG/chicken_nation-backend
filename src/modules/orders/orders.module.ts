import { Module } from '@nestjs/common';
import { OrdersService } from 'src/modules/orders/services/orders.service';
import { OrdersController } from 'src/modules/orders/controllers/orders.controller';
import { OrderItemService } from 'src/modules/orders/services/order-item.service';
import { OrderItemController } from 'src/modules/orders/controllers/order-item.controller';

@Module({
  imports: [],
  controllers: [OrdersController, OrderItemController],
  providers: [OrdersService, OrderItemService],
})
export class OrdersModule { }
