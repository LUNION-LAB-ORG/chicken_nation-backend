import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restaurant } from './entities/restaurant.entity';
import { RestaurantSchedule } from './entities/restaurant-schedule.entity';
import { RestaurantTable } from './entities/restaurant-table.entity';
import { RestaurantReservationSlot } from './entities/restaurant-reservation-slot.entity';
import { RestaurantsService } from './services/restaurants.service';
import { RestaurantSchedulesService } from './services/restaurant-schedules.service';
import { RestaurantTablesService } from './services/restaurant-tables.service';
import { RestaurantReservationSlotsService } from './services/restaurant-reservation-slots.service';
import { TableReservationsService } from './services/table-reservations.service';
import { RestaurantsController } from './controllers/restaurants.controller';
import { RestaurantSchedulesController } from './controllers/restaurant-schedules.controller';
import { RestaurantTablesController } from './controllers/restaurant-tables.controller';
import { RestaurantReservationSlotsController } from './controllers/restaurant-reservation-slots.controller';
import { TableReservationsController } from './controllers/table-reservations.controller';
import { TableReservation } from './entities/table-reservation.entity';
import { MenuItem } from '../menu/entities/menuItem.entity';
import { MenuModule } from '../menu/menu.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Restaurant,
      RestaurantSchedule,
      RestaurantTable,
      RestaurantReservationSlot,
      TableReservation,
      MenuItem
    ]),
    MenuModule,
    AuthModule
  ],
  controllers: [
    RestaurantsController,
    RestaurantSchedulesController,
    RestaurantTablesController,
    RestaurantReservationSlotsController,
    TableReservationsController
  ],
  providers: [
    RestaurantsService,
    RestaurantSchedulesService,
    RestaurantTablesService,
    RestaurantReservationSlotsService,
    TableReservationsService
  ],
  exports: [
    RestaurantsService,
    RestaurantSchedulesService,
    RestaurantTablesService,
    RestaurantReservationSlotsService,
    TableReservationsService
  ]
})
export class RestaurantsModule {}
