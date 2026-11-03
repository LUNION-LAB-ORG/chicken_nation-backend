/**
 * COMMANDE REMISE AU CLIENT ALORS QU'ELLE EST DÉJÀ PAYÉE (03/11).
 *
 * La caisse encaisse souvent avant la remise : au comptoir, ou quand le
 * livreur rapporte l'argent. L'encaissement ne termine que ce qui est déjà
 * récupéré, et la remise (« Récupérée ») ne regardait pas le paiement : la
 * commande restait « Récupérée » pour toujours. Payée, elle se termine
 * maintenant, comme dans l'appli du livreur et avec Turbo.
 *
 * Méthode testée en isolation, comme `order.service.remise-livreur.spec.ts` :
 * les écritures conditionnées sont évaluées sur la ligne « en base ».
 */
import { OrderStatus, OrderType, UserRole } from '@prisma/client';

import { correspond } from '../relance/relance.base-simulee-spec';
import { OrderService } from './order.service';

type Ligne = Record<string, any>;

function monter(commande: Ligne, changerAvantEcriture?: (enBase: Ligne) => void) {
  const enBase: Ligne = { ...commande };
  const prisma = {
    order: {
      update: jest.fn(async ({ data }: { where: Ligne; data: Ligne }) => {
        changerAvantEcriture?.(enBase);
        changerAvantEcriture = undefined;
        Object.assign(enBase, data);
        return { ...enBase };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Ligne; data: Ligne }) => {
        if (!correspond(enBase, where)) return { count: 0 };
        Object.assign(enBase, data);
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => ({ ...enBase })),
    },
    notificationSetting: { findUnique: jest.fn(async () => null) },
  };
  const greffes = {
    prisma,
    findById: jest.fn(async () => ({ ...commande })),
    orderHelper: {
      validateStatusTransition: jest.fn(),
      assertPreparationAutorisee: jest.fn(),
      handleStatusSpecificActions: jest.fn(async () => undefined),
      calculateEstimatedTime: jest.fn(() => null),
    },
    promoCodeService: { activateUsageForOrder: jest.fn(async () => undefined) },
    orderCoupon: { restituerPourCommande: jest.fn(async () => ({ bons: [], codesPromo: [] })) },
    orderEvent: { orderStatusUpdatedEvent: jest.fn() },
    orderWebSocketService: { emitStatusUpdate: jest.fn() },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, greffes);
  return { service, enBase, ...greffes };
}

const aEmporterPrete = (surcharge: Ligne = {}): Ligne => ({
  id: 'o1',
  reference: 'ORD-1',
  type: OrderType.PICKUP,
  status: OrderStatus.READY,
  auto: false,
  paied: false,
  restaurant_id: 'r1',
  customer_id: 'c1',
  ...surcharge,
});
const caissiere = { userId: 'u1', role: UserRole.CAISSIER };

describe('OrderService.updateStatus : remise au client d’une commande déjà payée', () => {
  it('payée à la caisse avant la remise : « Récupérée » la termine, l’événement part une fois, terminée', async () => {
    const { service, enBase, orderEvent, orderWebSocketService } = monter(aEmporterPrete({ paied: true }));

    const reponse = await service.updateStatus('o1', OrderStatus.COLLECTED, caissiere);

    expect(enBase.status).toBe(OrderStatus.COMPLETED);
    expect(enBase.collected_at).toBeInstanceOf(Date);
    expect(enBase.completed_at).toBeInstanceOf(Date);
    expect(reponse.status).toBe(OrderStatus.COMPLETED);
    expect(orderEvent.orderStatusUpdatedEvent).toHaveBeenCalledTimes(1);
    expect(orderEvent.orderStatusUpdatedEvent.mock.calls[0][0].order.status).toBe(OrderStatus.COMPLETED);
    // Les écrans passent de « Prête » à « Terminée ».
    expect(orderWebSocketService.emitStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: OrderStatus.COMPLETED }),
      OrderStatus.READY,
    );
  });

  it('encaissée entre la lecture et l’écriture : terminée aussi', async () => {
    const { service, enBase } = monter(aEmporterPrete(), (ligne) => {
      ligne.paied = true; // la caisse vient d'encaisser
    });

    await service.updateStatus('o1', OrderStatus.COLLECTED, caissiere);

    expect(enBase.status).toBe(OrderStatus.COMPLETED);
  });

  it('pas encore payée : reste « Récupérée », l’encaissement la terminera', async () => {
    const { service, enBase, prisma, orderEvent } = monter(aEmporterPrete());

    await service.updateStatus('o1', OrderStatus.COLLECTED, caissiere);

    expect(enBase.status).toBe(OrderStatus.COLLECTED);
    expect(enBase.completed_at).toBeUndefined();
    expect(prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(orderEvent.orderStatusUpdatedEvent.mock.calls[0][0].order.status).toBe(OrderStatus.COLLECTED);
  });

  it('les autres transitions ne sont pas concernées', async () => {
    const { service, enBase, prisma } = monter(aEmporterPrete({ status: OrderStatus.IN_PROGRESS, paied: true }));

    await service.updateStatus('o1', OrderStatus.READY, caissiere);

    expect(enBase.status).toBe(OrderStatus.READY);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });
});
