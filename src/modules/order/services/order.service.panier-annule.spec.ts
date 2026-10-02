/**
 * PANIER ANNULÉ PAR LE CLIENT (demande du 01/10).
 *
 * Le client passe une commande dans l'application, ne paie pas et l'annule :
 * elle passe CANCELLED et DELETED (hors des listes), reste relançable, et le
 * centre d'appels qui le joint la RÉACTIVE en la reprenant au téléphone :
 * active, acceptée, paiement à la caisse, coupon consommé de nouveau.
 *
 * Comme `order.service.bascule.spec.ts`, les méthodes sont testées en
 * isolation. Le coupon passe par le VRAI OrderCouponService sur la base en
 * mémoire des réductions (écritures conditionnées évaluées, verrous de ligne),
 * à laquelle on ajoute la table des commandes : c'est la base qui décide.
 */

import { ConflictException } from '@nestjs/common';
import {
  EntityStatus,
  OrderStatus,
  OrderType,
  PaiementStatus,
  PaymentMethod,
  Prisma,
  PromoCodeUsageStatus,
  User,
  UserRole,
  UserType,
  VoucherStatus,
} from '@prisma/client';
import { ANNULEE_PAR_CLIENT } from '../helpers/brouillons.rules';
import {
  ArticleRenvoye,
  cadeauxDesLignes,
  cadeauxRefactures,
  memesArticles,
} from '../helpers/cadeaux-reactivation.helper';
import { KkiapayOrderListenerService } from '../listeners/kkiapay-order.listener.service';
import { OrderListenerService } from '../listeners/order.listener.service';
import { correspond } from '../relance/relance.base-simulee-spec';
import { CLIENT, RESTAURANT_A, bon, codePromo, monterCoupons } from './order-coupon.base-simulee-spec';
import { OrderService } from './order.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const ANNULEE_LE = new Date('2026-10-01T11:58:00.000Z');

const compte = (role: UserRole): User =>
  ({
    id: 'u1',
    fullname: 'Agent Awa',
    email: 'awa@chicken-nation.com',
    role,
    type: UserType.BACKOFFICE,
    restaurant_id: null,
  }) as unknown as User;

const CALL_CENTER = compte(UserRole.CALL_CENTER);
const ADMIN = compte(UserRole.ADMIN);

type Commande = Record<string, any>;

/** Panier de l'application, en attente, non payé, taxe comprise dans le total. */
const panier = (surcharge: Commande = {}): Commande => ({
  id: COMMANDE,
  reference: 'ORD-261001-1',
  type: OrderType.PICKUP,
  status: OrderStatus.PENDING,
  restaurant_id: RESTAURANT_A,
  customer_id: CLIENT,
  auto: true,
  payment_method: PaymentMethod.ONLINE,
  paied: false,
  entity_status: EntityStatus.ACTIVE,
  hubrise_order_id: null,
  code_promo: null,
  net_amount: 10000,
  discount: 0,
  tax: 500,
  amount: 10500,
  delivery_fee: 0,
  points: 0,
  accepted_at: null,
  cancelled_at: null,
  cancelled_by: null,
  cancelled_reason: null,
  deleted_at: null,
  order_items: [],
  paiements: [],
  ...surcharge,
});

/** Le même panier, annulé par le client dans l'application (état écrit par S1). */
const panierAnnule = (surcharge: Commande = {}): Commande =>
  panier({
    status: OrderStatus.CANCELLED,
    entity_status: EntityStatus.DELETED,
    deleted_at: ANNULEE_LE,
    cancelled_at: ANNULEE_LE,
    cancelled_by: ANNULEE_PAR_CLIENT,
    cancelled_reason: 'Trop long',
    ...surcharge,
  });

/** Laisse partir les effets « fire-and-forget » (void ...). */
const attendre = () => new Promise((r) => setTimeout(r, 0));

/** Le message d'une promesse rejetée, avec sa classe. */
async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return { classe: (e as Error).constructor, message: (e as Error).message };
  }
  throw new Error('La promesse devait être rejetée');
}

const SANS_TIRET = /[\u2013\u2014]/;

// ===========================================================================
// S1 : annulation par le client
// ===========================================================================

/**
 * `enBase` : la ligne en base, que `changer` modifie ENTRE la lecture du
 * début et l'écriture (paiement ou reprise au téléphone arrivés entre-temps).
 * Les écritures conditionnées sont évaluées sur elle, comme en base.
 */
function monterStatut(commande: Commande, changer?: (enBase: Commande) => Commande) {
  let enBase: Commande = { ...commande };
  const accepte = (where: Commande) => {
    const { paiements, ...reste } = where;
    if (paiements && (enBase.paiements ?? []).some((p: Commande) => p.status === paiements.none.status)) return false;
    return correspond(enBase, reste);
  };
  const avantEcriture = () => {
    if (changer) {
      enBase = changer(enBase);
      changer = undefined;
    }
  };
  const prisma = {
    order: {
      updateMany: jest.fn(async ({ where, data }: { where: Commande; data: Commande }) => {
        avantEcriture();
        if (!accepte(where)) return { count: 0 };
        enBase = { ...enBase, ...data };
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => ({ ...enBase })),
      update: jest.fn(async ({ where, data }: { where: Commande; data: Commande }) => {
        avantEcriture();
        if (!accepte(where)) {
          throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
            code: 'P2025',
            clientVersion: 'test',
          });
        }
        enBase = { ...enBase, ...data };
        return { ...enBase };
      }),
    },
    notificationSetting: { findUnique: jest.fn().mockResolvedValue({ expo_push_token: 'ExponentPushToken[client]' }) },
  };
  const greffes = {
    prisma,
    findById: jest.fn().mockResolvedValue(commande),
    orderHelper: {
      validateStatusTransition: jest.fn(),
      assertPreparationAutorisee: jest.fn(),
      handleStatusSpecificActions: jest.fn().mockResolvedValue(undefined),
      calculateEstimatedTime: jest.fn().mockReturnValue(null),
    },
    promoCodeService: { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) },
    orderCoupon: { restituerPourCommande: jest.fn().mockResolvedValue({ bons: [], codesPromo: [] }) },
    orderEvent: { orderStatusUpdatedEvent: jest.fn() },
    orderWebSocketService: { emitStatusUpdate: jest.fn() },
    signalerAnomaliePaiement: jest.fn(),
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, greffes);
  return { service, ...greffes, base: () => enBase };
}

/** Le vrai écouteur des commandes, dépendances simulées. */
function monterEcouteur() {
  const d = {
    promotionService: { usePromotion: jest.fn() },
    loyaltyService: {
      redeemPoints: jest.fn().mockResolvedValue(undefined),
      revokeEarnedPointsForOrder: jest.fn().mockResolvedValue(undefined),
      rendrePointsUtilises: jest.fn().mockResolvedValue({ points_rendus: 0 }),
    },
    rewardService: {
      revokeForOrder: jest.fn().mockResolvedValue(undefined),
      restoreConsumedGiftsForOrder: jest.fn().mockResolvedValue(undefined),
    },
    scratchEngineService: { restoreStockForCancelledOrder: jest.fn().mockResolvedValue(undefined) },
    expoPushService: { sendPushNotifications: jest.fn() },
    userPushService: { notifyRestaurant: jest.fn().mockResolvedValue(undefined) },
    notificationsSender: { sendOrderBell: jest.fn().mockResolvedValue(undefined) },
    referralService: { revokeEarningsForCancelledOrder: jest.fn().mockResolvedValue(undefined) },
  };
  const ecouteur = new OrderListenerService(
    d.promotionService as never,
    d.loyaltyService as never,
    d.rewardService as never,
    d.scratchEngineService as never,
    d.expoPushService as never,
    d.userPushService as never,
    d.notificationsSender as never,
    d.referralService as never,
  );
  return { ecouteur, ...d };
}

describe('OrderService.updateStatus : le client annule son panier non payé', () => {
  it('passe CANCELLED et DELETED, annulée « par le client », coupon rendu comme aujourd’hui', async () => {
    const { service, prisma, orderCoupon, base } = monterStatut(panier());

    await service.updateStatus(COMMANDE, OrderStatus.CANCELLED, { reason: 'Trop long', userId: CLIENT }, { parLeClient: true });

    // Écriture conditionnée : encore un brouillon, aucun paiement réussi rattaché.
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        id: COMMANDE,
        auto: true,
        paiements: { none: { status: PaiementStatus.SUCCESS } },
      }),
    );
    const ecriture = prisma.order.updateMany.mock.calls[0][0].data;
    expect(ecriture).toEqual(
      expect.objectContaining({
        status: OrderStatus.CANCELLED,
        entity_status: EntityStatus.DELETED,
        cancelled_by: ANNULEE_PAR_CLIENT,
        cancelled_reason: 'Trop long',
      }),
    );
    expect(ecriture.deleted_at).toBeInstanceOf(Date);
    expect(ecriture.cancelled_at).toEqual(ecriture.deleted_at);
    expect(base().entity_status).toBe(EntityStatus.DELETED);
    // Restitution inchangée : le motif reste ANNULATION, l'auteur le client.
    expect(orderCoupon.restituerPourCommande).toHaveBeenCalledWith(
      expect.objectContaining({ id: COMMANDE }),
      { motif: 'ANNULATION', acteurId: CLIENT, acteurRole: null },
    );
  });

  it('UNE seule notification au client (« Commande annulée »), rien aux restaurants', async () => {
    const { service, orderEvent, orderWebSocketService } = monterStatut(panier());
    await service.updateStatus(COMMANDE, OrderStatus.CANCELLED, { userId: CLIENT }, { parLeClient: true });

    expect(orderEvent.orderStatusUpdatedEvent).toHaveBeenCalledTimes(1);
    const evenement = orderEvent.orderStatusUpdatedEvent.mock.calls[0][0];
    expect(evenement.etait_brouillon).toBe(true);
    expect(evenement.order.entity_status).toBe(EntityStatus.DELETED);
    expect(orderWebSocketService.emitStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ entity_status: EntityStatus.DELETED }),
      OrderStatus.PENDING,
    );

    // L'événement passé au VRAI écouteur : « Commande annulée », jamais « Commande supprimée ».
    const e = monterEcouteur();
    await e.ecouteur.orderStatusUpdatedEventListener(evenement);
    expect(e.expoPushService.sendPushNotifications).toHaveBeenCalledTimes(1);
    expect(e.expoPushService.sendPushNotifications.mock.calls[0][0]).toEqual(
      expect.objectContaining({ title: '😔 Commande annulée', categoryId: 'order-cancelled' }),
    );
    expect(e.notificationsSender.sendOrderBell).not.toHaveBeenCalled();
    expect(e.userPushService.notifyRestaurant).not.toHaveBeenCalled();
  });

  it('annulation par le PERSONNEL du même panier : inchangée (reste active, auteur = agent)', async () => {
    const { service, prisma } = monterStatut(panier());
    await service.updateStatus(COMMANDE, OrderStatus.CANCELLED, { userId: 'u1', role: UserRole.CALL_CENTER });

    const ecriture = prisma.order.update.mock.calls[0][0].data;
    expect(ecriture).not.toHaveProperty('entity_status');
    expect(ecriture).not.toHaveProperty('deleted_at');
    expect(ecriture.cancelled_by).toBe('u1');
  });

  it('« parLeClient » glissé dans meta (route du personnel, qui recopie le corps) : sans effet', async () => {
    const { service, prisma } = monterStatut(panier());
    await service.updateStatus(COMMANDE, OrderStatus.CANCELLED, {
      parLeClient: true,
      userId: 'u1',
      role: UserRole.ADMIN,
    });
    expect(prisma.order.update.mock.calls[0][0].data).not.toHaveProperty('entity_status');
  });

  it('le client annule une commande qui n’est pas un panier non payé : reste active, comme avant', async () => {
    for (const commande of [
      panier({ paied: true }),
      panier({ payment_method: PaymentMethod.OFFLINE, status: OrderStatus.ACCEPTED }),
      panier({ auto: false }),
    ]) {
      const { service, prisma } = monterStatut(commande);
      await service.updateStatus(COMMANDE, OrderStatus.CANCELLED, { userId: CLIENT }, { parLeClient: true });
      const ecriture = prisma.order.update.mock.calls[0][0].data;
      expect(ecriture).not.toHaveProperty('entity_status');
      expect(ecriture.cancelled_by).toBe(CLIENT);
    }
  });
});

describe('OrderService.updateStatus : annulation par le client, écriture conditionnée (revue du 01/10)', () => {
  it('remboursement en échec (paiement réussi encore rattaché) : annulation ordinaire, la commande reste visible', async () => {
    const avecPaiement = panier({ paiements: [{ status: PaiementStatus.SUCCESS, amount: 10500, total: 10500 }] });
    const { service, prisma, base } = monterStatut(avecPaiement);

    await service.updateStatus(COMMANDE, OrderStatus.CANCELLED, { userId: CLIENT }, { parLeClient: true });

    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    const ecriture = prisma.order.update.mock.calls[0][0].data;
    expect(ecriture).not.toHaveProperty('entity_status');
    expect(ecriture.cancelled_by).toBe(CLIENT);
    expect(base()).toEqual(
      expect.objectContaining({ status: OrderStatus.CANCELLED, entity_status: EntityStatus.ACTIVE, cancelled_by: CLIENT }),
    );
  });

  it('repris au téléphone entre la lecture et l’écriture : 409, la commande reprise est intacte', async () => {
    const { service, orderEvent, orderCoupon, base } = monterStatut(panier(), (b) => ({
      ...b,
      auto: false,
      status: OrderStatus.ACCEPTED,
      payment_method: PaymentMethod.OFFLINE,
    }));

    const erreur = await refus(
      service.updateStatus(COMMANDE, OrderStatus.CANCELLED, { userId: CLIENT }, { parLeClient: true }),
    );

    expect(erreur.classe).toBe(ConflictException);
    expect(erreur.message).toBe("Cette commande vient de changer : actualisez-la avant de l'annuler.");
    expect(erreur.message).not.toMatch(SANS_TIRET);
    expect(base()).toEqual(
      expect.objectContaining({ status: OrderStatus.ACCEPTED, auto: false, entity_status: EntityStatus.ACTIVE, cancelled_by: null }),
    );
    expect(orderEvent.orderStatusUpdatedEvent).not.toHaveBeenCalled();
    expect(orderCoupon.restituerPourCommande).not.toHaveBeenCalled();
  });

  it('payé dans l’application entre la lecture et l’écriture : annulation ordinaire, visible avec son paiement', async () => {
    const { service, base } = monterStatut(panier(), (b) => ({ ...b, paied: true }));

    await service.updateStatus(COMMANDE, OrderStatus.CANCELLED, { userId: CLIENT }, { parLeClient: true });

    expect(base()).toEqual(
      expect.objectContaining({
        status: OrderStatus.CANCELLED,
        paied: true,
        entity_status: EntityStatus.ACTIVE,
        cancelled_by: CLIENT,
      }),
    );
  });

  it('le personnel : écriture inchangée, sans condition sur le statut lu', async () => {
    const { service, prisma } = monterStatut(panier());
    await service.updateStatus(COMMANDE, OrderStatus.CANCELLED, { userId: 'u1', role: UserRole.CALL_CENTER });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update.mock.calls[0][0].where).toEqual({ id: COMMANDE });
  });
});

// ===========================================================================
// Paiement en ligne validé APRÈS l'annulation par le client (revue du 01/10)
// ===========================================================================

describe('Paiement KKiaPay arrivé après l’annulation par le client', () => {
  it('findByReferenceOrNull : le webhook retrouve le panier annulé par le client, payé ou non ; rien d’autre de supprimé', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = Object.create(OrderService.prototype) as OrderService;
    Object.assign(service, { prisma: { order: { findFirst } } });

    await service.findByReferenceOrNull('ORD-261001-1', { inclurePanierAnnuleParClient: true });
    const pourLeWebhook = findFirst.mock.calls[0][0].where;
    await service.findByReferenceOrNull('ORD-261001-1');
    const ordinaire = findFirst.mock.calls[1][0].where;

    const reference = 'ORD-261001-1';
    expect(correspond({ ...panierAnnule(), reference }, pourLeWebhook)).toBe(true);
    // Rejeu d'un webhook dont un premier passage a déjà posé `paied`.
    expect(correspond({ ...panierAnnule({ paied: true }), reference }, pourLeWebhook)).toBe(true);
    expect(correspond({ ...panier(), reference }, pourLeWebhook)).toBe(true);
    // Supprimée par le personnel, ou annulée par le personnel puis supprimée : non.
    expect(correspond({ ...panierAnnule({ cancelled_by: 'u1' }), reference }, pourLeWebhook)).toBe(false);
    expect(correspond({ ...panier({ entity_status: EntityStatus.DELETED }), reference }, pourLeWebhook)).toBe(false);
    // Sans l'option : inchangé, le panier supprimé reste introuvable.
    expect(correspond({ ...panierAnnule(), reference }, ordinaire)).toBe(false);
  });

  it('le paiement est rattaché, sans aucun effet de fidélité ; la réactivation est ensuite refusée', async () => {
    const commande = { ...panierAnnule(), customer: { loyalty_level: null, notification_settings: null } };
    const d = {
      orderService: {
        findByReferenceOrNull: jest.fn().mockResolvedValue(commande),
        findById: jest.fn().mockResolvedValue({ ...commande, paied: true, entity_status: EntityStatus.ACTIVE }),
      },
      paiementsService: {
        linkPaiementToOrder: jest.fn().mockResolvedValue({
          paiement: { id: 'p1' },
          justPaid: false,
          isPaid: true,
          payeApresCoup: true,
          annuleeRetablie: true,
        }),
      },
      orderEvent: { orderCreatedEvent: jest.fn() },
      orderWebSocketService: { emitOrderUpdated: jest.fn(), emitOrderCreated: jest.fn() },
      expoPushService: { sendPushNotifications: jest.fn() },
      notificationsSender: { sendOrderBell: jest.fn() },
      loyaltyService: { calculatePointsForOrder: jest.fn().mockResolvedValue(10), addPoints: jest.fn() },
      scratchEngineService: { drawForOrder: jest.fn() },
      referralService: { accrueForPaidOrder: jest.fn() },
      alertes: { signaler: jest.fn() },
      logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    };
    const ecouteur = Object.create(KkiapayOrderListenerService.prototype) as KkiapayOrderListenerService;
    Object.assign(ecouteur, d);

    const resultat = await ecouteur.processTransactionSuccess({
      stateData: 'ORD-261001-1',
      transactionId: 'kk-1',
    } as never);

    expect(d.orderService.findByReferenceOrNull).toHaveBeenCalledWith('ORD-261001-1', { inclurePanierAnnuleParClient: true });
    expect(d.paiementsService.linkPaiementToOrder).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'kk-1', orderId: COMMANDE }),
    );
    expect(resultat).toEqual(expect.objectContaining({ confirmed: true, justPaid: false, earnedPoints: 0 }));
    // Les écrans ouverts sont prévenus (la commande réapparaît).
    expect(d.orderWebSocketService.emitOrderUpdated).toHaveBeenCalledTimes(1);
    expect(d.loyaltyService.addPoints).not.toHaveBeenCalled();
    expect(d.scratchEngineService.drawForOrder).not.toHaveBeenCalled();
    expect(d.referralService.accrueForPaidOrder).not.toHaveBeenCalled();
    expect(d.notificationsSender.sendOrderBell).not.toHaveBeenCalled();
    expect(d.expoPushService.sendPushNotifications).not.toHaveBeenCalled();

    // Commande désormais payée (et active) : plus un panier annulé par le
    // client, la reprise au téléphone ne la réactive pas.
    const m = monterReprise(panierAnnule({ paied: true, entity_status: EntityStatus.ACTIVE, deleted_at: null }));
    const erreur = await refus(reprendre(m.service));
    expect(erreur).toEqual({
      classe: ConflictException,
      message: "L'origine d'une commande annulée ne peut pas être changée.",
    });
    expect(m.orderRelance.verifierReactivable).not.toHaveBeenCalled();
    expect(m.prisma.order.updateMany).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// S5 : réactivation par la reprise au téléphone
// ===========================================================================

function monterReprise(commande: Commande, donnees: Parameters<typeof monterCoupons>[0] = {}) {
  const coupons = monterCoupons(donnees);
  let enBase: Commande = { ...commande };
  const accepte = (where: Commande) => {
    const { paiements, ...reste } = where;
    if (paiements && enBase.paiements.some((p: Commande) => p.status === paiements.none.status)) return false;
    return correspond(enBase, reste);
  };
  coupons.prisma.order = {
    updateMany: jest.fn(async ({ where, data }: { where: Commande; data: Commande }) => {
      if (!accepte(where)) return { count: 0 };
      enBase = { ...enBase, ...data };
      return { count: 1 };
    }),
    update: jest.fn(async ({ data }: { data: Commande }) => {
      enBase = { ...enBase, ...data };
      return { ...enBase };
    }),
    findUnique: jest.fn(async () => ({ ...enBase })),
  };
  const greffes = {
    prisma: coupons.prisma,
    findById: jest.fn().mockResolvedValue(commande),
    orderCoupon: coupons.service,
    orderRelance: {
      verifierReactivable: jest.fn().mockResolvedValue(undefined),
      noterReprise: jest.fn().mockResolvedValue(undefined),
      journaliserReactivation: jest.fn(),
    },
    // Le recalcul de `paied` a ses propres règles : aucun paiement, il reste faux.
    recomputeOrderPaiedFlag: jest.fn(async () => ({ ...enBase })),
    promoCodeService: coupons.promoCodeService,
    orderHelper: { calculateEstimatedTime: jest.fn().mockReturnValue(null) },
    orderEvent: { orderUpdatedEvent: jest.fn(), orderStatusUpdatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderUpdated: jest.fn(), emitStatusUpdate: jest.fn() },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, greffes);
  return { service, coupons, ...greffes, base: () => enBase };
}

const reprendre = (service: OrderService, user: User = CALL_CENTER, corps: Commande = { auto: false }) =>
  service.update(COMMANDE, corps as never, {
    userId: user.id,
    user,
    skipStatusCheck: user.role === UserRole.ADMIN,
  }) as Promise<Commande>;

describe('OrderService.update : reprendre un panier annulé par le client le réactive', () => {
  it('effets complets : active, acceptée, annulation vidée, taxe à zéro, paiement à la caisse, reprise signalée', async () => {
    const m = monterReprise(panierAnnule());

    const reponse = await reprendre(m.service);
    await attendre();

    // Lecture autorisée du panier supprimé, et contrôle « encore relançable ».
    expect(m.findById).toHaveBeenCalledWith(COMMANDE, { inclurePanierAnnuleParClient: true });
    expect(m.orderRelance.verifierReactivable).toHaveBeenCalledWith(COMMANDE, CALL_CENTER);
    // Revendication conditionnée sur l'état « annulé par le client ».
    expect(m.prisma.order.updateMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        id: COMMANDE,
        auto: true,
        paied: false,
        status: OrderStatus.CANCELLED,
        entity_status: EntityStatus.DELETED,
        cancelled_by: ANNULEE_PAR_CLIENT,
      }),
    );
    expect(m.base()).toEqual(
      expect.objectContaining({
        entity_status: EntityStatus.ACTIVE,
        deleted_at: null,
        status: OrderStatus.ACCEPTED,
        cancelled_at: null,
        cancelled_by: null,
        cancelled_reason: null,
        auto: false,
        tax: 0,
        amount: 10000,
        payment_method: PaymentMethod.OFFLINE,
      }),
    );
    expect(m.base().accepted_at).toBeInstanceOf(Date);
    expect(reponse.payment_method).toBe(PaymentMethod.OFFLINE);
    expect(reponse).not.toHaveProperty('avertissement_reprise');

    // Effets d'une reprise de panier en attente : relance, restaurant, cloche.
    expect(m.orderRelance.noterReprise).toHaveBeenCalledWith(
      COMMANDE,
      'u1',
      expect.stringMatching(/^Annulée par le client le \d\d\/\d\d à \d\d:\d\d \(motif : Trop long\), réactivée$/),
    );
    expect(m.orderWebSocketService.emitStatusUpdate).toHaveBeenCalledTimes(1);
    const [diffusee, precedent] = m.orderWebSocketService.emitStatusUpdate.mock.calls[0];
    expect(diffusee.status).toBe(OrderStatus.ACCEPTED);
    expect(precedent).toBe(OrderStatus.PENDING);
    expect(m.orderEvent.orderStatusUpdatedEvent).toHaveBeenCalledTimes(1);
    expect(m.orderEvent.orderStatusUpdatedEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ etait_brouillon: true, expo_token: null }),
    );
    // L'annulation effacée de la commande reste au journal d'audit.
    expect(m.orderRelance.journaliserReactivation).toHaveBeenCalledWith(
      expect.objectContaining({
        commande: expect.objectContaining({ cancelled_at: ANNULEE_LE, cancelled_reason: 'Trop long', cancelled_by: ANNULEE_PAR_CLIENT }),
        acteur: CALL_CENTER,
        coupon: null,
      }),
    );
  });

  it("l'administrateur la réactive aussi", async () => {
    const m = monterReprise(panierAnnule());
    await reprendre(m.service, ADMIN);
    expect(m.base()).toEqual(
      expect.objectContaining({ entity_status: EntityStatus.ACTIVE, status: OrderStatus.ACCEPTED, tax: 0 }),
    );
  });

  it('les points du panier sont déduits par l’écouteur, comme à toute reprise (événement d’acceptation)', async () => {
    const m = monterReprise(panierAnnule({ points: 300, discount: 300, amount: 10200 }));
    await reprendre(m.service);
    await attendre();
    const e = monterEcouteur();
    await e.ecouteur.orderStatusUpdatedEventListener(m.orderEvent.orderStatusUpdatedEvent.mock.calls[0][0]);
    expect(e.loyaltyService.redeemPoints).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: CLIENT, points: 300, order_id: COMMANDE }),
    );
    expect(e.notificationsSender.sendOrderBell).toHaveBeenCalledTimes(1);
    expect(e.userPushService.notifyRestaurant).toHaveBeenCalledTimes(1);
  });

  it('bon rendu à l’annulation : débité de nouveau, remise gardée', async () => {
    const leBon = bon({ remaining_amount: 10_000 });
    const m = monterReprise(panierAnnule({ code_promo: leBon.code, discount: 2000, amount: 8500 }), {
      bons: [leBon],
      // Utilisation rendue par l'annulation.
      redemptions: [{ id: 'r-ancienne', voucher_id: leBon.id, order_id: COMMANDE, amount: 2000, entity_status: EntityStatus.DELETED }],
    });

    const reponse = await reprendre(m.service);

    expect(m.coupons.base.voucher.lignes[0].remaining_amount).toBe(8000);
    const actives = m.coupons.base.redemption.lignes.filter((r) => r.entity_status === EntityStatus.ACTIVE);
    expect(actives).toEqual([expect.objectContaining({ voucher_id: leBon.id, order_id: COMMANDE, amount: 2000 })]);
    // Verrou de la ligne du bon avant le débit.
    expect(m.coupons.base.verrous.some((v) => v.includes('"Voucher"') && v.includes(leBon.id))).toBe(true);
    expect(m.base()).toEqual(expect.objectContaining({ discount: 2000, amount: 8000, code_promo: leBon.code }));
    expect(reponse).not.toHaveProperty('avertissement_reprise');
    expect(m.coupons.voucherService.notifierMouvementBon).toHaveBeenCalledWith(
      expect.objectContaining({ sens: 'DEBIT', montant: 2000, solde: 8000 }),
    );
    expect(m.coupons.auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'COUPON_APPLIQUE' }));
  });

  it('bon réutilisé entre-temps : reprise SANS la remise, total refait, avertissement, rien de débité', async () => {
    const leBon = bon({ remaining_amount: 500 });
    const m = monterReprise(panierAnnule({ code_promo: leBon.code, discount: 2000, amount: 8500 }), {
      bons: [leBon],
      redemptions: [{ id: 'r-ancienne', voucher_id: leBon.id, order_id: COMMANDE, amount: 2000, entity_status: EntityStatus.DELETED }],
    });

    const reponse = await reprendre(m.service);

    expect(m.coupons.base.voucher.lignes[0].remaining_amount).toBe(500);
    expect(m.coupons.base.redemption.lignes.filter((r) => r.entity_status === EntityStatus.ACTIVE)).toEqual([]);
    expect(m.base()).toEqual(
      expect.objectContaining({ discount: 0, amount: 10000, code_promo: null, status: OrderStatus.ACCEPTED }),
    );
    expect(reponse.avertissement_reprise).toMatch(
      /^Commande reprise sans la réduction de 2\s000 F : le bon CN••••Q9 ne peut plus être utilisé\. Le solde de ce bon \(500 F\) ne couvre plus la remise\. Nouveau total : 10\s000 F, à annoncer au client\.$/,
    );
    expect(reponse.avertissement_reprise).not.toMatch(SANS_TIRET);
    expect(reponse.avertissement_reprise).not.toContain('N/A');
    expect(m.coupons.voucherService.notifierMouvementBon).not.toHaveBeenCalled();
    expect(m.coupons.auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'COUPON_RETIRE' }));
  });

  it('bon expiré sans prolongation : reprise sans la remise', async () => {
    const leBon = bon({ status: VoucherStatus.EXPIRED, expires_at: new Date(Date.now() - 60_000) });
    const m = monterReprise(panierAnnule({ code_promo: leBon.code, discount: 2000, amount: 8500 }), {
      bons: [leBon],
      redemptions: [{ id: 'r-ancienne', voucher_id: leBon.id, order_id: COMMANDE, amount: 2000, entity_status: EntityStatus.DELETED }],
    });
    const reponse = await reprendre(m.service);
    expect(m.coupons.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(m.base()).toEqual(expect.objectContaining({ discount: 0, amount: 10000, code_promo: null }));
    expect(reponse.avertissement_reprise).toContain('Ce bon a expiré.');
  });

  it('bon jamais rendu (utilisation encore active) : rien de plus débité, remise gardée', async () => {
    const leBon = bon({ remaining_amount: 8000 });
    const m = monterReprise(panierAnnule({ code_promo: leBon.code, discount: 2000, amount: 8500 }), {
      bons: [leBon],
      redemptions: [{ id: 'r1', voucher_id: leBon.id, order_id: COMMANDE, amount: 2000, entity_status: EntityStatus.ACTIVE }],
    });
    const reponse = await reprendre(m.service);
    expect(m.coupons.base.voucher.lignes[0].remaining_amount).toBe(8000);
    expect(m.coupons.base.redemption.lignes).toHaveLength(1);
    expect(m.base()).toEqual(expect.objectContaining({ discount: 2000, amount: 8000 }));
    expect(reponse).not.toHaveProperty('avertissement_reprise');
  });

  it('code promo du panier (usage préparé, jamais compté) : compté à la réactivation, remise gardée', async () => {
    const promo = codePromo({ max_usage: 10, usage_count: 3 });
    const m = monterReprise(panierAnnule({ code_promo: promo.code, discount: 2000, amount: 8500 }), {
      promos: [promo],
      usages: [{ id: 'u-1', promo_code_id: promo.id, customer_id: CLIENT, order_id: COMMANDE, discount_amount: 2000, status: PromoCodeUsageStatus.INACTIVE }],
    });
    const reponse = await reprendre(m.service);
    await attendre();
    expect(m.coupons.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.ACTIVE);
    // Une seule fois, même si la reprise appelle ensuite activateUsageForOrder.
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(4);
    expect(m.base()).toEqual(expect.objectContaining({ discount: 2000, amount: 8000, code_promo: promo.code }));
    expect(reponse).not.toHaveProperty('avertissement_reprise');
  });

  it('code promo à bout entre-temps : reprise sans la remise, usage jamais compté', async () => {
    const promo = codePromo({ max_usage: 5, usage_count: 5 });
    const m = monterReprise(panierAnnule({ code_promo: promo.code, discount: 2000, amount: 8500 }), {
      promos: [promo],
      usages: [{ id: 'u-1', promo_code_id: promo.id, customer_id: CLIENT, order_id: COMMANDE, discount_amount: 2000, status: PromoCodeUsageStatus.INACTIVE }],
    });
    const reponse = await reprendre(m.service);
    await attendre();
    expect(m.coupons.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.INACTIVE);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(5);
    expect(m.base()).toEqual(expect.objectContaining({ discount: 0, amount: 10000, code_promo: null }));
    expect(reponse.avertissement_reprise).toMatch(
      /^Commande reprise sans la réduction de 2\s000 F : le code promo BIENVENUE20 ne peut plus être utilisé\. Ce code promo a atteint son nombre maximum d'utilisations\. Nouveau total : 10\s000 F, à annoncer au client\.$/,
    );
  });

  it('deux reprises simultanées : une seule réactive, l’autre 409, le bon débité une fois', async () => {
    const leBon = bon({ remaining_amount: 10_000 });
    const m = monterReprise(panierAnnule({ code_promo: leBon.code, discount: 2000, amount: 8500 }), {
      bons: [leBon],
      redemptions: [{ id: 'r-ancienne', voucher_id: leBon.id, order_id: COMMANDE, amount: 2000, entity_status: EntityStatus.DELETED }],
    });
    const resultats = await Promise.allSettled([reprendre(m.service), reprendre(m.service)]);
    const echecs = resultats.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(echecs).toHaveLength(1);
    expect(echecs[0].reason).toBeInstanceOf(ConflictException);
    expect(echecs[0].reason.message).toBe('Cette commande vient de changer : rechargez-la avant de la reprendre.');
    expect(m.coupons.base.voucher.lignes[0].remaining_amount).toBe(8000);
  });

  it('plus relançable (le client a recommandé, paiement couvrant, hors fenêtre) : 409 qui dit pourquoi, rien d’écrit', async () => {
    const m = monterReprise(panierAnnule());
    m.orderRelance.verifierReactivable.mockRejectedValue(
      new ConflictException("Cette commande n'est plus à relancer : a recommandé (ORD-261001-9)."),
    );
    expect(await refus(reprendre(m.service))).toEqual({
      classe: ConflictException,
      message: "Cette commande n'est plus à relancer : a recommandé (ORD-261001-9).",
    });
    expect(m.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(m.prisma.order.update).not.toHaveBeenCalled();
    expect(m.base().entity_status).toBe(EntityStatus.DELETED);
  });

  it('les autres rôles ne lisent pas le panier supprimé ; si on le leur passait, refus', async () => {
    const gerant = { ...compte(UserRole.MANAGER), type: UserType.BACKOFFICE } as User;
    const m = monterReprise(panierAnnule());
    // En pratique la lecture répond déjà 404 ; à défaut, la garde du statut refuse.
    expect(await refus(reprendre(m.service, gerant))).toEqual({
      classe: ConflictException,
      message: "Une commande annulée ne peut être modifiée que par l'administrateur ou le centre d'appels.",
    });
    expect(m.findById).toHaveBeenCalledWith(COMMANDE, { inclurePanierAnnuleParClient: false });
    expect(m.prisma.order.update).not.toHaveBeenCalled();
  });

  it('autre modification du panier annulé (sans reprise) : il reste annulé et supprimé', async () => {
    const m = monterReprise(panierAnnule());
    await reprendre(m.service, CALL_CENTER, { note: 'Rappeler après 18 h' });
    expect(m.orderRelance.verifierReactivable).not.toHaveBeenCalled();
    expect(m.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(m.base()).toEqual(
      expect.objectContaining({
        status: OrderStatus.CANCELLED,
        entity_status: EntityStatus.DELETED,
        auto: true,
        tax: 500,
        amount: 10500,
        note: 'Rappeler après 18 h',
      }),
    );
  });

  it('commande annulée par le PERSONNEL : la règle reste, son origine ne change pas (409)', async () => {
    const m = monterReprise(panierAnnule({ entity_status: EntityStatus.ACTIVE, deleted_at: null, cancelled_by: 'u9' }));
    expect(await refus(reprendre(m.service))).toEqual({
      classe: ConflictException,
      message: "L'origine d'une commande annulée ne peut pas être changée.",
    });
    expect(m.orderRelance.verifierReactivable).not.toHaveBeenCalled();
    expect(m.base().status).toBe(OrderStatus.CANCELLED);
  });

  it('paiement en attente de confirmation : réactivée, mais le paiement ne passe pas à la caisse', async () => {
    const m = monterReprise(
      panierAnnule({ paiements: [{ status: PaiementStatus.PENDING, amount: 10500, total: 10500 }] }),
    );
    await reprendre(m.service);
    expect(m.base()).toEqual(
      expect.objectContaining({ entity_status: EntityStatus.ACTIVE, payment_method: PaymentMethod.ONLINE }),
    );
  });
});

// ===========================================================================
// S5, suite : cadeaux rendus par l'annulation
// ===========================================================================

/** Table des récompenses, écritures conditionnées évaluées comme en base. */
function tableRecompenses(lignes: Commande[]) {
  return {
    lignes,
    findMany: jest.fn(async ({ where }: { where?: Commande } = {}) =>
      lignes.filter((l) => correspond(l, where)).map((l) => ({ ...l })),
    ),
    updateMany: jest.fn(async ({ where, data }: { where: Commande; data: Commande }) => {
      const cibles = lignes.filter((l) => correspond(l, where));
      cibles.forEach((l) => Object.assign(l, data));
      return { count: cibles.length };
    }),
  };
}

const PLAT_OFFERT = '77777777-7777-4777-8777-777777777777';
const SUPPLEMENT_OFFERT = '88888888-8888-4888-8888-888888888888';

/** Panier annulé avec un plat offert (0 F) et un supplément offert. */
const panierAvecCadeaux = () =>
  panierAnnule({
    order_items: [
      { dish_id: 'plat-payant', unit_price: 4000, quantity: 1, supplements: [], dish: { price: 4000 } },
      {
        dish_id: PLAT_OFFERT,
        unit_price: 0,
        quantity: 1,
        dish: { price: 3500 },
        supplements: [{ id: SUPPLEMENT_OFFERT, price: 0, quantity: 1, offert: true }],
      },
    ],
  });

const cadeau = (surcharge: Commande): Commande => ({
  customer_id: CLIENT,
  type: 'GIFT',
  status: 'SCRATCHED',
  order_id: null,
  consumed_at: null,
  expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  ...surcharge,
});

describe('OrderService.update : cadeaux d’un panier annulé par le client', () => {
  it('lignes offertes gardées : chaque cadeau rendu est consommé de nouveau, lié à la commande', async () => {
    const m = monterReprise(panierAvecCadeaux());
    const recompenses = tableRecompenses([
      cadeau({ id: 'g-plat', payload: { item_type: 'DISH', dish_id: PLAT_OFFERT } }),
      cadeau({ id: 'g-supp', payload: { item_type: 'SUPPLEMENT', supplement_id: SUPPLEMENT_OFFERT } }),
      // Un autre cadeau du client, sans rapport : jamais touché.
      cadeau({ id: 'g-autre', payload: { item_type: 'DISH', dish_id: 'autre-plat' } }),
    ]);
    m.coupons.prisma.reward = recompenses;

    await reprendre(m.service);

    const parId = Object.fromEntries(recompenses.lignes.map((r) => [r.id, r]));
    expect(parId['g-plat']).toEqual(expect.objectContaining({ status: 'CONSUMED', order_id: COMMANDE }));
    expect(parId['g-supp']).toEqual(expect.objectContaining({ status: 'CONSUMED', order_id: COMMANDE }));
    expect(parId['g-autre']).toEqual(expect.objectContaining({ status: 'SCRATCHED', order_id: null }));
    expect(m.base()).toEqual(expect.objectContaining({ entity_status: EntityStatus.ACTIVE, status: OrderStatus.ACCEPTED }));
  });

  it('cadeau jamais rendu (encore lié à la commande) : rien de plus consommé', async () => {
    const m = monterReprise(panierAvecCadeaux());
    const recompenses = tableRecompenses([
      cadeau({ id: 'g-plat', status: 'CONSUMED', order_id: COMMANDE, payload: { dish_id: PLAT_OFFERT } }),
      cadeau({ id: 'g-supp', status: 'CONSUMED', order_id: COMMANDE, payload: { item_type: 'SUPPLEMENT', supplement_id: SUPPLEMENT_OFFERT } }),
      cadeau({ id: 'g-double', payload: { item_type: 'DISH', dish_id: PLAT_OFFERT } }),
    ]);
    m.coupons.prisma.reward = recompenses;

    await reprendre(m.service);

    expect(recompenses.updateMany).not.toHaveBeenCalled();
    expect(recompenses.lignes.find((r) => r.id === 'g-double')).toEqual(expect.objectContaining({ status: 'SCRATCHED' }));
  });

  it('cadeau réutilisé ou expiré depuis l’annulation : 409 qui dit quoi faire, coupon intact', async () => {
    const leBon = bon({ remaining_amount: 10_000 });
    const commande = { ...panierAvecCadeaux(), code_promo: leBon.code, discount: 2000, amount: 8500 };
    const m = monterReprise(commande, {
      bons: [leBon],
      redemptions: [{ id: 'r-ancienne', voucher_id: leBon.id, order_id: COMMANDE, amount: 2000, entity_status: EntityStatus.DELETED }],
    });
    m.coupons.prisma.reward = tableRecompenses([
      cadeau({ id: 'g-plat', status: 'CONSUMED', order_id: 'autre-commande', payload: { dish_id: PLAT_OFFERT } }),
      cadeau({ id: 'g-supp', expires_at: new Date(Date.now() - 60_000), payload: { item_type: 'SUPPLEMENT', supplement_id: SUPPLEMENT_OFFERT } }),
    ]);

    const erreur = await refus(reprendre(m.service));

    expect(erreur).toEqual({
      classe: ConflictException,
      message:
        "Le cadeau offert sur cette commande n'est plus disponible (utilisé ou expiré depuis l'annulation) : modifiez les articles avant de la reprendre.",
    });
    expect(erreur.message).not.toMatch(SANS_TIRET);
    // Le coupon n'a pas été touché, la commande n'a pas été écrite.
    expect(m.coupons.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(m.prisma.order.update).not.toHaveBeenCalled();
  });
});

describe('OrderService.update : cadeaux, articles renvoyés par le formulaire (revue du 01/10)', () => {
  /** Panier annulé : un plat payant, un plat offert avec un supplément offert, noms connus. */
  const panierNomme = () =>
    panierAnnule({
      order_items: [
        { dish_id: 'plat-payant', unit_price: 4000, quantity: 1, supplements: [], dish: { price: 4000, name: 'Poulet braisé' } },
        {
          dish_id: PLAT_OFFERT,
          unit_price: 0,
          quantity: 1,
          epice: true,
          dish: { price: 3500, name: 'Menu Nation' },
          supplements: [{ id: SUPPLEMENT_OFFERT, name: 'Alloco', price: 0, quantity: 1, offert: true }],
        },
      ],
    });

  /** Exactement ce que renvoie le formulaire pour ce panier (buildFormDataFromOrder, preparerArticles). */
  const articlesDuFormulaire = () => [
    { dish_id: 'plat-payant', quantity: 1, epice: false },
    { dish_id: PLAT_OFFERT, quantity: 1, epice: true, supplements: [{ id: SUPPLEMENT_OFFERT, quantity: 1 }] },
  ];

  function monterAvecArticles() {
    const m = monterReprise(panierNomme());
    const recompenses = tableRecompenses([
      cadeau({ id: 'g-plat', payload: { item_type: 'DISH', dish_id: PLAT_OFFERT } }),
      cadeau({ id: 'g-supp', payload: { item_type: 'SUPPLEMENT', supplement_id: SUPPLEMENT_OFFERT } }),
    ]);
    m.coupons.prisma.reward = recompenses;
    m.coupons.prisma.dish = { findMany: jest.fn().mockResolvedValue([]) };
    const calculateOrderDetails = jest.fn(async (articles: Commande[]) => {
      const prix: Record<string, number> = { 'plat-payant': 4000, [PLAT_OFFERT]: 3500 };
      const orderItems = articles.map((a) => {
        const supplementsPrice = (a.supplements ?? []).length * 500;
        const lineTotal = (prix[a.dish_id] + supplementsPrice) * a.quantity;
        return {
          dish_id: a.dish_id,
          quantity: a.quantity,
          amount: lineTotal,
          dishPrice: prix[a.dish_id],
          supplementsPrice,
          lineTotal,
          epice: !!a.epice,
          supplements: a.supplements ?? [],
          options: [],
        };
      });
      return { orderItems, netAmount: orderItems.reduce((t, l) => t + l.lineTotal, 0) };
    });
    Object.assign(m.orderHelper, { calculateOrderDetails });
    return { m, recompenses, calculateOrderDetails };
  }

  it('articles inchangés (le cas de l’écran) : lignes d’origine gardées, cadeaux consommés de nouveau, aucun avertissement', async () => {
    const { m, recompenses, calculateOrderDetails } = monterAvecArticles();

    const reponse = await reprendre(m.service, CALL_CENTER, { auto: false, items: articlesDuFormulaire() });

    expect(calculateOrderDetails).not.toHaveBeenCalled();
    const ecriture = m.prisma.order.update.mock.calls[0][0].data;
    expect(ecriture).not.toHaveProperty('order_items');
    // Taxe retirée, total refait sur les lignes d'origine (offertes à 0 F).
    expect(ecriture.amount).toBe(10000);
    for (const r of recompenses.lignes) expect(r).toEqual(expect.objectContaining({ status: 'CONSUMED', order_id: COMMANDE }));
    expect(reponse).not.toHaveProperty('avertissement_reprise');
  });

  it('articles modifiés : lignes recalculées, cadeaux encore au panier facturés, l’agent est averti', async () => {
    const { m, recompenses, calculateOrderDetails } = monterAvecArticles();
    const articles = articlesDuFormulaire();
    articles[0].quantity = 2;

    const reponse = await reprendre(m.service, CALL_CENTER, { auto: false, items: articles });

    expect(calculateOrderDetails).toHaveBeenCalledTimes(1);
    // Aucun cadeau consommé : rien n'est offert sur les lignes recalculées.
    for (const r of recompenses.lignes) expect(r).toEqual(expect.objectContaining({ status: 'SCRATCHED', order_id: null }));
    expect(reponse.avertissement_reprise).toMatch(
      /^Les cadeaux offerts \(Menu Nation, Alloco\) ont été rendus au client à l'annulation : ils sont facturés au prix de la carte sur la commande reprise\. Nouveau total : .+ F, à annoncer au client\.$/,
    );
    expect(reponse.avertissement_reprise).not.toMatch(SANS_TIRET);
    expect(reponse.avertissement_reprise).not.toContain('N/A');
    expect(m.orderRelance.journaliserReactivation).toHaveBeenCalledWith(
      expect.objectContaining({ cadeauxFactures: ['Menu Nation', 'Alloco'] }),
    );
  });

  it('plat offert retiré du panier : rien n’est facturé, aucun avertissement', async () => {
    const { m } = monterAvecArticles();

    const reponse = await reprendre(m.service, CALL_CENTER, { auto: false, items: [articlesDuFormulaire()[0]] });

    expect(reponse).not.toHaveProperty('avertissement_reprise');
  });
});

describe('memesArticles et cadeauxRefactures', () => {
  const lignes = [
    { dish_id: 'a', quantity: 2, epice: false, supplements: [{ id: 's1' }, { id: 's1' }, { id: 's2', quantity: 1 }], options: [{ id: 'o1' }] },
    { dish_id: 'b', quantity: 1, epice: true, supplements: null, options: [] },
  ];

  it('mêmes lignes, dans n’importe quel ordre, suppléments regroupés : vrai ; choix de menu absents : repris', () => {
    expect(
      memesArticles(lignes, [
        { dish_id: 'b', quantity: 1, epice: true },
        { dish_id: 'a', quantity: 2, epice: false, supplements: [{ id: 's2', quantity: 1 }, { id: 's1', quantity: 2 }] },
      ]),
    ).toBe(true);
    expect(
      memesArticles(lignes, [
        { dish_id: 'a', quantity: 2, supplements: [{ id: 's1', quantity: 2 }, { id: 's2', quantity: 1 }], option_item_ids: ['o1'] },
        { dish_id: 'b', quantity: 1, epice: true },
      ]),
    ).toBe(true);
  });

  it('quantité, épice, supplément, choix de menu ou nombre de lignes différents : faux', () => {
    const base = (): ArticleRenvoye[] => [
      { dish_id: 'a', quantity: 2, epice: false, supplements: [{ id: 's1', quantity: 2 }, { id: 's2', quantity: 1 }] },
      { dish_id: 'b', quantity: 1, epice: true },
    ];
    const variantes = [
      (x: ArticleRenvoye[]) => (x[1].quantity = 2),
      (x: ArticleRenvoye[]) => (x[1].epice = false),
      (x: ArticleRenvoye[]) => (x[0].supplements = [{ id: 's1', quantity: 1 }, { id: 's2', quantity: 1 }]),
      (x: ArticleRenvoye[]) => (x[0] = { ...x[0], option_item_ids: ['o2'] }),
      (x: ArticleRenvoye[]) => x.pop(),
    ];
    for (const changer of variantes) {
      const articles = base();
      changer(articles);
      expect(memesArticles(lignes, articles)).toBe(false);
    }
    expect(memesArticles([], [])).toBe(false);
  });

  it('cadeauxRefactures : seuls les cadeaux dont l’article reste au panier, avec un nom par défaut', () => {
    const avecCadeaux = [
      { dish_id: 'x', unit_price: 0, dish: { price: 3000 }, supplements: [{ id: 's9', offert: true }] },
      { dish_id: 'y', unit_price: 0, dish: { price: 2000, name: 'Brochettes' } },
    ];
    expect(cadeauxRefactures(avecCadeaux, [{ dish_id: 'x', quantity: 1, supplements: [{ id: 's9', quantity: 1 }] }])).toEqual([
      'plat offert',
      'supplément offert',
    ]);
    expect(cadeauxRefactures(avecCadeaux, [{ dish_id: 'y', quantity: 1 }])).toEqual(['Brochettes']);
  });
});

describe('cadeauxDesLignes', () => {
  it('plat à 0 F au prix catalogue non nul, et suppléments marqués « offert » ; rien d’autre', () => {
    expect(
      cadeauxDesLignes([
        { dish_id: 'a', unit_price: 0, dish: { price: 3000 }, supplements: [{ id: 's1', offert: true }, { id: 's2', price: 0 }] },
        // Plat gratuit au catalogue : pas un cadeau.
        { dish_id: 'b', unit_price: 0, dish: { price: 0 }, supplements: null },
        // Prix non figé (ancienne commande) : pas un cadeau.
        { dish_id: 'c', unit_price: null, dish: { price: 3000 } },
        { dish_id: 'd', unit_price: 2500, dish: { price: 2500 }, supplements: [{ id: 's3', offert: false }] },
      ]),
    ).toEqual([
      { genre: 'DISH', dish_id: 'a' },
      { genre: 'SUPPLEMENT', supplement_id: 's1' },
    ]);
  });
});

describe('OrderCouponService.reconsommerALaReactivation : code sans trace d’usage', () => {
  it('remise mêlée à des points : laissée telle quelle (la part du code ne se retrouve pas)', async () => {
    const promo = codePromo({ max_usage: 10, usage_count: 3 });
    const coupons = monterCoupons({ promos: [promo] });
    const resultat = await coupons.service.reconsommerALaReactivation(coupons.prisma, {
      id: COMMANDE,
      customer_id: CLIENT,
      code_promo: promo.code,
      discount: 2300,
      points: 300,
    });
    expect(resultat).toBeNull();
    expect(coupons.base.promoCode.lignes[0].usage_count).toBe(3);
    expect(coupons.base.promoCodeUsage.lignes).toHaveLength(0);
  });

  it('remise du seul code : comptée sous verrou, comme avec une trace', async () => {
    const promo = codePromo({ max_usage: 10, usage_count: 3 });
    const coupons = monterCoupons({ promos: [promo] });
    const resultat = await coupons.service.reconsommerALaReactivation(coupons.prisma, {
      id: COMMANDE,
      customer_id: CLIENT,
      code_promo: promo.code,
      discount: 2000,
      points: 0,
    });
    expect(resultat).toEqual(expect.objectContaining({ type: 'PROMO_CODE', consomme: true, remise: 2000 }));
    expect(coupons.base.promoCode.lignes[0].usage_count).toBe(4);
  });
});
