import { CodeAlerte } from 'src/modules/alertes/alertes.service';
/**
 * Points utilisés retirés DÈS LE PAIEMENT en ligne (02/10).
 *
 * Le paiement fait passer la commande de PENDING à ACCEPTED sans événement de
 * statut : avant, les points n'étaient retirés qu'à la clôture, et pouvaient
 * payer un second panier entre-temps.
 *
 * Écouteur testé en isolation ; LoyaltyService RÉEL sur la base en mémoire,
 * pour éprouver l'idempotence de bout en bout.
 */
import { LoyaltyPointType, OrderStatus, PaymentMethod } from '@prisma/client';
import {
  CLIENT,
  COMMANDE,
  commande as commandeEnBase,
  monterFidelite,
} from 'src/modules/fidelity/services/loyalty.base-simulee-spec';
import { KkiapayOrderListenerService } from './kkiapay-order.listener.service';

const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function monter(
  {
    points = 150,
    statut = OrderStatus.PENDING,
    justPaid = true,
    solde = 400,
  }: { points?: number; statut?: OrderStatus; justPaid?: boolean; solde?: number } = {},
) {
  // Commande telle que lue AVANT le claim du paiement.
  const commande = {
    id: COMMANDE,
    reference: 'ORD-261002-1',
    customer_id: CLIENT,
    restaurant_id: RESTAURANT_A,
    payment_method: PaymentMethod.ONLINE,
    status: statut,
    paied: false,
    points,
    net_amount: 0,
    order_items: [],
    customer: { loyalty_level: null, notification_settings: null },
  };
  // En base, le claim l'a passée ACCEPTED (sauf annulation).
  const fidelite = monterFidelite({
    solde,
    commandes: [
      commandeEnBase({
        points,
        status: statut === OrderStatus.CANCELLED ? OrderStatus.CANCELLED : OrderStatus.ACCEPTED,
      }),
    ],
  });
  const d = {
    orderService: {
      findByReferenceOrNull: jest.fn().mockResolvedValue(commande),
      findById: jest.fn().mockResolvedValue(commande),
    },
    paiementsService: {
      linkPaiementToOrder: jest.fn().mockResolvedValue({
        paiement: { id: 'p1' },
        justPaid,
        isPaid: true,
        payeApresCoup: false,
        annuleeRetablie: false,
        enDouble: false,
      }),
    },
    orderEvent: { orderCreatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderUpdated: jest.fn(), emitOrderCreated: jest.fn() },
    expoPushService: { sendPushNotifications: jest.fn() },
    notificationsSender: { sendOrderBell: jest.fn() },
    loyaltyService: fidelite.service,
    scratchEngineService: { drawForOrder: jest.fn() },
    referralService: { accrueForPaidOrder: jest.fn() },
    alertes: { signaler: jest.fn() },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  };
  const ecouteur = Object.create(KkiapayOrderListenerService.prototype) as KkiapayOrderListenerService;
  Object.assign(ecouteur, d);
  return { ecouteur, d, fidelite };
}

const traiter = (ecouteur: KkiapayOrderListenerService) =>
  ecouteur.processTransactionSuccess({ stateData: 'ORD-261002-1', transactionId: 'kk-1' } as never);

describe('KkiapayOrderListenerService : points utilisés retirés au paiement', () => {
  it('paiement validé : les points de la commande sont retirés tout de suite', async () => {
    const { ecouteur, fidelite } = monter();
    const retrait = jest.spyOn(fidelite.service, 'redeemPoints');

    const resultat = await traiter(ecouteur);

    expect(resultat).toEqual(expect.objectContaining({ confirmed: true, justPaid: true }));
    expect(retrait).toHaveBeenCalledWith({
      customer_id: CLIENT,
      points: 150,
      order_id: COMMANDE,
      reason: '🔥 150 points utilisés pour la commande #ORD-261002-1',
    });
    expect(fidelite.solde()).toBe(250);
    expect(fidelite.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(1);
  });

  it('webhook rejoué (retry, double serveur, confirmation manuelle) : retiré une seule fois', async () => {
    const { ecouteur, d, fidelite } = monter();

    await traiter(ecouteur);
    d.paiementsService.linkPaiementToOrder.mockResolvedValue({
      paiement: { id: 'p1' },
      justPaid: false,
      isPaid: true,
      payeApresCoup: false,
      annuleeRetablie: false,
      enDouble: false,
    });
    await traiter(ecouteur);
    await traiter(ecouteur);

    expect(fidelite.solde()).toBe(250);
    expect(fidelite.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(1);
  });

  it('commande sans points : aucun retrait', async () => {
    const { ecouteur, fidelite } = monter({ points: 0 });
    const retrait = jest.spyOn(fidelite.service, 'redeemPoints');

    await traiter(ecouteur);

    expect(retrait).not.toHaveBeenCalled();
    expect(fidelite.solde()).toBe(400);
  });

  it('commande annulée avant la validation du paiement : aucun retrait', async () => {
    const { ecouteur, fidelite } = monter({ statut: OrderStatus.CANCELLED, justPaid: false });
    const retrait = jest.spyOn(fidelite.service, 'redeemPoints');

    const resultat = await traiter(ecouteur);

    expect(resultat).toEqual(expect.objectContaining({ confirmed: true, earnedPoints: 0 }));
    expect(retrait).not.toHaveBeenCalled();
    expect(fidelite.solde()).toBe(400);
  });

  it('solde devenu insuffisant : tracé, la confirmation du paiement continue', async () => {
    const { ecouteur, d, fidelite } = monter({ solde: 120 });

    const resultat = await traiter(ecouteur);

    expect(resultat).toEqual(expect.objectContaining({ confirmed: true }));
    expect(d.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Échec du retrait de 150 points au paiement de la commande ORD-261002-1'),
      expect.anything(),
    );
    expect(d.referralService.accrueForPaidOrder).toHaveBeenCalledTimes(1);
    expect(fidelite.solde()).toBe(120);
    expect(d.alertes.signaler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: CodeAlerte.POINTS_NON_RETIRES,
        reference: 'ORD-261002-1',
        cleBridage: `${CodeAlerte.POINTS_NON_RETIRES}:ORD-261002-1`,
      }),
    );
  });

  it('retrait réussi : aucune alerte de points', async () => {
    const { ecouteur, d } = monter();

    await traiter(ecouteur);

    expect(d.alertes.signaler).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: CodeAlerte.POINTS_NON_RETIRES }),
    );
  });

  it('base momentanément injoignable : relancé pour que BullMQ retente', async () => {
    const { ecouteur, fidelite } = monter();
    jest
      .spyOn(fidelite.service, 'redeemPoints')
      .mockRejectedValueOnce(Object.assign(new Error('Neon endormi'), { code: 'P1001' }));

    await expect(traiter(ecouteur)).rejects.toThrow('Neon endormi');
  });
});
