import { Module } from '@nestjs/common';
import { OrderService } from './services/order.service';
import { OrderDelivererService } from './services/order-deliverer.service';
import { OrderController } from './controllers/order.controller';
import { OrderDelivererController } from './controllers/order-deliverer.controller';
import { OrderHelper } from './helpers/order.helper';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';
import { FidelityModule } from 'src/modules/fidelity/fidelity.module';
import { OrderListenerService } from './listeners/order.listener.service';
import { OrderEvent } from './events/order.event';
import { OrderTask } from './tasks/order.task';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { AuthDelivererModule } from 'src/modules/auth-deliverer/auth-deliverer.module';
import { OrderWebSocketService } from './websockets/order-websocket.service';
import { RestaurantModule } from '../restaurant/restaurant.module';
import { ReceiptsService } from './services/receipts.service';
import { TurboModule } from 'src/turbo/turbo.module';
import { TurboListenerService } from './listeners/turbo.listener.service';
import { KkiapayOrderListenerService } from './listeners/kkiapay-order.listener.service';
import { OrderV2Helper } from './helpers/orderv2.helper';
import { DeliveryFeeHelper } from './helpers/delivery-fee.helper';
import { ExpoPushModule } from 'src/expo-push/expo-push.module';
import { VoucherModule } from 'src/modules/voucher/voucher.module';
import { PromoCodeModule } from 'src/modules/promo-code/promo-code.module';
import { ReferralModule } from 'src/modules/referral/referral.module';
import { UsersModule } from 'src/modules/users/users.module';
import { DeliveryOfferModule } from 'src/modules/delivery-offer/delivery-offer.module';

@Module({
  imports: [
    JsonWebTokenModule,
    AuthDelivererModule,
    PaiementsModule,
    FidelityModule,
    RestaurantModule,
    TurboModule,
    ExpoPushModule,
    VoucherModule,
    ReferralModule,
    PromoCodeModule,
    UsersModule,
    DeliveryOfferModule,
  ],
  controllers: [OrderController, OrderDelivererController],
  providers: [
    OrderService,
    OrderDelivererService,
    OrderHelper,
    OrderV2Helper,
    DeliveryFeeHelper,
    OrderEvent,
    OrderListenerService,
    OrderTask,
    OrderWebSocketService,
    ReceiptsService,
    TurboListenerService,
    KkiapayOrderListenerService,
  ],
})
export class OrderModule {}
