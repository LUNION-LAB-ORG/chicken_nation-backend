/**
 * Points enregistrés sur la commande = points RÉELLEMENT consommés par la
 * remise (02/10), sur create-v2 comme sur create (personnel).
 *
 * Le calcul lui-même est testé dans points-commande.rules.spec.ts ; ici, on
 * vérifie que la création écrit ce qu'il renvoie, et lui transmet les autres
 * remises de la commande.
 */
import { OrderStatus, OrderType, PaymentMethod, User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { OrderService } from './order.service';

const CLIENT = '44444444-4444-4444-8444-444444444444';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const client = {
  customer_id: CLIENT,
  loyalty_level: undefined,
  profile_type: null,
  total_points: 400,
  fullname: 'Awa Koné',
  phone: '+2250700000000',
  email: null,
  expo_token: null,
};

const DETAILS = { orderItems: [], netAmount: 4000, totalDishes: 4000, totalDishesEtOptions: 4000 };

function monter() {
  const ecrites: Record<string, any>[] = [];
  const tx = {
    order: {
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        ecrites.push(data);
        return { id: 'commande-1', ...data };
      }),
    },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  const greffes = {
    prisma: {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      reward: { findMany: jest.fn().mockResolvedValue([]) },
      dish: { findMany: jest.fn().mockResolvedValue([]) },
    },
    orderHelperV2: {
      resolveCustomerData: jest.fn().mockResolvedValue(client),
      getDishesWithDetails: jest.fn().mockResolvedValue([]),
      calculateOrderDetails: jest.fn().mockResolvedValue(DETAILS),
      applyPromoCode: jest.fn().mockResolvedValue({ discount: 0, type: null }),
      validateRestaurantChoice: jest.fn().mockResolvedValue({ id: RESTAURANT_A }),
      calculateTax: jest.fn().mockResolvedValue(0),
      generateOrderReference: jest.fn().mockReturnValue('ORD-X'),
      getOrderStatus: jest.fn().mockReturnValue(OrderStatus.PENDING),
    },
    orderHelper: {
      resolveCustomerData: jest.fn().mockResolvedValue(client),
      getDishesWithDetails: jest.fn().mockResolvedValue([]),
      calculateOrderDetails: jest.fn().mockResolvedValue(DETAILS),
      calculatePromotionPrice: jest.fn().mockResolvedValue(null),
      getClosestRestaurant: jest.fn().mockResolvedValue({ id: RESTAURANT_A, name: 'A' }),
      assertDishesSoldInRestaurant: jest.fn().mockResolvedValue(undefined),
      checkPayment: jest.fn().mockResolvedValue(null),
      // 150 points demandés, plafond atteint : 2 000 F, soit 100 points.
      remiseFidelite: jest.fn().mockResolvedValue({ remise: 2000, points: 100 }),
      calculateTax: jest.fn().mockResolvedValue(0),
    },
    generateDataService: {
      generateOrderReference: jest.fn().mockReturnValue('CMD-X'),
      generateRecoveryCode: jest.fn().mockReturnValue('1234'),
    },
    orderEvent: { orderCreatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderCreated: jest.fn() },
    promoCodeService: { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) },
    signalerAnomalieLivraison: jest.fn().mockResolvedValue(undefined),
    sendTrackingWhatsAppIfNoApp: jest.fn().mockResolvedValue(undefined),
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  Object.assign(service, greffes);
  return { service, ecrites, ...greffes };
}

describe('OrderService : points enregistrés sur la commande', () => {
  it('create-v2 : enregistre les points de la remise accordée, pas ceux demandés', async () => {
    const outils = monter();

    await outils.service.createv2(CLIENT, {
      items: [],
      type: OrderType.PICKUP,
      restaurant_id: RESTAURANT_A,
      payment_method: PaymentMethod.ONLINE,
      points: 150,
    } as never);

    expect(outils.orderHelper.remiseFidelite).toHaveBeenCalledWith({
      customer_id: CLIENT,
      total_points: 400,
      points: 150,
      netAmount: 4000,
      autresRemises: 0,
    });
    expect(outils.ecrites[0]).toEqual(expect.objectContaining({ points: 100, discount: 2000, amount: 2000 }));
  });

  it('create-v2 : aucune remise, aucun point écrit', async () => {
    const outils = monter();
    outils.orderHelper.remiseFidelite.mockResolvedValue({ remise: 0, points: 0 });

    await outils.service.createv2(CLIENT, {
      items: [],
      type: OrderType.PICKUP,
      restaurant_id: RESTAURANT_A,
      payment_method: PaymentMethod.ONLINE,
      points: 150,
    } as never);

    expect(outils.ecrites[0].points).toBeUndefined();
  });

  it('create (personnel) : même règle, la promotion passe avant les points', async () => {
    const outils = monter();
    outils.orderHelper.calculatePromotionPrice.mockResolvedValue({
      discount_amount: 1500,
      offers_dishes: [],
      applicable: true,
    });
    const agent = { id: 'u-1', role: UserRole.CALL_CENTER, type: UserType.BACKOFFICE } as unknown as User;

    await outils.service.create({ user: agent } as unknown as Request, {
      type: OrderType.PICKUP,
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      promotion_id: 'promo-1',
      user_id: agent.id,
      points: 150,
      items: [],
    } as never);

    expect(outils.orderHelper.remiseFidelite).toHaveBeenCalledWith(
      expect.objectContaining({ points: 150, netAmount: 4000, autresRemises: 1500 }),
    );
    expect(outils.ecrites[0]).toEqual(expect.objectContaining({ points: 100 }));
  });
});
