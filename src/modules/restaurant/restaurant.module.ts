import { Module } from '@nestjs/common';
import { RestaurantService } from './services/restaurant.service';
import { RestaurantController } from './controllers/restaurant.controller';
import { MenuModule } from 'src/modules/menu/menu.module';
import { RestaurantEvent } from './events/restaurant.event';

@Module({
  imports: [MenuModule],
  controllers: [RestaurantController],
  providers: [RestaurantService, RestaurantEvent],
  exports: [RestaurantService]
})
export class RestaurantModule { }
