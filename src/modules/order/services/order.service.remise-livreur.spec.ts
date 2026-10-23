/**
 * BOUTON « LIVREUR A RÉCUPÉRÉ » ET CODE DE RETRAIT AU MÊME INSTANT
 * (relecture du 23/10).
 *
 * Une caisse saisit le code : la commande ajoutée passe PICKED_UP. L'autre
 * caisse appuie au même moment sur « Livreur a récupéré » : sa lecture disait
 * encore READY, son écriture sans condition passait quand même, l'événement
 * repartait et le livreur recevait deux fois « Tout est récupéré » (journal :
 * deux RETRAIT_COMPLEMENTAIRE). La remise au livreur n'est plus écrite que si
 * la commande est encore dans l'état lu : 409 pour le second, rien d'annoncé.
 *
 * Méthode testée en isolation, comme `order.service.panier-annule.spec.ts` :
 * l'écriture conditionnée est évaluée sur la ligne « en base ».
 */
import { ConflictException } from '@nestjs/common';
import { OrderStatus, OrderType, Prisma, UserRole } from '@prisma/client';

import { correspond } from '../relance/relance.base-simulee-spec';
import { OrderService } from './order.service';

type Ligne = Record<string, any>;

function monter(commande: Ligne, changerAvantEcriture?: (enBase: Ligne) => void) {
  const enBase: Ligne = { ...commande };
  const prisma = {
    order: {
      update: jest.fn(async ({ where, data }: { where: Ligne; data: Ligne }) => {
        changerAvantEcriture?.(enBase);
        changerAvantEcriture = undefined;
        if (!correspond(enBase, where)) {
          throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', { code: 'P2025', clientVersion: 'test' });
        }
        Object.assign(enBase, data);
        return { ...enBase };
      }),
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

const prete = (): Ligne => ({
  id: 'o1',
  reference: 'ORD-1',
  type: OrderType.DELIVERY,
  status: OrderStatus.READY,
  restaurant_id: 'r1',
  customer_id: 'c1',
});
const caissiere = { userId: 'u1', role: UserRole.CAISSIER };

describe('OrderService.updateStatus : remise au livreur conditionnée à l’état lu', () => {
  it('le code de retrait l’a remise entre la lecture et l’écriture : 409, aucun événement', async () => {
    const { service, enBase, orderEvent, orderWebSocketService } = monter(prete(), (ligne) => {
      ligne.status = OrderStatus.PICKED_UP; // l'autre caisse vient de saisir le code
      ligne.picked_up_at = new Date('2026-10-23T12:00:00.000Z');
    });

    await expect(service.updateStatus('o1', OrderStatus.PICKED_UP, caissiere)).rejects.toBeInstanceOf(ConflictException);
    expect(orderEvent.orderStatusUpdatedEvent).not.toHaveBeenCalled();
    expect(orderWebSocketService.emitStatusUpdate).not.toHaveBeenCalled();
    // L'heure de la remise par le code n'est pas écrasée.
    expect(enBase.picked_up_at).toEqual(new Date('2026-10-23T12:00:00.000Z'));
  });

  it('déjà remise par le code quand le bouton est lu : 409 « déjà remise », aucun événement', async () => {
    const { service, orderEvent, prisma } = monter({ ...prete(), status: OrderStatus.PICKED_UP });
    await expect(service.updateStatus('o1', OrderStatus.PICKED_UP, caissiere)).rejects.toThrow('Cette commande est déjà remise au livreur.');
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(orderEvent.orderStatusUpdatedEvent).not.toHaveBeenCalled();
  });

  it('cas normal : la commande prête passe récupérée et l’événement part une fois', async () => {
    const { service, enBase, orderEvent } = monter(prete());
    await service.updateStatus('o1', OrderStatus.PICKED_UP, caissiere);
    expect(enBase.status).toBe(OrderStatus.PICKED_UP);
    expect(orderEvent.orderStatusUpdatedEvent).toHaveBeenCalledTimes(1);
  });

  it('les autres transitions du personnel restent écrites comme avant (sans condition ajoutée)', async () => {
    const { service, prisma } = monter({ ...prete(), status: OrderStatus.IN_PROGRESS });
    await service.updateStatus('o1', OrderStatus.READY, caissiere);
    expect(prisma.order.update.mock.calls[0][0].where).toEqual({ id: 'o1' });
  });
});
