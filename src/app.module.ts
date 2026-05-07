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
import { AuthDelivererModule } from 'src/modules/auth-deliverer/auth-deliverer.module';
import { DeliverersModule } from 'src/modules/deliverers/deliverers.module';
import { CourseModule } from 'src/modules/course/course.module';
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
import { HubriseModule } from 'src/hubrise/hubrise.module';
import { SettingsModule } from 'src/modules/settings/settings.module';
import { OnesignalModule } from 'src/modules/onesignal/onesignal.module';
import { PushCampaignModule } from 'src/modules/push-campaign/push-campaign.module';
import { PromoCodeModule } from 'src/modules/promo-code/promo-code.module';
import { RetentionCallbackModule } from 'src/modules/retention-callback/retention-callback.module';
import { SchedulingModule } from 'src/modules/schedule/schedule.module';
import { MapsModule } from 'src/modules/maps/maps.module';

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
        stores: [
          new KeyvRedis(
            `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
          ),
        ],
      }),
    }),
    BullModule.forRoot({
      prefix: 'chicken-nation-queue',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        username: process.env.REDIS_USERNAME || 'default',
        password: process.env.REDIS_PASSWORD || '',
        db: parseInt(process.env.REDIS_DB || '0', 10),
      },
    }),

    // Modules applicatifs
    ExpoPushModule,
    DatabaseModule,
    CommonModule,
    UsersModule,
    AuthModule,
    AuthDelivererModule,
    DeliverersModule,
    CourseModule,
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
    HubriseModule,
    SettingsModule,
    OnesignalModule,
    PushCampaignModule,
    PromoCodeModule,
    RetentionCallbackModule,
    SchedulingModule,
    MapsModule,
  ],
})
export class AppModule { }
