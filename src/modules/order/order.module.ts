import { MenuModule } from 'src/modules/menu/menu.module';
import { KkiapayModule } from 'src/kkiapay/kkiapay.module';
import { Module } from '@nestjs/common';
import { OrderService } from './services/order.service';
import { OrderDelivererService } from './services/order-deliverer.service';
import { OrderController } from './controllers/order.controller';
import { OrderCouponController } from './controllers/order-coupon.controller';
import { OrderCouponService } from './services/order-coupon.service';
import { OrderDelivererController } from './controllers/order-deliverer.controller';
import { OrderHelper } from './helpers/order.helper';
import { PaiementsModule } from 'src/modules/paiements/paiements.module';
import { FidelityModule } from 'src/modules/fidelity/fidelity.module';
import { OrderListenerService } from './listeners/order.listener.service';
import { CouponRestitutionListener } from './listeners/coupon-restitution.listener';
import { PointsRestitutionListener } from './listeners/points-restitution.listener';
import { OrderEvent } from './events/order.event';
import { OrderTask } from './tasks/order.task';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { AuthDelivererModule } from 'src/modules/auth-deliverer/auth-deliverer.module';
import { OrderWebSocketService } from './websockets/order-websocket.service';
import { RestaurantModule } from '../restaurant/restaurant.module';
import { ReceiptsService } from './services/receipts.service';
import { TurboModule } from 'src/turbo/turbo.module';
import { KkiapayOrderListenerService } from './listeners/kkiapay-order.listener.service';
import { OrderV2Helper } from './helpers/orderv2.helper';
import { DeliveryFeeHelper } from './helpers/delivery-fee.helper';
import { ExpoPushModule } from 'src/expo-push/expo-push.module';
import { VoucherModule } from 'src/modules/voucher/voucher.module';
import { PromoCodeModule } from 'src/modules/promo-code/promo-code.module';
import { ReferralModule } from 'src/modules/referral/referral.module';
import { UsersModule } from 'src/modules/users/users.module';
import { DeliveryOfferModule } from 'src/modules/delivery-offer/delivery-offer.module';
import { MapsModule } from 'src/modules/maps/maps.module';
import { OrderRelanceController } from './controllers/order-relance.controller';
import { OrderRelanceService } from './services/order-relance.service';
import { OrderRelanceTask } from './tasks/order-relance.task';
import { OrderImpayeTask } from './tasks/order-impaye.task';

@Module({
  imports: [
    JsonWebTokenModule,
    // MENUS COMPOSABLES : DishOptionService résout le prix des choix côté serveur.
    MenuModule,
    KkiapayModule,
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
    // L'aperçu du trajet avant paiement a besoin de Directions.
    MapsModule,
  ],
  // OrderCouponController et OrderRelanceController AVANT OrderController :
  // `orders/coupon/...` et `orders/relances/...` ne doivent jamais être lus
  // comme un identifiant de commande.
  controllers: [OrderCouponController, OrderRelanceController, OrderController, OrderDelivererController],
  providers: [
    OrderService,
    OrderCouponService,
    OrderDelivererService,
    OrderHelper,
    OrderV2Helper,
    DeliveryFeeHelper,
    OrderEvent,
    OrderListenerService,
    // Coupon rendu quand une course annulée ou une livraison échouée annule la commande.
    CouponRestitutionListener,
    // Points utilisés rendus sur ces mêmes annulations, plus un filet.
    PointsRestitutionListener,
    OrderTask,
    OrderWebSocketService,
    ReceiptsService,
    KkiapayOrderListenerService,
    // Relance des paniers de l'application non payés (SettingsService est global).
    OrderRelanceService,
    OrderRelanceTask,
    OrderImpayeTask,
  ],
})
export class OrderModule {}
