import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersController } from './controllers/orders.controller';
import { OrdersService } from './services/orders.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/orderItem.entity';
import { OrderItemSupplement } from './entities/orderItemSupplement.entity';
import { MenuItem } from '../menu/entities/menuItem.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      OrderItemSupplement,
      MenuItem,
    ]),
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}