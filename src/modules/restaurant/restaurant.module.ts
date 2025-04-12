import { Module } from '@nestjs/common';
import { RestaurantService } from './services/restaurant.service';
import { RestaurantController } from './controllers/restaurant.controller';

@Module({
  imports: [],
  controllers: [RestaurantController],
  providers: [RestaurantService],
})
export class RestaurantModule { }
