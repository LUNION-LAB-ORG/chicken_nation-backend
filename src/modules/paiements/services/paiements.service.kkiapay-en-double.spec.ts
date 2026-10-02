/**
 * PAIEMENT REÇU DEUX FOIS (revue du 02/10).
 *
 * Le client paie de nouveau une commande déjà réglée (paiement rouvert au
 * rechargement de la page de suivi du site, deux onglets, webhook du premier
 * paiement en retard). Le second paiement était enregistré sans aucune
 * alerte : il n'était remboursé que sur réclamation.
 *
 * Le vrai `create` tourne ici (dédoublonnage par transaction compris) : c'est
 * lui qui dit si la transaction est nouvelle, donc si l'alerte doit partir.
 */

import { OrderStatus, OrderType, PaiementStatus, PaymentMethod } from '@prisma/client';
import { CodeAlerte } from 'src/modules/alertes/alertes.service';
import { PaiementsService } from './paiements.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PREMIER_LE = new Date('2026-10-02T10:00:00.000Z');
const SECOND_LE = new Date('2026-10-02T10:04:00.000Z');

type Ligne = { id: string; reference: string; amount: number; total: number; created_at: Date };

/** Premier paiement en ligne, commission KKiaPay comprise dans `total`. */
const premier: Ligne = { id: 'p1', reference: 'kk-1', amount: 10000, total: 10200, created_at: PREMIER_LE };
const second: Ligne = { id: 'p2', reference: 'kk-2', amount: 10000, total: 10200, created_at: SECOND_LE };

const commandeReglee = (surcharge: Record<string, unknown> = {}) => ({
  id: COMMANDE,
  reference: 'ORD-261002-1',
  restaurant_id: RESTAURANT_A,
  customer_id: CLIENT,
  amount: 10000,
  paied: true,
  status: OrderStatus.ACCEPTED,
  type: OrderType.DELIVERY,
  payment_method: PaymentMethod.ONLINE,
  created_at: PREMIER_LE,
  submitted_at: null,
  ...surcharge,
});

/**
 * @param transaction la transaction que KKiaPay confirme
 * @param enBase      paiements SUCCESS de la commande, lus APRÈS l'enregistrement
 * @param existant    ligne déjà enregistrée pour cette transaction (rejeu), sinon null
 */
function monter({
  transaction = second,
  statut = PaiementStatus.SUCCESS as PaiementStatus,
  enBase = [premier, second],
  existant = null as Ligne | null,
  commande = commandeReglee(),
  compteClaim = 0,
}: {
  transaction?: Ligne;
  statut?: PaiementStatus;
  enBase?: Ligne[];
  existant?: Ligne | null;
  commande?: ReturnType<typeof commandeReglee>;
  compteClaim?: number;
} = {}) {
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(commande),
      // Claim PENDING, passage à payée, panier annulé rétabli : rien par défaut.
      updateMany: jest.fn().mockResolvedValueOnce({ count: compteClaim }).mockResolvedValue({ count: 0 }),
    },
    paiement: {
      findFirst: jest.fn().mockResolvedValue(existant),
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: transaction.id, ...data, created_at: transaction.created_at }),
      ),
      findMany: jest.fn().mockResolvedValue(enBase),
    },
  };
  const kkiapay = {
    verifyTransactionForRestaurant: jest.fn().mockResolvedValue({
      transaction: {
        transactionId: transaction.reference,
        amount: transaction.amount,
        fees: transaction.total - transaction.amount,
        source: 'MOBILE_MONEY',
        source_common_name: 'Orange Money',
        client: 'x',
        status: statut,
      },
      collectedBy: RESTAURANT_A,
    }),
  };
  const alertes = { signaler: jest.fn() };
  const service = new PaiementsService(
    prisma as never,
    kkiapay as never,
    { paiementEffectue: jest.fn() } as never,
    { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    { emit: jest.fn() } as never,
    alertes as never,
  );
  return { service, prisma, alertes };
}

const lier = (service: PaiementsService, transaction: Ligne = second) =>
  service.linkPaiementToOrder({ transactionId: transaction.reference, orderId: COMMANDE, customer_id: CLIENT } as never);

describe('PaiementsService.linkPaiementToOrder : paiement reçu deux fois', () => {
  it("second paiement d'une commande en ligne déjà réglée : alerte « à rembourser », une par transaction", async () => {
    const { service, prisma, alertes } = monter();

    const resultat = await lier(service);

    expect(resultat).toEqual(
      expect.objectContaining({ isPaid: true, justPaid: false, payeApresCoup: false, enDouble: true }),
    );
    expect(prisma.paiement.create).toHaveBeenCalledTimes(1);
    expect(alertes.signaler).toHaveBeenCalledTimes(1);
    const alerte = alertes.signaler.mock.calls[0][0];
    expect(alerte).toEqual(
      expect.objectContaining({
        code: CodeAlerte.PAIEMENT_EN_DOUBLE,
        reference: 'ORD-261002-1',
        restaurantId: RESTAURANT_A,
        // Par transaction : un troisième paiement aurait sa propre alerte.
        cleBridage: `${CodeAlerte.PAIEMENT_EN_DOUBLE}:kk-2`,
      }),
    );
    expect(alerte.meta).toEqual(
      expect.objectContaining({ orderId: COMMANDE, paiementId: 'p2', transactionId: 'kk-2', montant: 10000, dejaEncaisse: 10000 }),
    );
    expect(alerte.details.join('\n')).toContain('kk-2');
    for (const ligne of alerte.details) expect(ligne).not.toMatch(/[–—]/);
  });

  it("l'alerte part avant toute écriture sur la commande : un échec plus loin ne la perd pas", async () => {
    const { service, prisma, alertes } = monter();

    await lier(service);

    expect(alertes.signaler.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.order.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('rejeu de la même transaction (nouvelle tentative du webhook) : silencieux', async () => {
    const { service, prisma, alertes } = monter({ existant: second });

    const resultat = await lier(service);

    expect(prisma.paiement.create).not.toHaveBeenCalled();
    // Toujours en double (l'appelant n'ajoute pas d'alerte de reprise), mais rien ne repart.
    expect(resultat.enDouble).toBe(true);
    expect(alertes.signaler).not.toHaveBeenCalled();
  });

  it("rejeu du PREMIER paiement une fois le second enregistré : jamais signalé, il ne faut rembourser que le second", async () => {
    const { service, alertes } = monter({ transaction: premier, existant: premier });

    const resultat = await lier(service, premier);

    expect(resultat.enDouble).toBe(false);
    expect(alertes.signaler).not.toHaveBeenCalled();
  });

  it("premier paiement d'une commande en attente : rien à signaler", async () => {
    const { service, alertes } = monter({
      transaction: premier,
      enBase: [premier],
      commande: commandeReglee({ paied: false, status: OrderStatus.PENDING }),
      compteClaim: 1,
    });

    const resultat = await lier(service, premier);

    expect(resultat).toEqual(expect.objectContaining({ justPaid: true, isPaid: true, enDouble: false }));
    expect(alertes.signaler).not.toHaveBeenCalled();
  });

  it("commande restée en attente malgré un premier paiement enregistré : le second la confirme ET est signalé", async () => {
    const { service, alertes } = monter({
      commande: commandeReglee({ paied: false, status: OrderStatus.PENDING }),
      compteClaim: 1,
    });

    const resultat = await lier(service);

    expect(resultat).toEqual(expect.objectContaining({ justPaid: true, enDouble: true }));
    expect(alertes.signaler).toHaveBeenCalledTimes(1);
  });

  it('commande payable à la caisse déjà encaissée au comptoir, puis payée en ligne : signalé aussi', async () => {
    const especes: Ligne = { id: 'c1', reference: 'PAY-1', amount: 10000, total: 10000, created_at: PREMIER_LE };
    const { service, alertes } = monter({
      enBase: [especes, second],
      commande: commandeReglee({ payment_method: PaymentMethod.OFFLINE, status: OrderStatus.READY }),
    });

    const resultat = await lier(service);

    expect(resultat.enDouble).toBe(true);
    expect(alertes.signaler).toHaveBeenCalledTimes(1);
    expect(alertes.signaler.mock.calls[0][0].code).toBe(CodeAlerte.PAIEMENT_EN_DOUBLE);
  });

  it("paiement qui complète un encaissement partiel : pas en double", async () => {
    const acompte: Ligne = { id: 'c1', reference: 'PAY-1', amount: 4000, total: 4000, created_at: PREMIER_LE };
    const { service, alertes } = monter({
      enBase: [acompte, second],
      commande: commandeReglee({ paied: false, payment_method: PaymentMethod.OFFLINE, status: OrderStatus.READY }),
    });

    const resultat = await lier(service);

    expect(resultat.enDouble).toBe(false);
    expect(alertes.signaler).not.toHaveBeenCalled();
  });

  it("même transaction enregistrée deux fois (webhook et application au même instant) : ce n'est pas un double", async () => {
    const memeTransaction: Ligne = { ...second, id: 'p2-bis', created_at: PREMIER_LE };
    const { service, alertes } = monter({ enBase: [memeTransaction, second] });

    const resultat = await lier(service);

    expect(resultat.enDouble).toBe(false);
    expect(alertes.signaler).not.toHaveBeenCalled();
  });

  it('paiement échoué : rien à contrôler', async () => {
    const { service, prisma, alertes } = monter({ statut: PaiementStatus.FAILED });

    const resultat = await lier(service);

    expect(resultat).toEqual(expect.objectContaining({ isPaid: false, enDouble: false }));
    expect(prisma.paiement.findMany).not.toHaveBeenCalled();
    expect(alertes.signaler).not.toHaveBeenCalled();
  });
});

describe('PaiementsService.payWithKkiapay : paiement reçu deux fois', () => {
  const req = { user: { id: CLIENT } } as never;
  const payer = (service: PaiementsService) =>
    service.payWithKkiapay(req, { transactionId: 'kk-2', orderId: COMMANDE } as never);

  it("confirmation de l'application d'un second paiement : signalé, réponse inchangée", async () => {
    const { service, alertes } = monter();

    const reponse = await payer(service);

    expect(reponse).toEqual(expect.objectContaining({ success: true, transactionId: 'kk-2' }));
    expect(reponse).not.toHaveProperty('enDouble');
    expect(alertes.signaler).toHaveBeenCalledTimes(1);
    expect(alertes.signaler.mock.calls[0][0].cleBridage).toBe(`${CodeAlerte.PAIEMENT_EN_DOUBLE}:kk-2`);
  });

  it('transaction déjà enregistrée par le webhook : silencieux', async () => {
    const { service, alertes } = monter({ existant: second });

    await payer(service);

    expect(alertes.signaler).not.toHaveBeenCalled();
  });
});
