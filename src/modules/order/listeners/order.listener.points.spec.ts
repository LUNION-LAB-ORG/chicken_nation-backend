/**
 * Annulation d'une commande : les points UTILISÉS sont rendus (02/10), en
 * plus de la révocation des points gagnés.
 */
import { EntityStatus, OrderStatus, PaymentMethod } from '@prisma/client';
import { OrderListenerService } from './order.listener.service';
import { OrderCreatedEvent } from '../interfaces/order-event.interface';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';

const commande = (surcharge: Record<string, unknown> = {}) =>
  ({
    id: COMMANDE,
    reference: 'ORD-1',
    customer_id: CLIENT,
    restaurant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    amount: 5050,
    points: 150,
    auto: true,
    status: OrderStatus.CANCELLED,
    paied: true,
    payment_method: PaymentMethod.ONLINE,
    entity_status: EntityStatus.ACTIVE,
    promotion_id: null,
    ...surcharge,
  }) as unknown as OrderCreatedEvent['order'];

function monter() {
  const loyaltyService = {
    redeemPoints: jest.fn().mockResolvedValue(undefined),
    revokeEarnedPointsForOrder: jest.fn().mockResolvedValue(undefined),
    rendrePointsUtilises: jest.fn().mockResolvedValue({ points_rendus: 150 }),
  };
  const ecouteur = new OrderListenerService(
    { usePromotion: jest.fn() } as never,
    loyaltyService as never,
    {
      revokeForOrder: jest.fn().mockResolvedValue(undefined),
      restoreConsumedGiftsForOrder: jest.fn().mockResolvedValue(undefined),
    } as never,
    { restoreStockForCancelledOrder: jest.fn().mockResolvedValue(undefined) } as never,
    { sendPushNotifications: jest.fn() } as never,
    { notifyRestaurant: jest.fn().mockResolvedValue(undefined) } as never,
    { sendOrderBell: jest.fn().mockResolvedValue(undefined) } as never,
    { revokeEarningsForCancelledOrder: jest.fn().mockResolvedValue(undefined) } as never,
  );
  (ecouteur as unknown as { logger: unknown }).logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  return { ecouteur, loyaltyService, logger: (ecouteur as unknown as { logger: { error: jest.Mock } }).logger };
}

describe('OrderListenerService : points utilisés à l’annulation', () => {
  it('commande annulée : rend les points utilisés et révoque les points gagnés', async () => {
    const { ecouteur, loyaltyService } = monter();

    await ecouteur.orderStatusUpdatedEventListener({ order: commande() });

    expect(loyaltyService.rendrePointsUtilises).toHaveBeenCalledWith(COMMANDE);
    expect(loyaltyService.revokeEarnedPointsForOrder).toHaveBeenCalledTimes(1);
    expect(loyaltyService.redeemPoints).not.toHaveBeenCalled();
  });

  it('un échec de la restitution est tracé sans casser l’annulation', async () => {
    const { ecouteur, loyaltyService, logger } = monter();
    loyaltyService.rendrePointsUtilises.mockRejectedValueOnce(new Error('base injoignable'));

    await ecouteur.orderStatusUpdatedEventListener({ order: commande() });
    await new Promise((r) => setImmediate(r));

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Échec restitution des points utilisés (annulation) pour la commande ORD-1'),
      expect.anything(),
    );
  });

  it('autres statuts : rien à rendre', async () => {
    const { ecouteur, loyaltyService } = monter();

    await ecouteur.orderStatusUpdatedEventListener({ order: commande({ status: OrderStatus.ACCEPTED }) });
    await ecouteur.orderStatusUpdatedEventListener({ order: commande({ status: OrderStatus.COMPLETED }) });

    expect(loyaltyService.rendrePointsUtilises).not.toHaveBeenCalled();
  });
});
