/**
 * CHANGER LE COUPON D'UNE COMMANDE EN LA MODIFIANT (demande du 02/10).
 *
 * « Modifier la commande » applique un code promo ou un bon (`code_promo`) sur
 * une commande qui n'en a pas, le retire (`retirer_coupon`) ou le remplace
 * (les deux), avec les briques et les règles de la création.
 *
 * Comme order.service.panier-annule.spec.ts : `OrderService.update` testé en
 * isolation, le coupon passant par le VRAI OrderCouponService et le VRAI
 * moteur des codes promo sur la base en mémoire des réductions, à laquelle on
 * ajoute la table des commandes. La transaction y est annulable : si la
 * fonction lève, tables et commande reviennent à leur état d'avant, comme en
 * base. C'est ce qui éprouve le remplacement tout ou rien.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
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
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOrderDto } from '../dto/update-order.dto';
import { ANNULEE_PAR_CLIENT } from '../helpers/brouillons.rules';
import { correspond } from '../relance/relance.base-simulee-spec';
import { bon, CLIENT, codePromo, monterCoupons, plat, PLAT, RESTAURANT_A } from './order-coupon.base-simulee-spec';
import { MESSAGE_DROIT_COUPON } from './order-coupon.service';
import { OrderService } from './order.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';

type Commande = Record<string, any>;

const compte = (role: UserRole, surcharge: Partial<User> = {}): User =>
  ({
    id: 'agent-1',
    fullname: 'Adjoua',
    email: 'a@cn.ci',
    role,
    type: UserType.BACKOFFICE,
    restaurant_id: null,
    ...surcharge,
  }) as unknown as User;

const CALL_CENTER = compte(UserRole.CALL_CENTER);
const ADMIN = compte(UserRole.ADMIN);
const CAISSIER = compte(UserRole.CAISSIER, { type: UserType.RESTAURANT, restaurant_id: RESTAURANT_A });
const MANAGER = compte(UserRole.MANAGER, { type: UserType.RESTAURANT, restaurant_id: RESTAURANT_A });

/** Commande du personnel, acceptée, deux burgers à 4 000 F, sans coupon. */
const commande = (surcharge: Commande = {}): Commande => ({
  id: COMMANDE,
  reference: 'CMD-1',
  type: OrderType.PICKUP,
  status: OrderStatus.ACCEPTED,
  restaurant_id: RESTAURANT_A,
  customer_id: CLIENT,
  auto: false,
  payment_method: PaymentMethod.OFFLINE,
  paied: false,
  entity_status: EntityStatus.ACTIVE,
  hubrise_order_id: null,
  code_promo: null,
  net_amount: 8000,
  discount: 0,
  tax: 0,
  amount: 8000,
  delivery_fee: 0,
  points: 0,
  promotion_id: null,
  order_items: [{ dish_id: PLAT, quantity: 2, unit_price: 4000, options: [], supplements: [] }],
  paiements: [],
  ...surcharge,
});

/** La même, avec le code promo BIENVENUE20 déjà appliqué (usage compté). */
const avecCodePromo = (promo: Commande, surcharge: Commande = {}) =>
  commande({ code_promo: promo.code, discount: 1600, amount: 6400, ...surcharge });

const ARTICLES = [{ dish_id: PLAT, quantity: 2, epice: false }];

/** Laisse partir les effets « fire-and-forget » (void ...). */
const attendre = () => new Promise((r) => setTimeout(r, 0));

async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return { classe: (e as Error).constructor, message: (e as Error).message };
  }
  throw new Error('La promesse devait être rejetée');
}

const SANS_TIRET = /[–—]/;

/**
 * `changer` : modifie la commande en base ENTRE la lecture du début et la
 * première écriture (un autre agent est passé).
 */
function monter(
  initiale: Commande,
  donnees: Parameters<typeof monterCoupons>[0] = {},
  changer?: (enBase: Commande) => Commande,
) {
  const coupons = monterCoupons({ plats: [plat()], ...donnees });
  let enBase: Commande = { ...initiale };
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
  coupons.prisma.order = {
    updateMany: jest.fn(async ({ where, data }: { where: Commande; data: Commande }) => {
      avantEcriture();
      if (!accepte(where)) return { count: 0 };
      enBase = { ...enBase, ...data };
      return { count: 1 };
    }),
    update: jest.fn(async ({ where, data }: { where: Commande; data: Commande }) => {
      avantEcriture();
      // Condition dans le `where` (code et remise lus) : Prisma lève P2025.
      if (!accepte(where)) {
        throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', { code: 'P2025', clientVersion: 'test' });
      }
      const { order_items, customer, restaurant, user, ...champs } = data;
      enBase = { ...enBase, ...champs };
      if (order_items?.create) enBase.order_items = order_items.create;
      return { ...enBase };
    }),
    findUnique: jest.fn(async () => ({ ...enBase })),
    findFirst: jest.fn(async ({ where }: { where: Commande }) => (correspond(enBase, where) ? { ...enBase } : null)),
  };

  // Transaction annulable : tout revient en arrière si la fonction lève.
  const transaction = coupons.prisma.$transaction;
  const tables = Object.values(coupons.base).filter((t: any) => Array.isArray(t?.lignes)) as { lignes: Commande[] }[];
  coupons.prisma.$transaction = jest.fn(async (arg: unknown) => {
    if (typeof arg !== 'function') return transaction(arg);
    // L'autre agent est passé juste avant : son écriture est acquise, elle ne
    // sera pas défaite par l'annulation de cette transaction.
    avantEcriture();
    const copies = tables.map((t) => t.lignes.map((l) => ({ ...l })));
    const commandeAvant = { ...enBase };
    try {
      return await transaction(arg);
    } catch (e) {
      tables.forEach((t, i) => t.lignes.splice(0, t.lignes.length, ...copies[i]));
      enBase = commandeAvant;
      throw e;
    }
  });

  // Calcul du panier RÉEL (OrderHelper de la base simulée), reste simulé.
  Object.assign(coupons.orderHelper, { calculateEstimatedTime: jest.fn().mockReturnValue(null) });

  const greffes = {
    prisma: coupons.prisma,
    findById: jest.fn(async () => ({ ...initiale })),
    orderCoupon: coupons.service,
    orderHelper: coupons.orderHelper,
    promoCodeService: coupons.promoCodeService,
    recomputeOrderPaiedFlag: jest.fn(async () => ({ ...enBase })),
    orderRelance: { verifierReactivable: jest.fn(), noterReprise: jest.fn(), journaliserReactivation: jest.fn() },
    orderEvent: { orderUpdatedEvent: jest.fn(), orderStatusUpdatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderUpdated: jest.fn(), emitStatusUpdate: jest.fn() },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, greffes);
  return { service, coupons, ...greffes, base: () => enBase };
}

const modifier = (service: OrderService, corps: Commande, user: User = CALL_CENTER) =>
  service.update(COMMANDE, corps as never, {
    userId: user.id,
    user,
    skipStatusCheck: user.role === UserRole.ADMIN,
  }) as Promise<Commande>;

// ===========================================================================
// S1 : appliquer
// ===========================================================================

describe('OrderService.update : appliquer un coupon sur une commande sans coupon', () => {
  it('code promo, articles renvoyés : remise au franc, total refait, usage compté, journal avec l’agent', async () => {
    const promo = codePromo();
    const m = monter(commande(), { promos: [promo] });

    await modifier(m.service, { items: ARTICLES, code_promo: 'bienvenue20' });

    expect(m.base()).toEqual(
      expect.objectContaining({ code_promo: 'BIENVENUE20', discount: 1600, net_amount: 8000, amount: 6400 }),
    );
    // Commande acceptée : compté tout de suite, UNE fois (le rattrapage
    // `activateUsageForOrder` qui suit ne recompte pas).
    expect(m.coupons.base.promoCodeUsage.lignes).toEqual([
      expect.objectContaining({ order_id: COMMANDE, customer_id: CLIENT, discount_amount: 1600, status: PromoCodeUsageStatus.ACTIVE }),
    ]);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(1);
    expect(m.coupons.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COUPON_APPLIQUE',
        actor_id: 'agent-1',
        entity_id: COMMANDE,
        method: 'PATCH',
        path: `/orders/${COMMANDE}`,
        status_code: 200,
        summary: expect.stringContaining('appliqué sur la commande modifiée CMD-1'),
      }),
    );
    expect(m.orderWebSocketService.emitOrderUpdated).toHaveBeenCalled();
  });

  it('bon, articles non renvoyés : assiette des lignes enregistrées, bon débité, client prévenu', async () => {
    const leBon = bon();
    const m = monter(commande(), { bons: [leBon] });

    await modifier(m.service, { code_promo: 'CN7K2XQ9' });
    await attendre();

    // Le bon couvre au plus les articles (8 000 F), jamais plus.
    expect(m.base()).toEqual(expect.objectContaining({ code_promo: 'CN7K2XQ9', discount: 8000, amount: 0 }));
    expect(m.coupons.base.voucher.lignes[0].remaining_amount).toBe(2000);
    expect(m.coupons.base.redemption.lignes).toEqual([expect.objectContaining({ order_id: COMMANDE, amount: 8000 })]);
    expect(m.coupons.voucherService.notifierMouvementBon).toHaveBeenCalledWith(
      expect.objectContaining({ sens: 'DEBIT', montant: 8000, solde: 2000, customerId: CLIENT, reference: 'CMD-1' }),
    );
  });

  it('lignes anciennes sans prix figé (unit_price nul) : l’assiette se replie sur le prix du plat, la ligne offerte reste à 0 F', async () => {
    const m = monter(
      commande({
        order_items: [
          { dish_id: PLAT, quantity: 2, unit_price: null, options: [], supplements: [], dish: { price: 4000 } },
          // Cadeau : prix figé à 0, il ne se replie pas sur le catalogue.
          { dish_id: PLAT, quantity: 1, unit_price: 0, options: [], supplements: [], dish: { price: 4000 } },
        ],
      }),
      { promos: [codePromo()] },
    );

    await modifier(m.service, { code_promo: 'BIENVENUE20' });

    // 20 % de 8 000 F (deux plats au prix du catalogue, le cadeau exclu).
    expect(m.base()).toEqual(expect.objectContaining({ code_promo: 'BIENVENUE20', discount: 1600, amount: 6400 }));
  });

  it('la remise ne touche ni la taxe ni la livraison : total = articles moins remise, plus taxe, plus livraison', async () => {
    const m = monter(
      commande({ type: OrderType.DELIVERY, tax: 500, delivery_fee: 1000, amount: 9500, auto: true, payment_method: PaymentMethod.ONLINE }),
      { promos: [codePromo()] },
    );
    await modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' });
    expect(m.base()).toEqual(expect.objectContaining({ discount: 1600, tax: 500, delivery_fee: 1000, amount: 7900 }));
  });

  it('la remise se calcule sur les articles FINAUX de la requête, pas sur ceux d’avant', async () => {
    const m = monter(commande(), { promos: [codePromo()] });
    await modifier(m.service, { items: [{ dish_id: PLAT, quantity: 1, epice: false }], code_promo: 'BIENVENUE20' });
    expect(m.base()).toEqual(expect.objectContaining({ net_amount: 4000, discount: 800, amount: 3200 }));
  });

  it('commande encore EN ATTENTE : usage préparé (INACTIVE), compté à l’acceptation', async () => {
    const promo = codePromo();
    const m = monter(commande({ status: OrderStatus.PENDING }), { promos: [promo] });

    await modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' });

    expect(m.base()).toEqual(expect.objectContaining({ code_promo: 'BIENVENUE20', discount: 1600, amount: 6400 }));
    expect(m.coupons.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.INACTIVE);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(0);

    // L'acceptation (updateStatus, reprise au téléphone) compte l'usage.
    await m.coupons.promoCodeService.activateUsageForOrder(m.base() as never);
    expect(m.coupons.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.ACTIVE);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(1);
  });

  it('le caissier applique sur une commande de son restaurant', async () => {
    const m = monter(commande(), { promos: [codePromo()] });
    await modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' }, CAISSIER);
    expect(m.base().discount).toBe(1600);
  });

  it('coupon invalide : le refus de la résolution, rien d’écrit, pas de transaction', async () => {
    const m = monter(commande(), { promos: [codePromo({ is_active: false })] });
    expect(await refus(modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' }))).toEqual(
      expect.objectContaining({ message: "Ce code promo n'est pas actif." }),
    );
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.prisma.order.update).not.toHaveBeenCalled();
    expect(m.base().discount).toBe(0);
  });

  it('la commande a changé entre la lecture et l’écriture (un autre agent a posé un coupon) : 409, rien consommé', async () => {
    const m = monter(commande(), { promos: [codePromo()] }, (enBase) => ({ ...enBase, code_promo: 'AUTRE', discount: 500 }));
    expect(await refus(modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' }))).toEqual({
      classe: ConflictException,
      message: 'Cette commande vient de changer : rechargez-la avant de modifier sa réduction.',
    });
    expect(m.coupons.base.promoCodeUsage.lignes).toHaveLength(0);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(0);
    expect(m.base()).toEqual(expect.objectContaining({ code_promo: 'AUTRE', discount: 500 }));
  });
});

describe('OrderService.update : refus d’un changement de coupon', () => {
  it.each([
    ['payée (paied)', { paied: true }],
    ['un paiement réussi, paied pas encore à jour', { paiements: [{ status: PaiementStatus.SUCCESS, amount: 8000, total: 8000 }] }],
  ])('commande %s : 409, rien d’écrit', async (_cas, etat) => {
    const m = monter(commande(etat), { promos: [codePromo()] });
    expect(await refus(modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' }))).toEqual({
      classe: ConflictException,
      message: 'Commande déjà payée : la réduction ne peut plus changer.',
    });
    expect(m.prisma.order.update).not.toHaveBeenCalled();
    expect(m.coupons.base.promoCodeUsage.lignes).toHaveLength(0);
  });

  it('retirer le coupon d’une commande payée : même refus', async () => {
    const promo = codePromo({ usage_count: 1 });
    const m = monter(avecCodePromo(promo, { paied: true }), {
      promos: [promo],
      usages: [{ id: 'u1', promo_code_id: promo.id, customer_id: CLIENT, order_id: COMMANDE, discount_amount: 1600, status: PromoCodeUsageStatus.ACTIVE }],
    });
    expect(await refus(modifier(m.service, { retirer_coupon: true }))).toEqual({
      classe: ConflictException,
      message: 'Commande déjà payée : la réduction ne peut plus changer.',
    });
    expect(m.coupons.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.ACTIVE);
  });

  it.each([
    ['des points', { points: 300, discount: 300, amount: 7700 }],
    ['une promotion', { promotion_id: '77777777-7777-4777-8777-777777777777', discount: 1000, amount: 7000 }],
  ])('commande qui utilise déjà %s : non-cumul, 409', async (_cas, etat) => {
    const m = monter(commande(etat), { promos: [codePromo()] });
    expect(await refus(modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' }))).toEqual({
      classe: ConflictException,
      message: 'Non-cumul : cette commande utilise déjà des points (ou une promotion).',
    });
    expect(m.prisma.order.update).not.toHaveBeenCalled();
  });

  it('remise d’origine inconnue (ni coupon, ni points, ni promotion) : refusée aussi', async () => {
    const m = monter(commande({ discount: 500, amount: 7500 }), { promos: [codePromo()] });
    expect(await refus(modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' }))).toEqual({
      classe: ConflictException,
      message: "Cette commande porte déjà une réduction qui n'est pas un coupon : elle ne peut pas en recevoir.",
    });
  });

  it('le gestionnaire a UPDATE_FULL mais pas CREATE : 403, et il modifie encore le reste', async () => {
    const m = monter(commande(), { promos: [codePromo()] });
    expect(await refus(modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' }, MANAGER))).toEqual({
      classe: ForbiddenException,
      message: "L'application d'un coupon est réservée au centre d'appels, à la caisse et aux administrateurs.",
    });
    expect(await refus(modifier(m.service, { retirer_coupon: true }, MANAGER))).toEqual(
      expect.objectContaining({ classe: ForbiddenException }),
    );
    expect(m.prisma.order.update).not.toHaveBeenCalled();

    // Sans toucher au coupon, la modification passe comme avant.
    await modifier(m.service, { note: 'Sans oignons' }, MANAGER);
    expect(m.base().note).toBe('Sans oignons');
  });

  it('coupon déjà présent, sans retirer_coupon : 409', async () => {
    const promo = codePromo({ usage_count: 1 });
    const m = monter(avecCodePromo(promo), { promos: [promo, codePromo({ code: 'AUTRE10', discount_value: 10 })] });
    expect(await refus(modifier(m.service, { items: ARTICLES, code_promo: 'AUTRE10' }))).toEqual({
      classe: ConflictException,
      message: "Cette commande a déjà un coupon : retirez-le avant d'en appliquer un autre.",
    });
    expect(m.prisma.order.update).not.toHaveBeenCalled();
  });

  it('retirer un coupon qui n’existe pas : 409', async () => {
    const m = monter(commande());
    expect(await refus(modifier(m.service, { retirer_coupon: true }))).toEqual({
      classe: ConflictException,
      message: "Cette commande n'a pas de coupon à retirer.",
    });
  });

  it('commande annulée (le coupon a déjà été rendu) : 409, même pour le centre d’appels', async () => {
    const m = monter(commande({ status: OrderStatus.CANCELLED, code_promo: 'BIENVENUE20', discount: 1600, amount: 6400 }));
    expect(await refus(modifier(m.service, { retirer_coupon: true }))).toEqual({
      classe: ConflictException,
      message: 'Commande annulée : la réduction ne peut plus changer.',
    });
  });

  it('commande d’un autre restaurant : le cloisonnement passe avant tout', async () => {
    const m = monter(commande({ restaurant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), { promos: [codePromo()] });
    expect(await refus(modifier(m.service, { items: ARTICLES, code_promo: 'BIENVENUE20' }, CAISSIER))).toEqual(
      expect.objectContaining({ classe: ForbiddenException }),
    );
  });
});

// ===========================================================================
// Modification ORDINAIRE (sans toucher au coupon) pendant qu'un autre agent
// change la remise : la remise n'est plus figée, le total ne doit pas
// l'écraser avec une remise périmée.
// ===========================================================================

describe('OrderService.update : modification ordinaire et remise changée entre-temps', () => {
  const MESSAGE = 'Cette commande vient de changer : rechargez-la avant de la modifier.';

  it('A a retiré le coupon, B change une quantité avec l’ancienne remise en tête : 409, rien d’écrit', async () => {
    const promo = codePromo({ usage_count: 1 });
    const m = monter(avecCodePromo(promo), { promos: [promo] }, (enBase) => ({
      ...enBase,
      code_promo: null,
      discount: 0,
      amount: 8000,
    }));

    expect(await refus(modifier(m.service, { items: [{ dish_id: PLAT, quantity: 3, epice: false }] }))).toEqual({
      classe: ConflictException,
      message: MESSAGE,
    });
    // Sans la condition, le total aurait été 12 000 − 1 600 = 10 400 sur une
    // commande sans coupon.
    expect(m.base()).toEqual(expect.objectContaining({ code_promo: null, discount: 0, amount: 8000, net_amount: 8000 }));
  });

  it('A a appliqué un coupon, B enregistre un total sans remise : 409 aussi', async () => {
    const m = monter(commande(), {}, (enBase) => ({ ...enBase, code_promo: 'BIENVENUE20', discount: 1600, amount: 6400 }));
    expect(await refus(modifier(m.service, { items: [{ dish_id: PLAT, quantity: 3, epice: false }] }))).toEqual({
      classe: ConflictException,
      message: MESSAGE,
    });
    expect(m.base()).toEqual(expect.objectContaining({ code_promo: 'BIENVENUE20', discount: 1600, amount: 6400 }));
    expect(MESSAGE).not.toMatch(SANS_TIRET);
  });

  it('rien n’a bougé : la condition tient, le total est refait avec la remise de la commande', async () => {
    const promo = codePromo({ usage_count: 1 });
    const m = monter(avecCodePromo(promo), { promos: [promo] });
    await modifier(m.service, { items: [{ dish_id: PLAT, quantity: 3, epice: false }] });
    expect(m.prisma.order.update.mock.calls[0][0].where).toEqual({ id: COMMANDE, code_promo: promo.code, discount: 1600 });
    expect(m.base()).toEqual(expect.objectContaining({ code_promo: promo.code, discount: 1600, net_amount: 12_000, amount: 10_400 }));
  });

  it('sans total à réécrire (une note) : écriture ordinaire, même si la remise a changé entre-temps', async () => {
    const m = monter(commande(), {}, (enBase) => ({ ...enBase, code_promo: 'BIENVENUE20', discount: 1600, amount: 6400 }));
    await modifier(m.service, { note: 'Sans oignons' });
    expect(m.prisma.order.update.mock.calls[0][0].where).toEqual({ id: COMMANDE });
    expect(m.base()).toEqual(expect.objectContaining({ note: 'Sans oignons', code_promo: 'BIENVENUE20', discount: 1600, amount: 6400 }));
  });
});

// ===========================================================================
// S2 : retirer, remplacer
// ===========================================================================

describe('OrderService.update : retirer le coupon', () => {
  it('code promo compté : usage rendu, compteur baissé, remise retirée du total, journal COUPON_RESTITUE (RETRAIT)', async () => {
    const promo = codePromo({ usage_count: 1 });
    const m = monter(avecCodePromo(promo), {
      promos: [promo],
      usages: [{ id: 'u1', promo_code_id: promo.id, customer_id: CLIENT, order_id: COMMANDE, discount_amount: 1600, status: PromoCodeUsageStatus.ACTIVE }],
      users: [{ id: 'agent-1', fullname: 'Adjoua', email: 'a@cn.ci', role: UserRole.CALL_CENTER }],
    });

    await modifier(m.service, { items: ARTICLES, retirer_coupon: true });
    await attendre();

    expect(m.base()).toEqual(expect.objectContaining({ code_promo: null, discount: 0, amount: 8000 }));
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(0);
    // Plus aucune trace d'usage : l'acceptation ne recomptera rien.
    expect(m.coupons.base.promoCodeUsage.lignes).toHaveLength(0);
    expect(m.coupons.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COUPON_RESTITUE',
        actor_id: 'agent-1',
        method: 'PATCH',
        path: `/orders/${COMMANDE}`,
        summary: 'Code promo BIENVENUE20 rendu : coupon retiré de la commande CMD-1',
        metadata: expect.objectContaining({ motif: 'RETRAIT', type: 'PROMO_CODE', montant: 1600 }),
      }),
    );
    expect(m.coupons.appGateway.emitToBackoffice).toHaveBeenCalledWith(
      'promo_code:usage_reverted',
      expect.objectContaining({ promoCodeId: promo.id, orderId: COMMANDE }),
    );
    const resume = m.coupons.auditService.record.mock.calls.map((c) => c[0].summary).join(' ');
    expect(resume).not.toMatch(SANS_TIRET);
    expect(resume).not.toContain('N/A');
  });

  it('bon : recrédité, utilisation marquée supprimée, client prévenu (motif RETRAIT)', async () => {
    const leBon = bon({ remaining_amount: 2000 });
    const m = monter(commande({ code_promo: leBon.code, discount: 8000, amount: 0 }), {
      bons: [leBon],
      redemptions: [{ id: 'r1', voucher_id: leBon.id, order_id: COMMANDE, amount: 8000, entity_status: EntityStatus.ACTIVE }],
    });

    await modifier(m.service, { retirer_coupon: true });
    await attendre();

    expect(m.base()).toEqual(expect.objectContaining({ code_promo: null, discount: 0, amount: 8000 }));
    expect(m.coupons.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(m.coupons.base.redemption.lignes[0].entity_status).toBe(EntityStatus.DELETED);
    expect(m.coupons.voucherService.notifierMouvementBon).toHaveBeenCalledWith(
      expect.objectContaining({ sens: 'CREDIT', montant: 8000, solde: 10_000, motif: 'RETRAIT', reference: 'CMD-1' }),
    );
    expect(m.coupons.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COUPON_RESTITUE',
        summary: expect.stringMatching(/^Bon CN7K2XQ9 recrédité de 8\s000 F : coupon retiré de la commande CMD-1$/),
      }),
    );
  });

  it('usage seulement préparé (commande en attente) : effacé, pour que l’acceptation ne le compte pas', async () => {
    const promo = codePromo();
    const m = monter(avecCodePromo(promo, { status: OrderStatus.PENDING }), {
      promos: [promo],
      usages: [{ id: 'u1', promo_code_id: promo.id, customer_id: CLIENT, order_id: COMMANDE, discount_amount: 1600, status: PromoCodeUsageStatus.INACTIVE }],
    });
    await modifier(m.service, { retirer_coupon: true });
    expect(m.base()).toEqual(expect.objectContaining({ code_promo: null, discount: 0, amount: 8000 }));
    expect(m.coupons.base.promoCodeUsage.lignes).toHaveLength(0);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(0);
    // Rien n'avait été compté : rien à journaliser comme rendu.
    expect(m.coupons.auditService.record).not.toHaveBeenCalled();
    await m.coupons.promoCodeService.activateUsageForOrder(m.base() as never);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(0);
  });

  it('retrait avec un panier réduit : plus de remise figée à respecter', async () => {
    const leBon = bon({ remaining_amount: 2000 });
    const m = monter(commande({ code_promo: leBon.code, discount: 8000, amount: 0 }), {
      bons: [leBon],
      redemptions: [{ id: 'r1', voucher_id: leBon.id, order_id: COMMANDE, amount: 8000, entity_status: EntityStatus.ACTIVE }],
    });
    await modifier(m.service, { items: [{ dish_id: PLAT, quantity: 1, epice: false }], retirer_coupon: true });
    expect(m.base()).toEqual(expect.objectContaining({ net_amount: 4000, discount: 0, amount: 4000, code_promo: null }));
  });
});

describe('OrderService.update : remplacer le coupon (retirer_coupon et code_promo)', () => {
  it('bon rendu puis code promo consommé, dans la même transaction', async () => {
    const leBon = bon({ remaining_amount: 2000 });
    const promo = codePromo();
    const m = monter(commande({ code_promo: leBon.code, discount: 8000, amount: 0 }), {
      bons: [leBon],
      promos: [promo],
      redemptions: [{ id: 'r1', voucher_id: leBon.id, order_id: COMMANDE, amount: 8000, entity_status: EntityStatus.ACTIVE }],
    });

    await modifier(m.service, { items: ARTICLES, retirer_coupon: true, code_promo: 'BIENVENUE20' });
    await attendre();

    expect(m.base()).toEqual(expect.objectContaining({ code_promo: 'BIENVENUE20', discount: 1600, amount: 6400 }));
    expect(m.coupons.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(m.coupons.base.promoCodeUsage.lignes).toEqual([
      expect.objectContaining({ promo_code_id: promo.id, status: PromoCodeUsageStatus.ACTIVE, discount_amount: 1600 }),
    ]);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(1);
    expect(m.prisma.$transaction).toHaveBeenCalledTimes(1);
    const actions = m.coupons.auditService.record.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(expect.arrayContaining(['COUPON_RESTITUE', 'COUPON_APPLIQUE']));
  });

  it('le nouveau échoue DANS la transaction (bon débité entre-temps) : rien de retiré, l’ancien reste', async () => {
    const promo = codePromo({ usage_count: 1 });
    const leBon = bon();
    const m = monter(avecCodePromo(promo), {
      promos: [promo],
      bons: [leBon],
      usages: [{ id: 'u1', promo_code_id: promo.id, customer_id: CLIENT, order_id: COMMANDE, discount_amount: 1600, status: PromoCodeUsageStatus.ACTIVE }],
    });
    // Un autre débit passe entre la vérification du bon et son écriture.
    const updateMany = m.coupons.base.voucher.updateMany;
    m.coupons.base.voucher.updateMany = jest.fn(async (args: any) => {
      m.coupons.base.voucher.lignes[0].remaining_amount = 500;
      return updateMany(args);
    }) as any;

    expect(await refus(modifier(m.service, { items: ARTICLES, retirer_coupon: true, code_promo: 'CN7K2XQ9' }))).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/Le solde de ce bon a changé/) }),
    );

    expect(m.base()).toEqual(expect.objectContaining({ code_promo: 'BIENVENUE20', discount: 1600, amount: 6400 }));
    expect(m.coupons.base.promoCodeUsage.lignes).toEqual([expect.objectContaining({ id: 'u1', status: PromoCodeUsageStatus.ACTIVE })]);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(1);
    expect(m.coupons.base.redemption.lignes).toHaveLength(0);
    expect(m.coupons.auditService.record).not.toHaveBeenCalled();
    expect(m.coupons.voucherService.notifierMouvementBon).not.toHaveBeenCalled();
  });

  it('le nouveau est refusé AVANT la transaction (code inactif) : rien de retiré non plus', async () => {
    const promo = codePromo({ usage_count: 1 });
    const m = monter(avecCodePromo(promo), {
      promos: [promo, codePromo({ code: 'AUTRE10', is_active: false })],
      usages: [{ id: 'u1', promo_code_id: promo.id, customer_id: CLIENT, order_id: COMMANDE, discount_amount: 1600, status: PromoCodeUsageStatus.ACTIVE }],
    });
    expect(await refus(modifier(m.service, { items: ARTICLES, retirer_coupon: true, code_promo: 'AUTRE10' }))).toEqual(
      expect.objectContaining({ message: "Ce code promo n'est pas actif." }),
    );
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.coupons.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.ACTIVE);
    expect(m.base().code_promo).toBe('BIENVENUE20');
  });

  it('le MÊME code, réappliqué sur des articles changés (limite d’un usage par client) : accepté, remise refaite', async () => {
    const promo = codePromo({ usage_count: 1, max_usage_per_user: 1 });
    const m = monter(avecCodePromo(promo), {
      promos: [promo],
      usages: [{ id: 'u1', promo_code_id: promo.id, customer_id: CLIENT, order_id: COMMANDE, discount_amount: 1600, status: PromoCodeUsageStatus.ACTIVE }],
    });
    await modifier(m.service, { items: [{ dish_id: PLAT, quantity: 3, epice: false }], retirer_coupon: true, code_promo: 'BIENVENUE20' });
    expect(m.base()).toEqual(expect.objectContaining({ net_amount: 12_000, discount: 2400, amount: 9600, code_promo: 'BIENVENUE20' }));
    expect(m.coupons.base.promoCodeUsage.lignes).toEqual([
      expect.objectContaining({ discount_amount: 2400, status: PromoCodeUsageStatus.ACTIVE }),
    ]);
    expect(m.coupons.base.promoCode.lignes[0].usage_count).toBe(1);
  });
});

// ===========================================================================
// S3 : réactivation d'un panier annulé par le client
// ===========================================================================

describe('OrderService.update : réactivation et coupon', () => {
  const panierAnnule = (surcharge: Commande = {}) =>
    commande({
      auto: true,
      payment_method: PaymentMethod.ONLINE,
      status: OrderStatus.CANCELLED,
      entity_status: EntityStatus.DELETED,
      cancelled_by: ANNULEE_PAR_CLIENT,
      cancelled_at: new Date(),
      deleted_at: new Date(),
      tax: 500,
      amount: 8500,
      ...surcharge,
    });

  it.each([
    ['un code', { auto: false, code_promo: 'BIENVENUE20' }],
    ['le retrait', { auto: false, retirer_coupon: true }],
    ['les deux', { auto: false, retirer_coupon: true, code_promo: 'BIENVENUE20' }],
  ])('reprendre le panier avec %s dans la même requête : 409, rien d’écrit', async (_cas, corps) => {
    const m = monter(panierAnnule({ code_promo: 'BIENVENUE20', discount: 1600, amount: 6900 }), { promos: [codePromo()] });
    expect(await refus(modifier(m.service, corps))).toEqual({
      classe: ConflictException,
      message: "Reprenez d'abord la commande, puis changez son coupon.",
    });
    expect(m.orderRelance.verifierReactivable).not.toHaveBeenCalled();
    expect(m.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(m.prisma.order.update).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Aperçu en modification, droits, DTO
// ===========================================================================

describe('OrderCouponService.apercu : commande en modification (commande_id)', () => {
  function monterApercu() {
    const promo = codePromo({ usage_count: 1, max_usage_per_user: 1 });
    const m = monter(avecCodePromo(promo), {
      promos: [promo],
      usages: [{ id: 'u1', promo_code_id: promo.id, customer_id: CLIENT, order_id: COMMANDE, discount_amount: 1600, status: PromoCodeUsageStatus.ACTIVE }],
    });
    const corps = {
      code: 'bienvenue20',
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      type: OrderType.PICKUP as any,
      items: [{ dish_id: PLAT, quantity: 3, epice: false }],
    };
    return { m, corps };
  }

  it('sans commande_id : l’usage de la commande compte, le code est refusé pour ce client', async () => {
    const { m, corps } = monterApercu();
    await expect(m.coupons.service.apercu(CALL_CENTER, corps)).rejects.toThrow(
      'Ce client a déjà utilisé ce code promo le nombre maximum de fois.',
    );
  });

  it('avec la commande dont le coupon va être retiré : la remise se calcule, comme la modification l’enregistrera', async () => {
    const { m, corps } = monterApercu();
    const apercu = await m.coupons.service.apercu(CALL_CENTER, { ...corps, commande_id: COMMANDE });
    expect(apercu).toEqual(expect.objectContaining({ code: 'BIENVENUE20', remise: 2400, sous_total: 12_000 }));
  });

  it('commande d’un autre client ou sans coupon : rien n’est ignoré', async () => {
    const { m, corps } = monterApercu();
    await expect(
      m.coupons.service.apercu(CALL_CENTER, { ...corps, commande_id: '22222222-2222-4222-8222-222222222222' }),
    ).rejects.toThrow('Ce client a déjà utilisé ce code promo le nombre maximum de fois.');
  });
});

describe('OrderCouponService.assertPeutChangerCoupon : même droit qu’à la création', () => {
  const { coupons } = monter(commande());

  it.each([UserRole.ADMIN, UserRole.CALL_CENTER, UserRole.CAISSIER])('%s passe', (role) => {
    expect(() => coupons.service.assertPeutChangerCoupon(compte(role))).not.toThrow();
  });

  it.each([UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CUISINE, UserRole.MARKETING, UserRole.COMPTABLE])(
    '%s est refusé (403)',
    (role) => {
      expect(() => coupons.service.assertPeutChangerCoupon(compte(role))).toThrow(ForbiddenException);
      expect(() => coupons.service.assertPeutChangerCoupon(compte(role))).toThrow(MESSAGE_DROIT_COUPON);
    },
  );

  it('sans compte : refusé', () => {
    expect(() => coupons.service.assertPeutChangerCoupon(undefined)).toThrow(ForbiddenException);
  });

  it('le message est du français propre', () => {
    expect(MESSAGE_DROIT_COUPON).not.toMatch(SANS_TIRET);
    expect(MESSAGE_DROIT_COUPON).not.toContain('N/A');
  });
});

describe('UpdateOrderDto.retirer_coupon', () => {
  it.each([
    [true, true],
    ['true', true],
    [false, false],
    ['false', false],
  ])('%p vaut %p après transformation', async (recu, attendu) => {
    const dto = plainToInstance(UpdateOrderDto, { retirer_coupon: recu });
    expect(dto.retirer_coupon).toBe(attendu);
    expect(await validate(dto, { skipMissingProperties: true })).toEqual([]);
  });

  it('absent : reste absent (la modification ne touche pas au coupon)', () => {
    const dto = plainToInstance(UpdateOrderDto, { note: 'x' });
    expect(dto.retirer_coupon).toBeUndefined();
  });
});
