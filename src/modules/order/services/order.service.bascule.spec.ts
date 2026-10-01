/**
 * Reprise d'une commande de l'application par le personnel (bascule « auto »
 * vers « manuel ») : le paiement passe à la caisse tant qu'il reste à payer.
 *
 * Avant ce correctif, la commande reprise restait en paiement en ligne : la
 * caisse n'ouvrait jamais son formulaire d'encaissement, et les caissières ne
 * pouvaient plus enregistrer le paiement. Si l'un de ces tests casse, relisez
 * ce signalement avant de l'adapter.
 *
 * Comme `order.service.encaissement.spec.ts`, on teste la méthode en
 * isolation : seules les dépendances qu'elle lit sont greffées.
 *
 * Le `updateMany` simulé ÉVALUE le `where` reçu contre la commande en base :
 * c'est lui qui décide, comme la vraie base. Retirer une condition du `where`
 * fait donc casser le test de la règle qu'elle porte.
 */

import {
  OrderStatus,
  OrderType,
  PaiementStatus,
  PaymentMethod,
  User,
  UserRole,
  UserType,
} from '@prisma/client';
import { OrderService } from './order.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const agent = { id: 'u1', type: UserType.BACKOFFICE, role: UserRole.CALL_CENTER, restaurant_id: null } as unknown as User;

type Paiement = { status: PaiementStatus; amount: number; total: number };
type Commande = Record<string, unknown> & { paiements: Paiement[] };

const paiement = (status: PaiementStatus, montant: number): Paiement => ({
  status,
  amount: montant,
  total: montant,
});

/** Commande de l'application encore en attente, taxe comprise dans le total. */
const commandeAppli = (surcharge: Record<string, unknown> = {}): Commande => ({
  id: COMMANDE,
  type: OrderType.PICKUP,
  status: OrderStatus.PENDING,
  restaurant_id: RESTAURANT_A,
  customer_id: CLIENT,
  auto: true,
  payment_method: PaymentMethod.ONLINE,
  paied: false,
  hubrise_order_id: null,
  net_amount: 10000,
  discount: 0,
  tax: 500,
  amount: 10500,
  delivery_fee: 0,
  order_items: [],
  paiements: [],
  ...surcharge,
});

/** Le sous-ensemble de `where` Prisma que le service emploie, évalué en mémoire. */
function correspond(ligne: Commande, where: Record<string, any>): boolean {
  for (const [champ, attendu] of Object.entries(where)) {
    if (champ === 'paiements') {
      const filtre = attendu.none.status;
      const statuts: PaiementStatus[] = typeof filtre === 'string' ? [filtre] : filtre.in;
      if (ligne.paiements.some((p) => statuts.includes(p.status))) return false;
    } else if (attendu && typeof attendu === 'object' && 'not' in attendu) {
      if (ligne[champ] === attendu.not) return false;
    } else if (attendu === null) {
      if (ligne[champ] != null) return false;
    } else if (ligne[champ] !== attendu) {
      return false;
    }
  }
  return true;
}

function monter(commande: Commande, apresRecalcul: Record<string, unknown> = {}) {
  /** Ce que la base contient, mis à jour par chaque écriture simulée. */
  let enBase: Commande = { ...commande };
  const prisma = {
    restaurant: { findUnique: jest.fn().mockResolvedValue({ name: 'Riviera' }) },
    order: {
      // Relecture de la commande reprise, pour l'événement de statut.
      findUnique: jest.fn(async (_args: { where: { id: string }; include: Record<string, any> }) => ({
        ...enBase,
        restaurant: { name: 'Riviera' },
      })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        enBase = { ...enBase, ...args.data };
        return enBase;
      }),
      updateMany: jest.fn(async (args: { where: Record<string, any>; data: Record<string, unknown> }) => {
        if (!correspond(enBase, args.where)) return { count: 0 };
        enBase = { ...enBase, ...args.data };
        return { count: 1 };
      }),
    },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  const greffes = {
    prisma,
    findById: jest.fn().mockResolvedValue(commande),
    // Le recalcul de `paied` a ses propres règles : on fixe son résultat.
    recomputeOrderPaiedFlag: jest.fn(async () => {
      enBase = { ...enBase, ...apresRecalcul };
      return enBase;
    }),
    orderHelper: { calculateEstimatedTime: jest.fn().mockReturnValue(null) },
    orderEvent: { orderUpdatedEvent: jest.fn(), orderStatusUpdatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderUpdated: jest.fn(), emitStatusUpdate: jest.fn() },
    // Reprise d'un panier : relance des agents, usage du code promo.
    orderRelance: { noterReprise: jest.fn().mockResolvedValue(undefined) },
    promoCodeService: { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  };
  Object.assign(service, greffes);
  return { service, ...greffes, base: () => enBase };
}

const basculer = (service: OrderService, corps: Record<string, unknown> = {}) =>
  service.update(COMMANDE, { auto: false, ...corps } as never, { userId: 'u1', user: agent });

describe('OrderService.update : reprise par le personnel', () => {
  it('passe une commande non payée en paiement à la caisse, acceptée, sans taxe', async () => {
    const { service, prisma, orderWebSocketService, base } = monter(commandeAppli());

    const commande = await basculer(service);

    const ecriture = prisma.order.update.mock.calls[0][0].data;
    expect(ecriture).toEqual(
      expect.objectContaining({ auto: false, tax: 0, amount: 10000, status: OrderStatus.ACCEPTED }),
    );
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: COMMANDE,
        auto: false,
        payment_method: PaymentMethod.ONLINE,
        paied: false,
        hubrise_order_id: null,
        status: { not: OrderStatus.CANCELLED },
        paiements: { none: { status: PaiementStatus.PENDING } },
      },
      data: { payment_method: PaymentMethod.OFFLINE },
    });
    expect(base().payment_method).toBe(PaymentMethod.OFFLINE);
    expect(commande.payment_method).toBe(PaymentMethod.OFFLINE);
    // Les écrans ouverts reçoivent la commande déjà encaissable en caisse.
    expect(orderWebSocketService.emitOrderUpdated.mock.calls[0][0].payment_method).toBe(PaymentMethod.OFFLINE);
  });

  it("laisse en ligne une commande déjà payée dans l'application, taxe et total compris", async () => {
    const { service, prisma, base } = monter(
      commandeAppli({
        status: OrderStatus.ACCEPTED,
        paied: true,
        paiements: [paiement(PaiementStatus.SUCCESS, 10500)],
      }),
    );

    const commande = await basculer(service);

    const ecriture = prisma.order.update.mock.calls[0][0].data;
    // Le client a réglé la taxe : la retirer laisserait un trop-perçu inexpliqué.
    expect(ecriture).not.toHaveProperty('tax');
    expect(ecriture).not.toHaveProperty('amount');
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(base().payment_method).toBe(PaymentMethod.ONLINE);
    expect(commande.payment_method).toBe(PaymentMethod.ONLINE);
  });

  it('passe à la caisse une commande payée en partie en ligne : la caisse encaisse le reste', async () => {
    const { service, base } = monter(
      commandeAppli({ paiements: [paiement(PaiementStatus.SUCCESS, 3000)] }),
    );

    const commande = await basculer(service);

    expect(base().payment_method).toBe(PaymentMethod.OFFLINE);
    expect(commande.payment_method).toBe(PaymentMethod.OFFLINE);
  });

  it("laisse en ligne une commande dont l'encaissement du livreur attend sa confirmation", async () => {
    const { service, prisma, base } = monter(
      commandeAppli({
        status: OrderStatus.ACCEPTED,
        paiements: [paiement(PaiementStatus.PENDING, 10500)],
      }),
    );

    const commande = await basculer(service);

    // La base, et non le service, écarte la commande : la règle est dans le `where`.
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(base().payment_method).toBe(PaymentMethod.ONLINE);
    expect(commande.payment_method).toBe(PaymentMethod.ONLINE);
  });

  it('laisse en ligne une commande que le recalcul du total rend payée', async () => {
    // 10 000 F déjà reçus sur un total de 10 500 F : la taxe tombée, le total
    // retombe à 10 000 F et la commande est soldée.
    const { service, prisma, base } = monter(
      commandeAppli({ paiements: [paiement(PaiementStatus.SUCCESS, 10000)] }),
      { paied: true },
    );

    await basculer(service);

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(base().payment_method).toBe(PaymentMethod.ONLINE);
  });

  it("garde taxe et total d'une commande à livrer déjà prête, mais passe son paiement à la caisse", async () => {
    const { service, prisma, base } = monter(
      commandeAppli({ type: OrderType.DELIVERY, status: OrderStatus.READY }),
    );

    await basculer(service);

    const ecriture = prisma.order.update.mock.calls[0][0].data;
    // La course est partie avec ce montant à encaisser : il ne doit plus bouger.
    expect(ecriture).not.toHaveProperty('tax');
    expect(ecriture).not.toHaveProperty('amount');
    expect(ecriture).not.toHaveProperty('status');
    expect(base().payment_method).toBe(PaymentMethod.OFFLINE);
  });

  it('ne se laisse pas défaire par un payment_method ONLINE venu du corps', async () => {
    const { service, prisma, base } = monter(commandeAppli());

    const commande = await basculer(service, { payment_method: PaymentMethod.ONLINE });

    // Le corps est bien écrit d'abord, puis le passage à la caisse l'emporte.
    expect(prisma.order.update.mock.calls[0][0].data.payment_method).toBe(PaymentMethod.ONLINE);
    expect(prisma.order.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.order.update.mock.invocationCallOrder[0],
    );
    expect(base().payment_method).toBe(PaymentMethod.OFFLINE);
    expect(commande.payment_method).toBe(PaymentMethod.OFFLINE);
  });

  it("ne touche pas au paiement quand la commande reste à l'application", async () => {
    const { service, prisma } = monter(commandeAppli({ status: OrderStatus.ACCEPTED }));

    const commande = await service.update(COMMANDE, { note: 'Sans oignons' } as never, { userId: 'u1', user: agent });

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update.mock.calls[0][0].data).not.toHaveProperty('payment_method');
    expect(prisma.order.update.mock.calls[0][0].data).not.toHaveProperty('tax');
    expect(commande.payment_method).toBe(PaymentMethod.ONLINE);
  });

  it('ne refait rien sur une commande déjà manuelle et déjà payable à la caisse', async () => {
    const { service, prisma } = monter(
      commandeAppli({ auto: false, status: OrderStatus.ACCEPTED, payment_method: PaymentMethod.OFFLINE }),
    );

    await basculer(service);

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update.mock.calls[0][0].data).not.toHaveProperty('tax');
  });

  it('répare au réenregistrement une reprise restée en ligne (seconde écriture interrompue)', async () => {
    // État laissé par une coupure de la base : bascule enregistrée, paiement
    // resté en ligne. Rouvrir la commande et l'enregistrer suffit.
    const { service, prisma, base } = monter(
      commandeAppli({ auto: false, status: OrderStatus.ACCEPTED, tax: 0, amount: 10000 }),
    );

    await service.update(COMMANDE, { note: 'Sans oignons' } as never, { userId: 'u1', user: agent });

    expect(prisma.order.update.mock.calls[0][0].data).not.toHaveProperty('tax');
    expect(base().payment_method).toBe(PaymentMethod.OFFLINE);
  });

  it('ne passe jamais à la caisse une commande venue de HubRise', async () => {
    const { service, prisma, base } = monter(
      commandeAppli({ auto: false, status: OrderStatus.ACCEPTED, hubrise_order_id: 'hr-1' }),
    );

    await service.update(COMMANDE, { note: 'Sans oignons' } as never, { userId: 'u1', user: agent });

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(base().payment_method).toBe(PaymentMethod.ONLINE);
  });

  it("ne remet pas en paiement en ligne une commande rattachée à l'application", async () => {
    const { service, prisma } = monter(
      commandeAppli({ auto: false, status: OrderStatus.ACCEPTED, payment_method: PaymentMethod.OFFLINE }),
    );

    const commande = await service.update(COMMANDE, { auto: true } as never, { userId: 'u1', user: agent });

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update.mock.calls[0][0].data).not.toHaveProperty('payment_method');
    expect(commande.payment_method).toBe(PaymentMethod.OFFLINE);
  });
});

/**
 * Reprise au téléphone d'un panier de l'application non payé (relance des
 * commandes en attente) : les agents de relance et le restaurant sont
 * prévenus. La confirmation passe par `orderStatusUpdatedEvent`, comme une
 * acceptation ordinaire : son écouteur déduit les points du panier
 * (idempotent), sonne la cloche et, pour un ancien brouillon, envoie la
 * notification « Nouvelle commande ». Une seule cloche, donc : celle de
 * l'écouteur.
 */
describe('OrderService.update : reprise au téléphone, qui est prévenu', () => {
  /** Laisse partir les promesses lancées sans attente (relecture, journal). */
  const attendre = () => new Promise((r) => setImmediate(r));

  it('prévient la relance, puis le restaurant : changement de statut et événement de statut, une seule fois', async () => {
    const monte = monter(commandeAppli({ points: 500, code_promo: null }));

    await basculer(monte.service);
    await attendre();

    expect(monte.orderRelance.noterReprise).toHaveBeenCalledWith(COMMANDE, 'u1');
    expect(monte.orderWebSocketService.emitStatusUpdate).toHaveBeenCalledTimes(1);
    const [commande, precedent] = monte.orderWebSocketService.emitStatusUpdate.mock.calls[0];
    expect(commande.status).toBe(OrderStatus.ACCEPTED);
    expect(commande.auto).toBe(false);
    expect(precedent).toBe(OrderStatus.PENDING);

    // L'écouteur fait la déduction des points et la cloche : un seul envoi.
    expect(monte.orderEvent.orderStatusUpdatedEvent).toHaveBeenCalledTimes(1);
    const charge = monte.orderEvent.orderStatusUpdatedEvent.mock.calls[0][0];
    expect(charge.order).toEqual(
      expect.objectContaining({ id: COMMANDE, status: OrderStatus.ACCEPTED, points: 500, restaurant: { name: 'Riviera' } }),
    );
    expect(charge.etait_brouillon).toBe(true);
    expect(charge.expo_token).toBeNull();

    // Relue avec les listes blanches : jamais la fiche complète du client.
    const relecture = monte.prisma.order.findUnique.mock.calls[0][0];
    expect(relecture.include.customer).toEqual({ select: expect.any(Object) });
    expect(relecture.include.restaurant).toEqual({ select: expect.any(Object) });

    // Usage du code promo comptabilisé, comme une acceptation ordinaire.
    expect(monte.promoCodeService.activateUsageForOrder).toHaveBeenCalledTimes(1);
    expect(monte.promoCodeService.activateUsageForOrder.mock.calls[0][0]).toEqual(
      expect.objectContaining({ id: COMMANDE }),
    );
  });

  it("ne prévient pas la relance pour une commande de l'application déjà payée", async () => {
    const monte = monter(
      commandeAppli({
        status: OrderStatus.ACCEPTED,
        paied: true,
        paiements: [paiement(PaiementStatus.SUCCESS, 10500)],
      }),
    );

    await basculer(monte.service);
    await attendre();

    expect(monte.orderRelance.noterReprise).not.toHaveBeenCalled();
    // Déjà acceptée : le restaurant la connaît, aucun nouvel avis.
    expect(monte.orderWebSocketService.emitStatusUpdate).not.toHaveBeenCalled();
    expect(monte.orderEvent.orderStatusUpdatedEvent).not.toHaveBeenCalled();
    expect(monte.promoCodeService.activateUsageForOrder).not.toHaveBeenCalled();
  });

  it("confirme une commande de l'application payable au restaurant sans la présenter comme nouvelle", async () => {
    const monte = monter(commandeAppli({ payment_method: PaymentMethod.OFFLINE }));

    await basculer(monte.service);
    await attendre();

    // Pas un brouillon : le restaurant la voyait déjà, aucune relance à noter.
    expect(monte.orderRelance.noterReprise).not.toHaveBeenCalled();
    expect(monte.orderEvent.orderStatusUpdatedEvent).toHaveBeenCalledTimes(1);
    expect(monte.orderEvent.orderStatusUpdatedEvent.mock.calls[0][0].etait_brouillon).toBe(false);
  });

  it('ne refait rien sur une commande déjà manuelle', async () => {
    const monte = monter(commandeAppli({ auto: false, status: OrderStatus.ACCEPTED }));

    await basculer(monte.service);
    await attendre();

    expect(monte.orderRelance.noterReprise).not.toHaveBeenCalled();
    expect(monte.orderWebSocketService.emitStatusUpdate).not.toHaveBeenCalled();
    expect(monte.orderEvent.orderStatusUpdatedEvent).not.toHaveBeenCalled();
  });

  it('une relecture en échec ne fait pas échouer la reprise', async () => {
    const monte = monter(commandeAppli());
    monte.prisma.order.findUnique.mockRejectedValue(new Error('base injoignable'));

    await expect(basculer(monte.service)).resolves.toEqual(expect.objectContaining({ auto: false }));
    await attendre();

    expect(monte.logger.warn).toHaveBeenCalled();
    expect(monte.orderEvent.orderStatusUpdatedEvent).not.toHaveBeenCalled();
  });

  it("un code promo en échec n'empêche pas l'avis au restaurant", async () => {
    const monte = monter(commandeAppli());
    monte.promoCodeService.activateUsageForOrder.mockRejectedValue(new Error('base injoignable'));

    await basculer(monte.service);
    await attendre();

    expect(monte.logger.error).toHaveBeenCalled();
    expect(monte.orderEvent.orderStatusUpdatedEvent).toHaveBeenCalledTimes(1);
  });
});
