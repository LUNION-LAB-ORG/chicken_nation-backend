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
import { SpecialOfferModule } from 'src/modules/special-offer/special-offer.module';
import { CustomerModule } from 'src/modules/customer/customer.module';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';
import { OrderModule } from 'src/modules/order/order.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { KkiapayModule } from 'src/kkiapay/kkiapay.module';
import { FidelityModule } from 'src/modules/fidelity/fidelity.module';
import { StatisticsModule } from 'src/modules/statistics/statistics.module';
import { SocketIoModule } from 'src/socket-io/socket-io.module';
import { TwilioModule } from 'src/twilio/twilio.module';
import { EmailModule } from 'src/modules/email/email.module';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { MessagerieModule } from './modules/messagerie/messagerie.module';
import { SupportModule } from './modules/support/support.module';
import { VoucherModule } from './modules/voucher/voucher.module';
import { TurboModule } from './turbo/turbo.module';
import { AppMobileModule } from './modules/marketing/app-mobile/app-mobile.module';
import { CardNationModule } from './modules/card-nation/card-nation.module';
import { S3Module } from './s3/s3.module';

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
    SocketIoModule,
    TwilioModule,
    EmailModule,
    FidelityModule,
    StatisticsModule,
    MessagerieModule,
    SupportModule,
    VoucherModule,
    TurboModule,
    AppMobileModule,
    CardNationModule,
    S3Module
  ],
})
export class AppModule { }
