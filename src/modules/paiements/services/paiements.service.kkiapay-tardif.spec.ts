/**
 * Paiement KKiaPay arrivé par le webhook sur une commande déjà sortie de
 * PENDING (reprise par le personnel, confirmée au téléphone) : l'argent est
 * reçu, la commande doit passer payée sans changer de statut.
 *
 * Avant ce correctif, le claim sur PENDING ne trouvait rien et `paied`
 * restait faux : le livreur, Turbo ou la caisse réclamaient l'argent une
 * seconde fois.
 */

import { OrderStatus, OrderType, PaiementStatus, PaymentMethod } from '@prisma/client';
import { PaiementsService } from './paiements.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECU_LE = new Date('2026-10-01T10:00:00.000Z');

function monter(statut: OrderStatus, compteClaim: number) {
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue({ restaurant_id: RESTAURANT_A }),
      updateMany: jest
        .fn()
        .mockResolvedValueOnce({ count: compteClaim })
        .mockResolvedValue({ count: 1 }),
    },
    paiement: { findMany: jest.fn().mockResolvedValue([{ amount: 10000, total: 10000 }]) },
  };
  const kkiapay = {
    verifyTransactionForRestaurant: jest.fn().mockResolvedValue({
      transaction: {
        transactionId: 'kk-1',
        amount: 10000,
        fees: 0,
        source: 'MOBILE_MONEY',
        source_common_name: 'Orange',
        client: 'x',
        status: PaiementStatus.SUCCESS,
      },
      collectedBy: RESTAURANT_A,
    }),
  };
  const promoCodeService = { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) };
  const service = new PaiementsService(
    prisma as never,
    kkiapay as never,
    {} as never,
    promoCodeService as never,
    {} as never,
    { emit: jest.fn() } as never,
  );
  jest.spyOn(service, 'create').mockResolvedValue({
    paiement: { id: 'p1', created_at: RECU_LE },
    order: {
      id: COMMANDE,
      reference: 'CMD-1',
      amount: 10000,
      paied: false,
      status: statut,
      type: OrderType.PICKUP,
      payment_method: PaymentMethod.OFFLINE,
      created_at: RECU_LE,
    },
  } as never);
  return { service, prisma, promoCodeService };
}

const donnees = { transactionId: 'kk-1', orderId: COMMANDE, customer_id: CLIENT } as never;

describe('PaiementsService.linkPaiementToOrder : paiement tardif', () => {
  it("marque payée une commande déjà acceptée, sans toucher à son statut", async () => {
    const { service, prisma, promoCodeService } = monter(OrderStatus.ACCEPTED, 0);

    const resultat = await service.linkPaiementToOrder(donnees);

    expect(resultat.isPaid).toBe(true);
    expect(resultat.justPaid).toBe(false);
    // L'appelant prévient les écrans ouverts : rien d'autre ne part sur ce chemin.
    expect(resultat.payeApresCoup).toBe(true);
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.order.updateMany.mock.calls[1][0]).toEqual({
      where: { id: COMMANDE, paied: false },
      data: { paied: true, paied_at: RECU_LE },
    });
    // Ce paiement solde la commande : plus personne ne l'encaissera, le code
    // promo doit être compté ici.
    expect(promoCodeService.activateUsageForOrder).toHaveBeenCalledTimes(1);
  });

  it("ne compte rien deux fois quand la commande était déjà payée", async () => {
    const { service, prisma, promoCodeService } = monter(OrderStatus.ACCEPTED, 0);
    prisma.order.updateMany.mockReset();
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    const resultat = await service.linkPaiementToOrder(donnees);

    expect(resultat.payeApresCoup).toBe(false);
    expect(promoCodeService.activateUsageForOrder).not.toHaveBeenCalled();
  });

  it('ne refait rien quand le claim sur PENDING a déjà tout posé', async () => {
    const { service, prisma } = monter(OrderStatus.PENDING, 1);

    const resultat = await service.linkPaiementToOrder(donnees);

    expect(resultat.justPaid).toBe(true);
    expect(resultat.payeApresCoup).toBe(false);
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.order.updateMany.mock.calls[0][0].where).toEqual({ id: COMMANDE, status: OrderStatus.PENDING });
  });
});
