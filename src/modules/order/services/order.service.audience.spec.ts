/**
 * Plats réservés à une audience (`Dish.audiences`) à la création (02/10).
 *
 *  - create-v2 (appli et site) et POST /orders (ancienne route client) :
 *    refus en 400, avant tout calcul, toute écriture et tout paiement ;
 *  - lignes-cadeau validées exemptées ;
 *  - personnel (create avec user_id) : la commande passe, le cas est tracé ;
 *  - plats offerts par une promotion : non contrôlés.
 *
 * La règle elle-même est testée dans dish-audience.util.spec.ts. Méthodes
 * testées en isolation, comme order.service.canal.spec.ts : seules les
 * dépendances qu'elles lisent sont greffées.
 */
import { BadRequestException } from '@nestjs/common';
import {
  DishAudience,
  LoyaltyLevel,
  OrderChannel,
  OrderStatus,
  OrderType,
  PaymentMethod,
  ProfileType,
  RewardStatus,
  User,
  UserRole,
  UserType,
} from '@prisma/client';
import type { Request } from 'express';
import { OrderService } from './order.service';

const CLIENT = '44444444-4444-4444-8444-444444444444';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const PLAT_PUBLIC = { id: 'plat-public', name: 'Poulet braisé', audiences: [] as DishAudience[] };
const PLAT_VIP = { id: 'plat-vip', name: 'Menu Prestige', audiences: [DishAudience.VIP] };

const clientStandard = {
  customer_id: CLIENT,
  loyalty_level: LoyaltyLevel.STANDARD as LoyaltyLevel,
  profile_type: null as ProfileType | null,
  total_points: 0,
  fullname: 'Awa Koné',
  phone: '+2250700000000',
  email: null,
  expo_token: null,
};

const MESSAGE_VIP =
  'Le plat « Menu Prestige » est réservé aux clients VIP. Retirez-le du panier pour continuer.';

function monterV2({ client = clientStandard, rewards = [] as Record<string, unknown>[] } = {}) {
  const tx = {
    order: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'commande-1', ...data })) },
    reward: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const greffes = {
    prisma: {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      reward: { findMany: jest.fn().mockResolvedValue(rewards) },
    },
    orderHelperV2: {
      resolveCustomerData: jest.fn().mockResolvedValue(client),
      getDishesWithDetails: jest.fn().mockResolvedValue([PLAT_PUBLIC, PLAT_VIP]),
      calculateOrderDetails: jest.fn().mockResolvedValue({
        orderItems: [],
        netAmount: 5000,
        totalDishes: 5000,
        totalDishesEtOptions: 5000,
      }),
      applyPromoCode: jest.fn().mockResolvedValue({ discount: 0, type: null }),
      validateRestaurantChoice: jest.fn().mockResolvedValue({ id: RESTAURANT_A }),
      calculateTax: jest.fn().mockResolvedValue(0),
      generateOrderReference: jest.fn().mockReturnValue('ORD-X'),
      getOrderStatus: jest.fn().mockReturnValue(OrderStatus.PENDING),
    },
    orderHelper: { remiseFidelite: jest.fn().mockResolvedValue({ remise: 0, points: 0 }) },
    generateDataService: { generateRecoveryCode: jest.fn().mockReturnValue('1234') },
    orderEvent: { orderCreatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderCreated: jest.fn() },
    signalerAnomalieLivraison: jest.fn().mockResolvedValue(undefined),
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, greffes);
  return { service, tx, ...greffes };
}

const panier = (items: Record<string, unknown>[]) =>
  ({
    items,
    type: OrderType.PICKUP,
    restaurant_id: RESTAURANT_A,
    payment_method: PaymentMethod.ONLINE,
  }) as never;

const ligne = (dish_id: string, surcharge: Record<string, unknown> = {}) => ({
  dish_id,
  quantity: 1,
  epice: false,
  supplements: [],
  ...surcharge,
});

describe('OrderService.createv2 : plats réservés', () => {
  it('client STANDARD avec un plat [VIP] : 400 qui nomme le plat, rien calculé ni écrit', async () => {
    const outils = monterV2();

    const essai = outils.service.createv2(CLIENT, panier([ligne(PLAT_PUBLIC.id), ligne(PLAT_VIP.id)]));

    await expect(essai).rejects.toBeInstanceOf(BadRequestException);
    await expect(essai).rejects.toThrow(MESSAGE_VIP);
    expect(outils.orderHelperV2.calculateOrderDetails).not.toHaveBeenCalled();
    expect(outils.orderHelper.remiseFidelite).not.toHaveBeenCalled();
    expect(outils.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('même refus depuis le site (canal WEB)', async () => {
    const outils = monterV2();

    await expect(
      outils.service.createv2(CLIENT, panier([ligne(PLAT_VIP.id)]), OrderChannel.WEB),
    ).rejects.toThrow(MESSAGE_VIP);
    expect(outils.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('client VIP : commande créée', async () => {
    const outils = monterV2({ client: { ...clientStandard, loyalty_level: LoyaltyLevel.VIP } });

    await outils.service.createv2(CLIENT, panier([ligne(PLAT_VIP.id)]));

    expect(outils.tx.order.create).toHaveBeenCalledTimes(1);
  });

  const cadeauVip = {
    id: 'cadeau-1',
    status: RewardStatus.SCRATCHED,
    expires_at: null,
    payload: { item_type: 'DISH', dish_id: PLAT_VIP.id },
  };

  it('cadeau [VIP] validé et ligne publique payante : accepté', async () => {
    const outils = monterV2({ rewards: [cadeauVip] });

    await outils.service.createv2(
      CLIENT,
      panier([ligne(PLAT_PUBLIC.id), ligne(PLAT_VIP.id, { reward_id: 'cadeau-1' })]),
    );

    expect(outils.tx.order.create).toHaveBeenCalledTimes(1);
    expect(outils.tx.reward.updateMany).toHaveBeenCalledTimes(1);
  });

  it('cadeau [VIP] plus une ligne payante du même plat : refusé', async () => {
    const outils = monterV2({ rewards: [cadeauVip] });

    await expect(
      outils.service.createv2(
        CLIENT,
        panier([ligne(PLAT_VIP.id), ligne(PLAT_VIP.id, { reward_id: 'cadeau-1' })]),
      ),
    ).rejects.toThrow(MESSAGE_VIP);
    expect(outils.prisma.$transaction).not.toHaveBeenCalled();
  });
});

const compte = (role: UserRole, type: UserType) =>
  ({ id: `u-${role}`, role, type, restaurant_id: type === UserType.RESTAURANT ? RESTAURANT_A : null }) as unknown as User;

function monterV1({ offres = [] as { dish_id: string; quantity: number; price: number }[] } = {}) {
  const tx = {
    order: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'commande-1', ...data })) },
  };
  const greffes = {
    prisma: {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      dish: { findMany: jest.fn().mockResolvedValue([{ name: 'Menu Prestige', composable: false }]) },
    },
    orderHelper: {
      resolveCustomerData: jest.fn().mockResolvedValue(clientStandard),
      getDishesWithDetails: jest.fn().mockResolvedValue([PLAT_PUBLIC, PLAT_VIP]),
      calculateOrderDetails: jest.fn().mockResolvedValue({
        orderItems: [],
        netAmount: 5000,
        totalDishes: 5000,
        totalDishesEtOptions: 5000,
      }),
      calculatePromotionPrice: jest.fn().mockResolvedValue(
        offres.length ? { discount_amount: 0, offers_dishes: offres, applicable: true } : null,
      ),
      getClosestRestaurant: jest.fn().mockResolvedValue({ id: RESTAURANT_A, name: 'A' }),
      assertDishesSoldInRestaurant: jest.fn().mockResolvedValue(undefined),
      checkPayment: jest.fn().mockResolvedValue(null),
      remiseFidelite: jest.fn().mockResolvedValue({ remise: 0, points: 0 }),
      calculateTax: jest.fn().mockResolvedValue(0),
    },
    orderHelperV2: { validateRestaurantChoice: jest.fn().mockResolvedValue({}) },
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
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, greffes);
  return { service, tx, ...greffes };
}

const commandeV1 = (items: Record<string, unknown>[], user_id?: string) =>
  ({
    type: OrderType.PICKUP,
    customer_id: CLIENT,
    restaurant_id: RESTAURANT_A,
    user_id,
    items,
  }) as never;

describe('OrderService.create : plats réservés', () => {
  it('ancienne route client (sans user_id) : refusé en 400, rien écrit', async () => {
    const outils = monterV1();

    const essai = outils.service.create(
      { user: { id: CLIENT } } as unknown as Request,
      commandeV1([ligne(PLAT_VIP.id)]),
    );

    await expect(essai).rejects.toBeInstanceOf(BadRequestException);
    await expect(essai).rejects.toThrow(MESSAGE_VIP);
    expect(outils.orderHelper.calculateOrderDetails).not.toHaveBeenCalled();
    expect(outils.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('personnel (user_id) : commande créée, cas tracé', async () => {
    const outils = monterV1();
    const caissier = compte(UserRole.CAISSIER, UserType.RESTAURANT);

    await outils.service.create({ user: caissier } as unknown as Request, commandeV1([ligne(PLAT_VIP.id)], caissier.id));

    expect(outils.tx.order.create).toHaveBeenCalledTimes(1);
    expect(outils.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('« Menu Prestige » (réservé aux clients VIP)'),
    );
  });

  it('plats offerts par une promotion : non contrôlés', async () => {
    const outils = monterV1({ offres: [{ dish_id: PLAT_VIP.id, quantity: 1, price: 0 }] });

    await outils.service.create(
      { user: { id: CLIENT } } as unknown as Request,
      commandeV1([ligne(PLAT_PUBLIC.id)]),
    );

    expect(outils.tx.order.create).toHaveBeenCalledTimes(1);
    expect(outils.logger.warn).not.toHaveBeenCalled();
  });
});
