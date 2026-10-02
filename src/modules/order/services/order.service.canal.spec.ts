/**
 * Canal écrit par `OrderService.create()` : ancienne route client (APP),
 * centre d'appels (CALL_CENTER) ou comptoir d'un restaurant (RESTAURANT).
 *
 * Signalement du 02/10 : une vente saisie par un caissier partait
 * CALL_CENTER. La règle elle-même est testée dans
 * canal-commande.rules.spec.ts ; ici, on vérifie que la création l'applique
 * avec l'auteur du JETON.
 *
 * Comme order.service.coupon.spec.ts, la méthode est testée en isolation :
 * seules les dépendances qu'elle lit sont greffées.
 */

import { OrderChannel, OrderType, User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { OrderService } from './order.service';

const CLIENT = '44444444-4444-4444-8444-444444444444';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const compte = (role: UserRole, type: UserType) =>
  ({ id: `u-${role}`, role, type, restaurant_id: type === UserType.RESTAURANT ? RESTAURANT_A : null }) as unknown as User;

function monter() {
  const ecrites: Record<string, any>[] = [];
  const tx = {
    order: {
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        const commande = { id: `commande-${ecrites.length + 1}`, ...data };
        ecrites.push(commande);
        return commande;
      }),
    },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, {
    prisma: { $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)) },
    orderHelper: {
      resolveCustomerData: jest.fn().mockResolvedValue({
        customer_id: CLIENT,
        loyalty_level: undefined,
        total_points: 0,
        fullname: 'Awa Koné',
        phone: '+2250700000000',
        email: null,
      }),
      getDishesWithDetails: jest.fn().mockResolvedValue([]),
      calculateOrderDetails: jest.fn().mockResolvedValue({
        orderItems: [],
        netAmount: 5000,
        totalDishes: 5000,
        totalDishesEtOptions: 5000,
      }),
      calculatePromotionPrice: jest.fn().mockResolvedValue(null),
      getClosestRestaurant: jest.fn().mockResolvedValue({ id: RESTAURANT_A, name: 'A' }),
      assertDishesSoldInRestaurant: jest.fn().mockResolvedValue(undefined),
      checkPayment: jest.fn().mockResolvedValue(null),
      calculateLoyaltyFee: jest.fn().mockResolvedValue(0),
      calculateTax: jest.fn().mockResolvedValue(250),
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
  });
  return { service, ecrites };
}

/** Comme POST /orders/create : user_id = l'auteur du jeton. */
const saisieDuPersonnel = (auteur: User) => {
  const { service, ecrites } = monter();
  return service
    .create({ user: auteur } as unknown as Request, {
      type: OrderType.PICKUP,
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      user_id: auteur.id,
      items: [],
    } as never)
    .then(() => ecrites[0]);
};

describe('OrderService.create : canal de la commande', () => {
  it('caissier (compte de restaurant) : RESTAURANT', async () => {
    const commande = await saisieDuPersonnel(compte(UserRole.CAISSIER, UserType.RESTAURANT));
    expect(commande.channel).toBe(OrderChannel.RESTAURANT);
  });

  it('gérant (compte de restaurant) : RESTAURANT', async () => {
    const commande = await saisieDuPersonnel(compte(UserRole.MANAGER, UserType.RESTAURANT));
    expect(commande.channel).toBe(OrderChannel.RESTAURANT);
  });

  it("agent du centre d'appels : CALL_CENTER", async () => {
    const commande = await saisieDuPersonnel(compte(UserRole.CALL_CENTER, UserType.BACKOFFICE));
    expect(commande.channel).toBe(OrderChannel.CALL_CENTER);
  });

  it('administrateur : CALL_CENTER', async () => {
    const commande = await saisieDuPersonnel(compte(UserRole.ADMIN, UserType.BACKOFFICE));
    expect(commande.channel).toBe(OrderChannel.CALL_CENTER);
  });

  it('ancienne route client (sans user_id) : APP', async () => {
    const { service, ecrites } = monter();
    await service.create({ user: { id: CLIENT, phone: '+2250700000000' } } as unknown as Request, {
      type: OrderType.PICKUP,
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      user_id: undefined,
      items: [],
    } as never);
    expect(ecrites[0].channel).toBe(OrderChannel.APP);
  });
});
