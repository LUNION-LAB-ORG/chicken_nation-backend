import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
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
import { KkiapayModule } from 'src/kkiapay/kkiapay.module';
import { FidelityModule } from 'src/modules/fidelity/fidelity.module';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { StatisticsModule } from 'src/modules/statistics/statistics.module';
import { SocketIoModule } from 'src/socket-io/socket-io.module';
import { TwilioModule } from 'src/twilio/twilio.module';
import { EmailModule } from 'src/modules/email/email.module';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { MessagerieModule } from './modules/messagerie/messagerie.module';
import { SupportModule } from './modules/support/support.module';
import { VoucherModule } from './modules/voucher/voucher.module';
import { BullModule } from '@nestjs/bullmq';
import { TurboModule } from './turbo/turbo.module';
import { AppMobileModule } from './modules/marketing/app-mobile/app-mobile.module';
import { CodePromoModule } from './modules/code-promo/code-promo.module';
import KeyvRedis from '@keyv/redis';

@Module({
  imports: [
    JsonWebTokenModule,
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => {
        return {
          stores: [
            // new Keyv({
            //   store: new CacheableMemory({ ttl: 60000, lruSize: 5000 }),
            // }),
            new KeyvRedis('redis://localhost:6379'),
          ],
        };
      },
    }),
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({}),
    BullModule.forRoot({
      prefix: 'chicken-nation-queue',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
      connection: {
        host: 'localhost',
        port: parseInt('6379'),
        username: "default",
        password: "",
        db: parseInt('0'),
      }
    }),
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
    CodePromoModule,
  ],
})

export class AppModule { }
