import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './modules/auth/auth.module';
import { MenuModule } from './modules/menu/menu.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { UserProfileModule } from './modules/user-profile/user-profile.module';
import { RestaurantsModule } from './modules/restaurants/restaurants.module';
import { AnalyticsModule } from './modules/analytics/analytics.module'; 
import { getDatabaseConfig } from './database/database.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => getDatabaseConfig(configService),
    }),
    AuthModule,
    MenuModule,
    OrdersModule,
    PaymentsModule,
    NotificationsModule,
    UserProfileModule,
    RestaurantsModule,
    AnalyticsModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}