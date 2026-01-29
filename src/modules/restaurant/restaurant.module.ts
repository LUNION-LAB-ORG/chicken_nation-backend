import { Module } from '@nestjs/common';
import { RestaurantService } from './services/restaurant.service';
import { RestaurantController } from './controllers/restaurant.controller';
import { MenuModule } from 'src/modules/menu/menu.module';
import { RestaurantEvent } from './events/restaurant.event';
import { RestaurantNotificationsTemplate } from './templates/restaurant-notifications.template';
// import { RestaurantListenerService } from './listeners/restaurant-listener.service';

@Module({
  imports: [MenuModule],
  controllers: [RestaurantController],
  providers: [
    RestaurantService,
    // RestaurantListenerService,
    RestaurantEvent,
    RestaurantNotificationsTemplate
  ],
  exports: [RestaurantService]
})
export class RestaurantModule { }
