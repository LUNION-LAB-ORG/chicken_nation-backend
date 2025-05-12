import { Module } from '@nestjs/common';
import { OrderService } from 'src/modules/order/services/order.service';
import { OrderController } from 'src/modules/order/controllers/order.controller';
import { OrderItemService } from 'src/modules/order/services/order-item.service';
import { OrderItemController } from 'src/modules/order/controllers/order-item.controller';
import { OrderHelper } from 'src/modules/order/helpers/order.helper';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';

@Module({
  imports: [PaiementsModule],
  controllers: [OrderController, OrderItemController],
  providers: [OrderService, OrderItemService, OrderHelper],
})
export class OrderModule { }
