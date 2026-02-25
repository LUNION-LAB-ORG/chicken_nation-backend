import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import KeyvRedis from '@keyv/redis';

// Modules internes
import { CommonModule } from 'src/common/common.module';
import { UsersModule } from 'src/modules/users/users.module';
import { AuthModule } from 'src/modules/auth/auth.module';
import { DatabaseModule } from 'src/database/database.module';
import { RestaurantModule } from 'src/modules/restaurant/restaurant.module';
import { MenuModule } from 'src/modules/menu/menu.module';
import { CustomerModule } from 'src/modules/customer/customer.module';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';
import { OrderModule } from 'src/modules/order/order.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { KkiapayModule } from 'src/kkiapay/kkiapay.module';
import { FidelityModule } from 'src/modules/fidelity/fidelity.module';
import { StatisticsModule } from 'src/modules/statistics/statistics.module';
import { SocketIoModule } from 'src/socket-io/socket-io.module';
import { TwilioModule } from 'src/twilio/twilio.module';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { MessagerieModule } from 'src/modules/messagerie/messagerie.module';
import { SupportModule } from 'src/modules/support/support.module';
import { VoucherModule } from 'src/modules/voucher/voucher.module';
import { TurboModule } from 'src/turbo/turbo.module';
import { AppMobileModule } from 'src/modules/marketing/app-mobile/app-mobile.module';
import { CardNationModule } from 'src/modules/card-nation/card-nation.module';
import { S3Module } from 'src/s3/s3.module';
import { NewsModule } from 'src/modules/marketing/news/news.module';
import { ExpoPushModule } from 'src/expo-push/expo-push.module';
import { DeeplinkModule } from 'src/modules/marketing/deeplink/deeplink.module';

@Module({
  imports: [
    EventEmitterModule.forRoot({}),

    // Modules utilitaires
    JsonWebTokenModule,
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => ({
        ttl: 1000,
        stores: [new KeyvRedis('redis://localhost:6379')],
      }),
    }),
    BullModule.forRoot({
      prefix: 'chicken-nation-queue',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
      connection: {
        host: 'localhost',
        port: 6379,
        username: 'default',
        password: '',
        db: 0,
      },
    }),

    // Modules applicatifs
    ExpoPushModule,
    DatabaseModule,
    CommonModule,
    UsersModule,
    AuthModule,
    RestaurantModule,
    MenuModule,
    CustomerModule,
    PaiementsModule,
    OrderModule,
    NotificationsModule,
    KkiapayModule,
    SocketIoModule,
    TwilioModule,
    FidelityModule,
    StatisticsModule,
    MessagerieModule,
    SupportModule,
    VoucherModule,
    TurboModule,
    CardNationModule,
    S3Module,
    DeeplinkModule,
    NewsModule,
    AppMobileModule,
  ],
})
export class AppModule { }
