import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from 'src/common/common.module';
import { UsersModule } from 'src/modules/users/users.module';
import { AuthModule } from 'src/modules/auth/auth.module';
import { DatabaseModule } from 'src/database/database.module';
import { RestaurantModule } from 'src/modules/restaurant/restaurant.module';
import { MenuModule } from 'src/modules/menu/menu.module';
import { SpecialOfferModule } from 'src/modules/special-offer/special-offer.module';
import { CustomerModule } from 'src/modules/customer/customer.module';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';
import { OrderModule } from 'src/modules/order/order.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { KkiapayModule } from './kkiapay/kkiapay.module';
import { NotificationRealTimeModule } from './notification-real-time/notification-real-time.module';
import { FidelityModule } from 'src/modules/fidelity/fidelity.module';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { StatisticsModule } from 'src/modules/statistics/statistics.module';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({}),
    DatabaseModule,
    CommonModule,
    UsersModule,
    AuthModule,
    RestaurantModule,
    MenuModule,
    SpecialOfferModule,
    CustomerModule,
    PaiementsModule,
    OrderModule,
    NotificationsModule,
    KkiapayModule,
    NotificationRealTimeModule,
    FidelityModule,
    StatisticsModule,
  ],
})

export class AppModule { }
