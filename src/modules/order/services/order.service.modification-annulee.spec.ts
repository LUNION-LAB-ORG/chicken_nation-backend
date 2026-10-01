/**
 * Qui modifie une commande selon son statut, et ce que la modification d'une
 * commande ANNULÉE ne doit jamais faire (demande du 01/10 : le centre d'appels
 * modifie une commande annulée).
 *
 * La commande reste annulée : l'annulation a rendu le bon, révoqué les points,
 * décompté le code promo et remboursé le paiement. La réactiver, même par
 * accident, rejouerait tout cela. Si l'un de ces tests casse, relisez ce
 * signalement avant de l'adapter.
 *
 * Comme `order.service.bascule.spec.ts`, la méthode est testée en isolation :
 * seules les dépendances qu'elle lit sont greffées.
 */

import { ConflictException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import {
  OrderStatus,
  OrderType,
  PaiementStatus,
  PaymentMethod,
  User,
  UserRole,
  UserType,
} from '@prisma/client';
import {
  motifRefusModification,
  peutModifierCommande,
  STATUTS_MODIFIABLES,
} from '../helpers/modification-commande.rules';
import { UpdateOrderDto } from '../dto/update-order.dto';
import { OrderService } from './order.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const PLAT = '55555555-5555-4555-8555-555555555555';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const compte = (role: UserRole): User =>
  ({
    id: 'u1',
    role,
    type: role === UserRole.ADMIN || role === UserRole.CALL_CENTER ? UserType.BACKOFFICE : UserType.RESTAURANT,
    restaurant_id: role === UserRole.ADMIN || role === UserRole.CALL_CENTER ? null : RESTAURANT_A,
  }) as unknown as User;

/** Commande annulée, payée en ligne : le paiement réussi y reste rattaché (remboursement échoué, bon émis). */
const commandeAnnulee = (surcharge: Record<string, unknown> = {}) => ({
  id: COMMANDE,
  type: OrderType.PICKUP,
  status: OrderStatus.CANCELLED,
  restaurant_id: RESTAURANT_A,
  customer_id: CLIENT,
  auto: true,
  payment_method: PaymentMethod.ONLINE,
  paied: true,
  paied_at: new Date('2026-09-30T12:00:00.000Z'),
  hubrise_order_id: null,
  code_promo: null,
  net_amount: 10000,
  discount: 0,
  tax: 0,
  amount: 10000,
  delivery_fee: 0,
  order_items: [],
  paiements: [{ status: PaiementStatus.SUCCESS, amount: 10000, total: 10000 }],
  ...surcharge,
});

function monter(commande: Record<string, unknown>) {
  let enBase: Record<string, unknown> = { ...commande };
  const prisma = {
    dish: { findMany: jest.fn().mockResolvedValue([{ id: PLAT }]) },
    order: {
      findUnique: jest.fn(async () => enBase),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        enBase = { ...enBase, ...args.data };
        return enBase;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  const greffes = {
    prisma,
    findById: jest.fn().mockResolvedValue(commande),
    // Un total relevé à 15 000 rendrait la commande « non payée ».
    recomputeOrderPaiedFlag: jest.fn(async () => {
      enBase = { ...enBase, paied: false, paied_at: null };
      return enBase;
    }),
    orderHelper: {
      calculateEstimatedTime: jest.fn().mockReturnValue(null),
      calculateOrderDetails: jest.fn().mockResolvedValue({
        orderItems: [
          {
            dish_id: PLAT,
            quantity: 3,
            amount: 15000,
            dishPrice: 5000,
            supplementsPrice: 0,
            lineTotal: 15000,
            epice: false,
            supplements: [],
            options: [],
          },
        ],
        netAmount: 15000,
      }),
    },
    orderEvent: { orderUpdatedEvent: jest.fn(), orderStatusUpdatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderUpdated: jest.fn(), emitStatusUpdate: jest.fn() },
    orderRelance: { noterReprise: jest.fn().mockResolvedValue(undefined) },
    promoCodeService: { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  };
  Object.assign(service, greffes);
  return { service, ...greffes, base: () => enBase };
}

/** Comme le contrôleur : contournement du statut pour l'administrateur seul. */
const modifier = (service: OrderService, role: UserRole, corps: Record<string, unknown>) =>
  service.update(COMMANDE, corps as never, {
    skipStatusCheck: role === UserRole.ADMIN,
    userId: 'u1',
    user: compte(role),
  });

const corpsEcran = {
  type: OrderType.PICKUP,
  address: 'Riviera 3',
  fullname: 'Awa Koné',
  note: 'Rappeler avant de passer',
  items: [{ dish_id: PLAT, quantity: 3 }],
  restaurant_id: RESTAURANT_A,
  customer_id: CLIENT,
  auto: true,
};

describe('peutModifierCommande', () => {
  const tousLesStatuts = Object.values(OrderStatus);

  it("ouvre au centre d'appels les statuts ordinaires et l'annulée, rien d'autre", () => {
    const permis = tousLesStatuts.filter((s) => peutModifierCommande(UserRole.CALL_CENTER, s));
    expect(permis.sort()).toEqual([...STATUTS_MODIFIABLES, OrderStatus.CANCELLED].sort());
  });

  it.each([UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CAISSIER, UserRole.CUISINE])(
    "garde pour %s les seuls statuts ordinaires : ni annulée, ni terminée, ni récupérée",
    (role) => {
      const permis = tousLesStatuts.filter((s) => peutModifierCommande(role, s));
      expect(permis.sort()).toEqual([...STATUTS_MODIFIABLES].sort());
    },
  );

  it("laisse tout à l'administrateur", () => {
    expect(tousLesStatuts.every((s) => peutModifierCommande(UserRole.ADMIN, s))).toBe(true);
  });

  it("refuse l'annulée à un appel sans compte", () => {
    expect(peutModifierCommande(undefined, OrderStatus.CANCELLED)).toBe(false);
    expect(peutModifierCommande(undefined, OrderStatus.ACCEPTED)).toBe(true);
  });

  it('explique le refus en français, sans tiret long', () => {
    for (const role of Object.values(UserRole)) {
      for (const statut of tousLesStatuts) {
        expect(motifRefusModification(role, statut)).not.toMatch(/[–—]|N\/A/);
      }
    }
  });
});

describe("OrderService.update : commande annulée", () => {
  it("le centre d'appels la modifie, et elle reste annulée", async () => {
    const { service, prisma, base, orderEvent } = monter(commandeAnnulee());

    await modifier(service, UserRole.CALL_CENTER, corpsEcran);

    const ecriture = prisma.order.update.mock.calls[0][0].data;
    expect(ecriture).toEqual(expect.objectContaining({ note: 'Rappeler avant de passer', amount: 15000 }));
    expect(ecriture).not.toHaveProperty('status');
    expect(base().status).toBe(OrderStatus.CANCELLED);
    expect(orderEvent.orderUpdatedEvent).toHaveBeenCalledTimes(1);
    expect(orderEvent.orderStatusUpdatedEvent).not.toHaveBeenCalled();
  });

  it('un statut glissé dans le corps est ignoré : la commande ne se réactive pas', async () => {
    const { service, prisma, base } = monter(commandeAnnulee());

    await modifier(service, UserRole.CALL_CENTER, { ...corpsEcran, status: OrderStatus.ACCEPTED });

    expect(prisma.order.update.mock.calls[0][0].data).not.toHaveProperty('status');
    expect(base().status).toBe(OrderStatus.CANCELLED);
  });

  it("garde son état de paiement : un total relevé ne la rend pas « non payée », donc supprimable", async () => {
    const { service, recomputeOrderPaiedFlag, base } = monter(commandeAnnulee());

    await modifier(service, UserRole.CALL_CENTER, corpsEcran);

    expect(recomputeOrderPaiedFlag).not.toHaveBeenCalled();
    expect(base().paied).toBe(true);
  });

  it("ne passe pas en paiement à la caisse, ne prévient ni la relance, ni le restaurant, ni le code promo", async () => {
    const { service, prisma, orderRelance, promoCodeService, orderWebSocketService } = monter(
      commandeAnnulee({ paied: false, paiements: [], auto: false }),
    );

    await modifier(service, UserRole.CALL_CENTER, { ...corpsEcran, auto: false });

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(orderRelance.noterReprise).not.toHaveBeenCalled();
    expect(promoCodeService.activateUsageForOrder).not.toHaveBeenCalled();
    expect(orderWebSocketService.emitStatusUpdate).not.toHaveBeenCalled();
  });

  it("refuse d'en changer l'origine : passer en manuel referait taxe et total", async () => {
    const { service, prisma } = monter(commandeAnnulee({ tax: 500, amount: 10500 }));

    await expect(modifier(service, UserRole.CALL_CENTER, { ...corpsEcran, auto: false })).rejects.toThrow(
      "L'origine d'une commande annulée ne peut pas être changée.",
    );
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it.each([UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CAISSIER])(
    'est refusée à %s, sans rien écrire',
    async (role) => {
      const { service, prisma } = monter(commandeAnnulee());

      const essai = modifier(service, role, corpsEcran);

      await expect(essai).rejects.toBeInstanceOf(ConflictException);
      await expect(essai).rejects.toThrow(
        "Une commande annulée ne peut être modifiée que par l'administrateur ou le centre d'appels.",
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
    },
  );

  it("garde le cloisonnement : un compte d'un autre restaurant n'apprend même pas qu'elle est annulée", async () => {
    const { service, prisma } = monter(commandeAnnulee({ restaurant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));

    await expect(modifier(service, UserRole.MANAGER, corpsEcran)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it("l'administrateur la modifie comme avant, état de paiement recalculé compris", async () => {
    const { service, recomputeOrderPaiedFlag, base } = monter(commandeAnnulee());

    await modifier(service, UserRole.ADMIN, corpsEcran);

    expect(recomputeOrderPaiedFlag).toHaveBeenCalledTimes(1);
    expect(base().status).toBe(OrderStatus.CANCELLED);
  });
});

describe('OrderService.update : commande terminée ou récupérée', () => {
  it.each([OrderStatus.COMPLETED, OrderStatus.COLLECTED, OrderStatus.PICKED_UP])(
    "reste fermée au centre d'appels (%s)",
    async (statut) => {
      const { service, prisma } = monter(commandeAnnulee({ status: statut }));

      await expect(modifier(service, UserRole.CALL_CENTER, corpsEcran)).rejects.toThrow(
        'Seules les commandes en attente, acceptées, en préparation, prêtes ou annulées peuvent être modifiées.',
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
    },
  );

  it.each([OrderStatus.COMPLETED, OrderStatus.COLLECTED])(
    "reste ouverte à l'administrateur (%s)",
    async (statut) => {
      const { service, prisma } = monter(commandeAnnulee({ status: statut }));

      await modifier(service, UserRole.ADMIN, corpsEcran);

      expect(prisma.order.update).toHaveBeenCalledTimes(1);
    },
  );

  it('ne change rien pour une commande acceptée modifiée par la caisse : le paiement se recalcule', async () => {
    const { service, recomputeOrderPaiedFlag } = monter(
      commandeAnnulee({ status: OrderStatus.ACCEPTED, auto: false, payment_method: PaymentMethod.OFFLINE }),
    );

    await modifier(service, UserRole.CAISSIER, { ...corpsEcran, auto: false });

    expect(recomputeOrderPaiedFlag).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /orders/:id : le corps ne porte pas de statut', () => {
  it('le ValidationPipe global (whitelist) retire `status` avant le contrôleur', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const corps = await pipe.transform(
      { note: 'x', status: OrderStatus.ACCEPTED },
      { type: 'body', metatype: UpdateOrderDto },
    );
    expect(corps).not.toHaveProperty('status');
    expect(corps).toHaveProperty('note', 'x');
  });
});
