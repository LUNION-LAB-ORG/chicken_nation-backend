import { Module } from '@nestjs/common';
import { OrdersService } from 'src/orders/services/orders.service';
import { OrdersController } from 'src/orders/controllers/orders.controller';
import { OrderItemService } from 'src/orders/services/order-item.service';
import { OrderItemController } from 'src/orders/controllers/order-item.controller';

@Module({
  imports: [],
  controllers: [OrdersController, OrderItemController],
  providers: [OrdersService, OrderItemService],
})
export class OrdersModule { }
