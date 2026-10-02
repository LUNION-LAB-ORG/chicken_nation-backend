/**
 * Paiement KKiaPay reçu sur une commande déjà réglée (revue du 02/10).
 *
 * L'alerte « Paiement reçu deux fois, à rembourser » part à l'enregistrement
 * du paiement (`PaiementsService`, voir `paiements.service.kkiapay-en-double.spec.ts`).
 * L'écouteur, lui, ne la double pas de l'alerte de reprise des commandes
 * payables à la caisse, et garde cette alerte de reprise pour son propre cas.
 */

import { OrderStatus, PaymentMethod } from '@prisma/client';
import { CodeAlerte } from 'src/modules/alertes/alertes.service';
import { KkiapayOrderListenerService } from './kkiapay-order.listener.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function monter(
  { methode, enDouble, justPaid = false }: { methode: PaymentMethod; enDouble: boolean; justPaid?: boolean },
) {
  const commande = {
    id: COMMANDE,
    reference: 'ORD-261002-1',
    customer_id: CLIENT,
    restaurant_id: RESTAURANT_A,
    payment_method: methode,
    status: OrderStatus.ACCEPTED,
    paied: true,
    net_amount: 0,
    order_items: [],
    customer: { loyalty_level: null, notification_settings: null },
  };
  const d = {
    orderService: {
      findByReferenceOrNull: jest.fn().mockResolvedValue(commande),
      findById: jest.fn().mockResolvedValue(commande),
    },
    paiementsService: {
      linkPaiementToOrder: jest.fn().mockResolvedValue({
        paiement: { id: 'p2' },
        justPaid,
        isPaid: true,
        payeApresCoup: false,
        annuleeRetablie: false,
        enDouble,
      }),
    },
    orderEvent: { orderCreatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderUpdated: jest.fn(), emitOrderCreated: jest.fn() },
    expoPushService: { sendPushNotifications: jest.fn() },
    notificationsSender: { sendOrderBell: jest.fn() },
    loyaltyService: { calculatePointsForOrder: jest.fn().mockResolvedValue(0), addPoints: jest.fn() },
    scratchEngineService: { drawForOrder: jest.fn() },
    referralService: { accrueForPaidOrder: jest.fn() },
    alertes: { signaler: jest.fn() },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  };
  const ecouteur = Object.create(KkiapayOrderListenerService.prototype) as KkiapayOrderListenerService;
  Object.assign(ecouteur, d);
  return { ecouteur, d };
}

const traiter = (ecouteur: KkiapayOrderListenerService) =>
  ecouteur.processTransactionSuccess({ stateData: 'ORD-261002-1', transactionId: 'kk-2' } as never);

describe('KkiapayOrderListenerService : paiement reçu deux fois', () => {
  it("commande en ligne déjà réglée : confirmé, signalé dans le résultat, sans autre alerte ni effet unique", async () => {
    const { ecouteur, d } = monter({ methode: PaymentMethod.ONLINE, enDouble: true });

    const resultat = await traiter(ecouteur);

    expect(resultat).toEqual(expect.objectContaining({ confirmed: true, justPaid: false, enDouble: true }));
    // L'alerte « à rembourser » est partie à l'enregistrement du paiement : rien ici.
    expect(d.alertes.signaler).not.toHaveBeenCalled();
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining('kk-2'));
    expect(d.notificationsSender.sendOrderBell).not.toHaveBeenCalled();
    expect(d.expoPushService.sendPushNotifications).not.toHaveBeenCalled();
  });

  it("commande payable à la caisse déjà réglée : pas d'alerte de reprise par-dessus", async () => {
    const { ecouteur, d } = monter({ methode: PaymentMethod.OFFLINE, enDouble: true });

    const resultat = await traiter(ecouteur);

    expect(resultat.enDouble).toBe(true);
    expect(d.alertes.signaler).not.toHaveBeenCalled();
  });

  it('commande payable à la caisse payée en ligne sans être déjà réglée : alerte de reprise inchangée', async () => {
    const { ecouteur, d } = monter({ methode: PaymentMethod.OFFLINE, enDouble: false });

    const resultat = await traiter(ecouteur);

    expect(resultat).toEqual(expect.objectContaining({ confirmed: true, enDouble: false }));
    expect(d.alertes.signaler).toHaveBeenCalledTimes(1);
    expect(d.alertes.signaler.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        code: CodeAlerte.PAIEMENT_APRES_REPRISE,
        cleBridage: `${CodeAlerte.PAIEMENT_APRES_REPRISE}:ORD-261002-1`,
      }),
    );
  });

  it('premier paiement en ligne : ni alerte ni trace de double', async () => {
    const { ecouteur, d } = monter({ methode: PaymentMethod.ONLINE, enDouble: false, justPaid: true });

    const resultat = await traiter(ecouteur);

    expect(resultat).toEqual(expect.objectContaining({ confirmed: true, justPaid: true, enDouble: false }));
    expect(d.alertes.signaler).not.toHaveBeenCalled();
    expect(d.notificationsSender.sendOrderBell).toHaveBeenCalledTimes(1);
  });
});
