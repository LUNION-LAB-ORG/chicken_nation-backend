/**
 * OrderService : encaissement espèces cloisonné au restaurant du compte, et
 * aucune commande qui sorte avec les réglages de notification du client.
 *
 * On teste les méthodes en isolation (comme `order.service.gift.spec.ts`) :
 * seules les dépendances qu'elles lisent sont greffées sur le prototype.
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  EntityStatus,
  OrderStatus,
  OrderType,
  PaymentMethod,
  User,
  UserRole,
  UserType,
} from '@prisma/client';
import { CLIENT_COMMANDE_SELECT } from '../constantes/client-commande.select';
import { OrderService } from './order.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTAURANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const compte = (type: UserType, role: UserRole, restaurant_id: string | null) =>
  ({ id: 'u1', type, role, restaurant_id }) as unknown as User;
const caissierA = compte(UserType.RESTAURANT, UserRole.CAISSIER, RESTAURANT_A);
const administrateur = compte(UserType.BACKOFFICE, UserRole.ADMIN, null);

function monter() {
  const prisma = {
    order: { findUnique: jest.fn(), update: jest.fn() },
    notificationSetting: { findUnique: jest.fn() },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  const greffes = {
    prisma,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    promoCodeService: {
      activateUsageForOrder: jest.fn().mockResolvedValue(undefined),
      deactivateUsageForOrder: jest.fn().mockResolvedValue(undefined),
    },
    orderWebSocketService: { emitOrderUpdated: jest.fn(), emitStatusUpdate: jest.fn() },
    orderEvent: { orderStatusUpdatedEvent: jest.fn() },
    orderHelper: {
      validateStatusTransition: jest.fn(),
      assertPreparationAutorisee: jest.fn(),
      handleStatusSpecificActions: jest.fn().mockResolvedValue(undefined),
      calculateEstimatedTime: jest.fn().mockReturnValue(null),
    },
    signalerAnomaliePaiement: jest.fn(),
  };
  Object.assign(service, greffes);
  return { service, ...greffes };
}

const commandeEspeces = (surcharge: Record<string, unknown> = {}) => ({
  id: COMMANDE,
  reference: 'CMD-1',
  restaurant_id: RESTAURANT_A,
  customer_id: CLIENT,
  amount: 8000,
  paied: false,
  payment_method: PaymentMethod.OFFLINE,
  status: OrderStatus.COLLECTED,
  entity_status: EntityStatus.ACTIVE,
  ...surcharge,
});

describe('OrderService.markPaidCash', () => {
  it("interdit à un caissier de solder la commande d'un autre restaurant, avant toute écriture", async () => {
    const { service, prisma } = monter();
    prisma.order.findUnique.mockResolvedValue(commandeEspeces({ restaurant_id: RESTAURANT_B }));

    await expect(service.markPaidCash(COMMANDE, 8000, caissierA)).rejects.toThrow(ForbiddenException);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('refuse une commande annulée', async () => {
    const { service, prisma } = monter();
    prisma.order.findUnique.mockResolvedValue(commandeEspeces({ status: OrderStatus.CANCELLED }));

    await expect(service.markPaidCash(COMMANDE, 8000, caissierA)).rejects.toThrow(BadRequestException);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('solde SA commande et ne relit du client que ce que lisent les écrans', async () => {
    const { service, prisma, orderWebSocketService } = monter();
    prisma.order.findUnique.mockResolvedValue(commandeEspeces());
    prisma.order.update.mockResolvedValue({ ...commandeEspeces(), paied: true, code_promo: null });

    await service.markPaidCash(COMMANDE, 8000, caissierA);

    const appel = prisma.order.update.mock.calls[0][0];
    expect(appel.data).toEqual(expect.objectContaining({ paied: true, status: OrderStatus.COMPLETED }));
    expect(appel.include.customer).toEqual({ select: CLIENT_COMMANDE_SELECT });
    expect(orderWebSocketService.emitOrderUpdated).toHaveBeenCalledTimes(1);
  });

  it('laisse le back office solder dans tout le réseau', async () => {
    const { service, prisma } = monter();
    prisma.order.findUnique.mockResolvedValue(commandeEspeces({ restaurant_id: RESTAURANT_B }));
    prisma.order.update.mockResolvedValue({ ...commandeEspeces(), paied: true, code_promo: null });

    await service.markPaidCash(COMMANDE, 8000, administrateur);
    expect(prisma.order.update).toHaveBeenCalledTimes(1);
  });
});

describe('OrderService.updateStatus', () => {
  function preparer() {
    const outils = monter();
    (outils.service as unknown as { findById: jest.Mock }).findById = jest.fn().mockResolvedValue({
      id: COMMANDE,
      type: OrderType.PICKUP,
      status: OrderStatus.IN_PROGRESS,
      payment_method: PaymentMethod.OFFLINE,
    });
    outils.prisma.order.update.mockResolvedValue({
      id: COMMANDE,
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      status: OrderStatus.READY,
      customer: { id: CLIENT, first_name: 'Awa' },
    });
    return outils;
  }

  it('ne demande plus les réglages de notification dans la commande qui repart', async () => {
    const { service, prisma } = preparer();
    prisma.notificationSetting.findUnique.mockResolvedValue({ expo_push_token: 'ExponentPushToken[abc]' });

    const commande = await service.updateStatus(COMMANDE, OrderStatus.READY, { role: UserRole.CAISSIER, userId: 'u1' });

    expect(prisma.order.update.mock.calls[0][0].include.customer).toEqual({ select: CLIENT_COMMANDE_SELECT });
    expect(commande.customer).not.toHaveProperty('notification_settings');
  });

  it('passe le jeton, relu à part, à la seule notification interne', async () => {
    const { service, prisma, orderEvent } = preparer();
    prisma.notificationSetting.findUnique.mockResolvedValue({ expo_push_token: 'ExponentPushToken[abc]' });

    await service.updateStatus(COMMANDE, OrderStatus.READY, {});

    expect(prisma.notificationSetting.findUnique).toHaveBeenCalledWith({
      where: { customer_id: CLIENT },
      select: { expo_push_token: true },
    });
    expect(orderEvent.orderStatusUpdatedEvent.mock.calls[0][0].expo_token).toBe('ExponentPushToken[abc]');
  });

  it('ne perd pas la transition si le jeton est illisible : seule la notification tombe', async () => {
    const { service, prisma, orderEvent, orderWebSocketService } = preparer();
    prisma.notificationSetting.findUnique.mockRejectedValue(new Error('base injoignable'));

    await expect(service.updateStatus(COMMANDE, OrderStatus.READY, {})).resolves.toBeDefined();
    expect(orderEvent.orderStatusUpdatedEvent.mock.calls[0][0].expo_token).toBeNull();
    expect(orderWebSocketService.emitStatusUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('OrderService.update', () => {
  function preparer(restaurant_id: string) {
    const outils = monter();
    (outils.service as unknown as { findById: jest.Mock }).findById = jest.fn().mockResolvedValue({
      id: COMMANDE,
      type: OrderType.PICKUP,
      status: OrderStatus.READY,
      restaurant_id,
      order_items: [],
    });
    outils.prisma.order.update.mockResolvedValue({ id: COMMANDE, restaurant_id, customer_id: CLIENT });
    const orderEvent = outils.orderEvent as unknown as { orderUpdatedEvent: jest.Mock };
    orderEvent.orderUpdatedEvent = jest.fn();
    return outils;
  }

  it("interdit à un caissier de modifier la commande d'un autre restaurant, avant toute écriture", async () => {
    const { service, prisma, orderWebSocketService } = preparer(RESTAURANT_B);

    await expect(
      service.update(COMMANDE, { note: 'x' } as never, { userId: 'u1', user: caissierA }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(orderWebSocketService.emitOrderUpdated).not.toHaveBeenCalled();
  });

  it('laisse le caissier modifier une commande de SON restaurant', async () => {
    const { service, prisma } = preparer(RESTAURANT_A);

    await service.update(COMMANDE, { note: 'x' } as never, { userId: 'u1', user: caissierA });
    expect(prisma.order.update).toHaveBeenCalledTimes(1);
  });

  it('laisse le back office modifier dans tout le réseau', async () => {
    const { service, prisma } = preparer(RESTAURANT_B);

    await service.update(COMMANDE, { note: 'x' } as never, { userId: 'u1', user: administrateur });
    expect(prisma.order.update).toHaveBeenCalledTimes(1);
  });
});
