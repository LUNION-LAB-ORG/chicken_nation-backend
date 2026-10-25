/**
 * Heure écrite par `OrderService.create()` quand la saisie n'en donne pas.
 *
 * Défaut relevé le 24/10 : une commande sans heure recevait « 10:00 ». Une
 * commande du centre d'appels passée à 15 h se retrouvait donc à 10 h, et une
 * commande passée à 7 h 30 devenait « Plus tard · 10h00 » : le serveur
 * refusait alors sa préparation avant 9 h. Sans heure saisie, c'est l'heure
 * de création à Abidjan (UTC+0) qui est écrite, comme le fait déjà
 * l'application (`createv2`).
 *
 * Même montage que order.service.canal.spec.ts : seules les dépendances lues
 * par la méthode sont greffées.
 */

import { OrderStatus, OrderType, User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { OrderHelper } from '../helpers/order.helper';
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
      remiseFidelite: jest.fn().mockResolvedValue({ remise: 0, points: 0 }),
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
const saisieDuPersonnel = (auteur: User, champs: Record<string, unknown> = {}) => {
  const { service, ecrites } = monter();
  return service
    .create({ user: auteur } as unknown as Request, {
      type: OrderType.PICKUP,
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      user_id: auteur.id,
      items: [],
      ...champs,
    } as never)
    .then(() => ecrites[0]);
};

const CALL_CENTER = compte(UserRole.CALL_CENTER, UserType.BACKOFFICE);

/** Fige l'horloge (Date seulement : les promesses et minuteries restent réelles). */
const horloge = (iso: string) =>
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
  });

afterEach(() => jest.useRealTimers());

describe('OrderService.create : heure de la commande', () => {
  it("centre d'appels, sans heure, à 15 h 07 : 15:07, plus 10:00", async () => {
    horloge('2026-10-25T15:07:42.000Z');
    const commande = await saisieDuPersonnel(CALL_CENTER);
    expect(commande.time).toBe('15:07');
    expect((commande.date as Date).toISOString().slice(0, 10)).toBe('2026-10-25');
  });

  it('caissier, sans heure : heure de création', async () => {
    horloge('2026-10-25T19:45:00.000Z');
    const commande = await saisieDuPersonnel(compte(UserRole.CAISSIER, UserType.RESTAURANT));
    expect(commande.time).toBe('19:45');
  });

  it('ancienne route client, sans heure : heure de création', async () => {
    horloge('2026-10-25T12:03:00.000Z');
    const { service, ecrites } = monter();
    await service.create({ user: { id: CLIENT, phone: '+2250700000000' } } as unknown as Request, {
      type: OrderType.PICKUP,
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      user_id: undefined,
      items: [],
    } as never);
    expect(ecrites[0].time).toBe('12:03');
  });

  it('heure vide ou faite d\'espaces : heure de création', async () => {
    horloge('2026-10-25T08:05:00.000Z');
    expect((await saisieDuPersonnel(CALL_CENTER, { time: '' })).time).toBe('08:05');
    expect((await saisieDuPersonnel(CALL_CENTER, { time: '   ' })).time).toBe('08:05');
  });

  it('heure saisie : gardée telle quelle (commande programmée)', async () => {
    horloge('2026-10-25T15:07:00.000Z');
    const commande = await saisieDuPersonnel(CALL_CENTER, { time: '20:00' });
    expect(commande.time).toBe('20:00');
  });

  it('juste avant minuit : date et heure du même instant', async () => {
    horloge('2026-10-25T23:59:30.000Z');
    const commande = await saisieDuPersonnel(CALL_CENTER);
    expect(commande.time).toBe('23:59');
    expect((commande.date as Date).toISOString().slice(0, 10)).toBe('2026-10-25');
  });

  it('commande sans heure passée à 7 h 30 : préparation permise tout de suite', async () => {
    horloge('2026-10-25T07:30:00.000Z');
    const commande = await saisieDuPersonnel(CALL_CENTER);
    // Avec « 10:00 », la commande passait pour programmée et le serveur
    // refusait sa préparation avant 9 h.
    const aide = Object.create(OrderHelper.prototype) as OrderHelper;
    expect(() => aide.assertPreparationAutorisee(commande, OrderStatus.IN_PROGRESS)).not.toThrow();
  });
});
