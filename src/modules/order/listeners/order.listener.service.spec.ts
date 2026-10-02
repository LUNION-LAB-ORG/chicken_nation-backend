/**
 * Écouteur des commandes : un panier non payé de l'application (brouillon)
 * ne parvient pas au restaurant, ni par notification ni par cloche, tant
 * qu'il n'est pas payé ou repris par le personnel.
 *
 * On instancie l'écouteur avec des dépendances simulées : seules celles que
 * lisent les chemins testés répondent.
 */

import { EntityStatus, OrderStatus, PaymentMethod } from '@prisma/client';
import { OrderListenerService } from './order.listener.service';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const RESTAURANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Panier de l'application, payable en ligne, en attente et non payé. */
const panier = (surcharge: Record<string, unknown> = {}) =>
  ({
    id: COMMANDE,
    reference: 'ORD-1',
    customer_id: CLIENT,
    restaurant_id: RESTAURANT,
    restaurant: { name: 'Riviera' },
    fullname: 'Awa Koné',
    amount: 5050,
    points: 0,
    auto: true,
    status: OrderStatus.PENDING,
    paied: false,
    payment_method: PaymentMethod.ONLINE,
    entity_status: EntityStatus.ACTIVE,
    promotion_id: null,
    ...surcharge,
  }) as unknown as OrderCreatedEvent['order'];

function monter() {
  const dependances = {
    promotionService: { usePromotion: jest.fn() },
    loyaltyService: {
      redeemPoints: jest.fn().mockResolvedValue(undefined),
      revokeEarnedPointsForOrder: jest.fn().mockResolvedValue(undefined),
      rendrePointsUtilises: jest.fn().mockResolvedValue({ points_rendus: 0 }),
    },
    rewardService: {
      revokeForOrder: jest.fn().mockResolvedValue(undefined),
      restoreConsumedGiftsForOrder: jest.fn().mockResolvedValue(undefined),
    },
    scratchEngineService: { restoreStockForCancelledOrder: jest.fn().mockResolvedValue(undefined) },
    expoPushService: { sendPushNotifications: jest.fn() },
    userPushService: { notifyRestaurant: jest.fn().mockResolvedValue(undefined) },
    notificationsSender: { sendOrderBell: jest.fn().mockResolvedValue(undefined) },
    referralService: { revokeEarningsForCancelledOrder: jest.fn().mockResolvedValue(undefined) },
  };
  const ecouteur = new OrderListenerService(
    dependances.promotionService as never,
    dependances.loyaltyService as never,
    dependances.rewardService as never,
    dependances.scratchEngineService as never,
    dependances.expoPushService as never,
    dependances.userPushService as never,
    dependances.notificationsSender as never,
    dependances.referralService as never,
  );
  return { ecouteur, ...dependances };
}

describe('OrderListenerService : création', () => {
  it("ne prévient pas le restaurant de la création d'un brouillon", async () => {
    const { ecouteur, userPushService, notificationsSender } = monter();

    await ecouteur.orderCreatedEventListener({ order: panier(), brouillon: true });

    expect(userPushService.notifyRestaurant).not.toHaveBeenCalled();
    expect(notificationsSender.sendOrderBell).not.toHaveBeenCalled();
  });

  it('prévient le restaurant au paiement, même si KKiaPay réémet la commande encore en attente', async () => {
    const { ecouteur, userPushService } = monter();

    // KKiaPay réémet la création avec la commande d'avant sa mise à jour :
    // elle ressemble à un brouillon, mais ne porte pas le drapeau.
    await ecouteur.orderCreatedEventListener({ order: panier(), payment_id: 'p1' });

    expect(userPushService.notifyRestaurant).toHaveBeenCalledTimes(1);
    expect(userPushService.notifyRestaurant.mock.calls[0][0]).toEqual(
      expect.objectContaining({ restaurantId: RESTAURANT, type: 'new_order', critical: true }),
    );
  });

  it('prévient le restaurant de toute autre commande dès sa création', async () => {
    const { ecouteur, userPushService, notificationsSender } = monter();

    await ecouteur.orderCreatedEventListener({
      order: panier({ auto: false, status: OrderStatus.ACCEPTED, payment_method: PaymentMethod.OFFLINE }),
    });

    expect(userPushService.notifyRestaurant).toHaveBeenCalledTimes(1);
    expect(notificationsSender.sendOrderBell).toHaveBeenCalledTimes(1);
  });
});

describe('OrderListenerService : changement de statut', () => {
  it("ne sonne pas au restaurant l'annulation d'un brouillon, mais rend ce qui doit l'être", async () => {
    const { ecouteur, notificationsSender, loyaltyService, rewardService } = monter();

    await ecouteur.orderStatusUpdatedEventListener({
      order: panier({ status: OrderStatus.CANCELLED }),
      etait_brouillon: true,
    });

    expect(notificationsSender.sendOrderBell).not.toHaveBeenCalled();
    // Révocations sans objet ici, mais inoffensives (idempotentes).
    expect(loyaltyService.revokeEarnedPointsForOrder).toHaveBeenCalledTimes(1);
    expect(rewardService.restoreConsumedGiftsForOrder).toHaveBeenCalledTimes(1);
  });

  it('panier annulé par le client, supprimé (01/10) : UNE seule notification au client, « Commande annulée »', async () => {
    const { ecouteur, expoPushService, notificationsSender, userPushService } = monter();

    await ecouteur.orderStatusUpdatedEventListener({
      order: panier({ status: OrderStatus.CANCELLED, entity_status: EntityStatus.DELETED, cancelled_by: 'client' }),
      etait_brouillon: true,
      expo_token: 'ExponentPushToken[client]',
      voucher: null,
    });

    expect(expoPushService.sendPushNotifications).toHaveBeenCalledTimes(1);
    expect(expoPushService.sendPushNotifications.mock.calls[0][0]).toEqual(
      expect.objectContaining({ title: '😔 Commande annulée', categoryId: 'order-cancelled' }),
    );
    // Les restaurants ne reçoivent rien : ni cloche, ni notification.
    expect(notificationsSender.sendOrderBell).not.toHaveBeenCalled();
    expect(userPushService.notifyRestaurant).not.toHaveBeenCalled();
  });

  it("sonne l'annulation d'une commande que le restaurant connaît", async () => {
    const { ecouteur, notificationsSender } = monter();

    await ecouteur.orderStatusUpdatedEventListener({
      order: panier({ status: OrderStatus.CANCELLED, paied: true }),
      etait_brouillon: false,
    });

    expect(notificationsSender.sendOrderBell).toHaveBeenCalledTimes(1);
  });

  it("confirme un ancien brouillon : déduit les points, sonne une fois et l'annonce comme nouvelle commande", async () => {
    const { ecouteur, notificationsSender, loyaltyService, userPushService } = monter();

    await ecouteur.orderStatusUpdatedEventListener({
      order: panier({ status: OrderStatus.ACCEPTED, auto: false, points: 500 }),
      etait_brouillon: true,
    });

    expect(loyaltyService.redeemPoints).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: CLIENT, points: 500, order_id: COMMANDE }),
    );
    expect(notificationsSender.sendOrderBell).toHaveBeenCalledTimes(1);
    expect(userPushService.notifyRestaurant).toHaveBeenCalledTimes(1);
    expect(userPushService.notifyRestaurant.mock.calls[0][0]).toEqual(
      expect.objectContaining({ restaurantId: RESTAURANT, type: 'new_order' }),
    );
  });

  it("n'annonce pas comme nouvelle une commande acceptée que le restaurant voyait déjà", async () => {
    const { ecouteur, notificationsSender, userPushService } = monter();

    await ecouteur.orderStatusUpdatedEventListener({
      order: panier({ status: OrderStatus.ACCEPTED, payment_method: PaymentMethod.OFFLINE }),
    });

    expect(notificationsSender.sendOrderBell).toHaveBeenCalledTimes(1);
    expect(userPushService.notifyRestaurant).not.toHaveBeenCalled();
  });
});
