/**
 * Changer le client d'une commande depuis « Modifier la commande » (27/11) :
 * autre numéro, autre nom. La commande passe au client désigné, et ce qui
 * est inscrit sur la commande (nom, téléphone, courriel) le suit.
 *
 * Refusé quand l'ancien client a engagé un coupon ou sa fidélité sur la
 * commande. Règles pures : helpers/changement-client.rules.ts.
 *
 * Comme `order.service.modification-annulee.spec.ts`, la méthode est testée
 * en isolation : seules les dépendances qu'elle lit sont greffées.
 */

import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, OrderType, PaymentMethod, User, UserRole, UserType } from '@prisma/client';
import { REFUS_CLIENT_COUPON, REFUS_CLIENT_FIDELITE } from '../helpers/changement-client.rules';
import { OrderService } from './order.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const ANCIEN = '44444444-4444-4444-8444-444444444444';
const NOUVEAU = '66666666-6666-4666-8666-666666666666';
const RESTAURANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const agent = { id: 'u1', role: UserRole.CALL_CENTER, type: UserType.BACKOFFICE, restaurant_id: null } as unknown as User;

/** Commande saisie au téléphone, acceptée, sans coupon ni fidélité. */
const commande = (surcharge: Record<string, unknown> = {}) => ({
  id: COMMANDE,
  type: OrderType.PICKUP,
  status: OrderStatus.ACCEPTED,
  restaurant_id: RESTAURANT,
  customer_id: ANCIEN,
  auto: false,
  payment_method: PaymentMethod.OFFLINE,
  paied: false,
  paied_at: null,
  hubrise_order_id: null,
  code_promo: null,
  points: 0,
  fullname: 'Gnagne Ange',
  phone: '+2250500968284',
  email: 'ange@exemple.ci',
  net_amount: 5000,
  discount: 0,
  tax: 0,
  amount: 5000,
  delivery_fee: 0,
  order_items: [],
  paiements: [],
  ...surcharge,
});

const fiche = { id: NOUVEAU, first_name: 'Awa', last_name: 'Koné', phone: '+2250707070707', email: null };

function monter(
  base: Record<string, unknown>,
  { client = fiche as typeof fiche | null, mouvements = 0, recompenses = 0 } = {},
) {
  let enBase: Record<string, unknown> = { ...base };
  const prisma = {
    order: {
      findUnique: jest.fn(async () => enBase),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        enBase = { ...enBase, ...args.data };
        return enBase;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    customer: { findFirst: jest.fn().mockResolvedValue(client) },
    loyaltyPoint: { count: jest.fn().mockResolvedValue(mouvements) },
    reward: { count: jest.fn().mockResolvedValue(recompenses) },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, {
    prisma,
    findById: jest.fn().mockResolvedValue(base),
    recomputeOrderPaiedFlag: jest.fn(async () => enBase),
    orderHelper: { calculateEstimatedTime: jest.fn().mockReturnValue(null) },
    orderEvent: { orderUpdatedEvent: jest.fn(), orderStatusUpdatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderUpdated: jest.fn(), emitStatusUpdate: jest.fn() },
    orderRelance: { noterReprise: jest.fn().mockResolvedValue(undefined) },
    promoCodeService: { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  });
  return { service, prisma };
}

const modifier = (service: OrderService, corps: Record<string, unknown>) =>
  service.update(COMMANDE, corps as never, { userId: 'u1', user: agent });

const ecrit = (prisma: ReturnType<typeof monter>['prisma']) =>
  prisma.order.update.mock.calls[0][0].data as Record<string, unknown>;

describe('OrderService.update, changement de client', () => {
  it('rattache la commande au nouveau client, avec le nom saisi et son numéro au format du serveur', async () => {
    const { service, prisma } = monter(commande());

    await modifier(service, { customer_id: NOUVEAU, fullname: 'Awa K.', phone: '07 07 07 07 07' });

    expect(prisma.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: NOUVEAU }) }),
    );
    expect(ecrit(prisma)).toMatchObject({
      customer: { connect: { id: NOUVEAU } },
      fullname: 'Awa K.',
      phone: '+2250707070707',
    });
  });

  it("sans nom ni numéro saisis, inscrit ceux du nouveau client, jamais ceux de l'ancien", async () => {
    const { service, prisma } = monter(commande());

    await modifier(service, { customer_id: NOUVEAU });

    expect(ecrit(prisma)).toMatchObject({
      customer: { connect: { id: NOUVEAU } },
      fullname: 'Awa Koné',
      phone: '+2250707070707',
      email: null,
    });
  });

  it('refuse avec un code promo ou un bon', async () => {
    const { service, prisma } = monter(commande({ code_promo: 'CN-ABC12' }));

    await expect(modifier(service, { customer_id: NOUVEAU })).rejects.toThrow(new ConflictException(REFUS_CLIENT_COUPON));
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('refuse quand des points ont été dépensés sur la commande', async () => {
    const { service, prisma } = monter(commande({ points: 300 }));

    await expect(modifier(service, { customer_id: NOUVEAU })).rejects.toThrow(new ConflictException(REFUS_CLIENT_FIDELITE));
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it.each([
    ['des points', { mouvements: 1 }],
    ['un cadeau', { recompenses: 1 }],
  ])('refuse quand %s sont rattachés à la commande', async (_quoi, liens) => {
    const { service, prisma } = monter(commande(), liens);

    await expect(modifier(service, { customer_id: NOUVEAU })).rejects.toThrow(new ConflictException(REFUS_CLIENT_FIDELITE));
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('refuse un client introuvable ou supprimé', async () => {
    const { service, prisma } = monter(commande(), { client: null });

    await expect(modifier(service, { customer_id: NOUVEAU })).rejects.toThrow(
      new BadRequestException('Client introuvable ou compte supprimé.'),
    );
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('même client : rien de plus à lire, le nom saisi est seulement noté sur la commande', async () => {
    const { service, prisma } = monter(commande({ code_promo: 'CN-ABC12', points: 300 }));

    await modifier(service, { customer_id: ANCIEN, fullname: 'Ange Junias' });

    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    expect(prisma.loyaltyPoint.count).not.toHaveBeenCalled();
    expect(ecrit(prisma)).toMatchObject({ fullname: 'Ange Junias' });
    expect(ecrit(prisma)).not.toHaveProperty('phone');
  });
});
