import { Module } from '@nestjs/common';
import { RestaurantService } from './services/restaurant.service';
import { RestaurantController } from './controllers/restaurant.controller';
import { MenuModule } from 'src/modules/menu/menu.module';

@Module({
  imports: [MenuModule],
  controllers: [RestaurantController],
  providers: [RestaurantService],
})
export class RestaurantModule { }
