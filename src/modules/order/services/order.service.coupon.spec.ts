/**
 * OrderService et réductions : création par le personnel (le bouchon qui
 * renvoyait 0 a disparu), non-cumul, consommation dans la transaction,
 * aperçu identique à la création, modification et restitution.
 *
 * Méthodes testées en isolation, comme order.service.encaissement.spec.ts :
 * seules les dépendances qu'elles lisent sont greffées. Le service des
 * réductions et le moteur des codes promo sont RÉELS (base en mémoire).
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, OrderType, PaymentMethod, User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { OrderHelper } from '../helpers/order.helper';
import {
  bon,
  CLIENT,
  codePromo,
  monterCoupons,
  plat,
  PLAT,
  PromoCodeUsageStatus,
  RESTAURANT_A,
  RESTAURANT_B,
} from './order-coupon.base-simulee-spec';
import { OrderService } from './order.service';

const agent = { id: 'agent-1', fullname: 'Adjoua', email: 'a@cn.ci', role: UserRole.CALL_CENTER, type: UserType.BACKOFFICE } as unknown as User;

function monter(donnees: Parameters<typeof monterCoupons>[0] = {}) {
  const coupons = monterCoupons({ plats: [plat()], ...donnees });
  const commandes: Record<string, any>[] = [];
  const tx = {
    ...coupons.prisma,
    order: {
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        const commande = {
          id: `commande-${commandes.length + 1}`,
          reference: `CMD-${commandes.length + 1}`,
          customer_id: data.customer.connect.id,
          restaurant_id: data.restaurant.connect.id,
          ...data,
        };
        commandes.push(commande);
        return commande;
      }),
    },
  };
  const prisma = {
    ...coupons.prisma,
    // Transaction : une erreur annule tout, y compris la commande créée.
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      const avant = commandes.length;
      try {
        return await fn(tx);
      } catch (e) {
        commandes.splice(avant);
        throw e;
      }
    }),
  };

  // Calcul du panier RÉEL (OrderHelper), autres étapes simulées.
  const orderHelper = coupons.orderHelper as OrderHelper & Record<string, jest.Mock>;
  Object.assign(orderHelper, {
    getClosestRestaurant: jest.fn().mockResolvedValue({ id: RESTAURANT_A, name: 'A' }),
    assertDishesSoldInRestaurant: jest.fn().mockResolvedValue(undefined),
    calculatePromotionPrice: jest.fn().mockResolvedValue(null),
    checkPayment: jest.fn().mockResolvedValue(null),
    calculateLoyaltyFee: jest.fn().mockResolvedValue(0),
    calculateTax: jest.fn().mockResolvedValue(50),
  });

  const service = Object.create(OrderService.prototype) as OrderService;
  const greffes = {
    prisma,
    orderHelper,
    orderCoupon: coupons.service,
    orderHelperV2: { validateRestaurantChoice: jest.fn().mockResolvedValue({}) },
    generateDataService: {
      generateOrderReference: jest.fn().mockReturnValue('CMD-X'),
      generateRecoveryCode: jest.fn().mockReturnValue('1234'),
    },
    orderEvent: { orderCreatedEvent: jest.fn(), orderStatusUpdatedEvent: jest.fn(), orderDeletedEvent: jest.fn(), orderUpdatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderCreated: jest.fn(), emitOrderDeleted: jest.fn(), emitStatusUpdate: jest.fn(), emitOrderUpdated: jest.fn() },
    promoCodeService: { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) },
    signalerAnomalieLivraison: jest.fn().mockResolvedValue(undefined),
    signalerAnomaliePaiement: jest.fn(),
    sendTrackingWhatsAppIfNoApp: jest.fn().mockResolvedValue(undefined),
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  Object.assign(service, greffes);
  const { service: _coupons, ...reste } = coupons;
  return { ...reste, ...greffes, service, commandes, tx, orderHelper };
}

const corps = (surcharge: Record<string, unknown> = {}) => ({
  type: OrderType.PICKUP,
  customer_id: CLIENT,
  restaurant_id: RESTAURANT_A,
  user_id: agent.id,
  items: [{ dish_id: PLAT, quantity: 2, epice: false }],
  ...surcharge,
});

const creer = (outils: ReturnType<typeof monter>, surcharge: Record<string, unknown> = {}, user: unknown = agent) =>
  outils.service.create({ user } as unknown as Request, corps(surcharge) as any);

describe('OrderService.create : réduction du personnel', () => {
  it("enregistre la remise en MONTANT (jamais multipliée par le panier) et le code normalisé", async () => {
    const outils = monter({ promos: [codePromo()] });
    const commande = await creer(outils, { code_promo: 'bienvenue20' });

    expect(commande.discount).toBe(1600);
    expect(commande.net_amount).toBe(8000);
    // Personnel : taxe nulle, pas de livraison (à emporter).
    expect(commande.amount).toBe(6400);
    expect(commande.code_promo).toBe('BIENVENUE20');
    expect(commande.status).toBe(OrderStatus.ACCEPTED);
  });

  it('consomme le code DANS la transaction : un usage ACTIVE au montant exact, compteur +1', async () => {
    const outils = monter({ promos: [codePromo()] });
    const commande = await creer(outils, { code_promo: 'BIENVENUE20' });

    expect(outils.base.promoCodeUsage.lignes).toEqual([
      expect.objectContaining({
        order_id: commande.id,
        discount_amount: 1600,
        status: PromoCodeUsageStatus.ACTIVE,
      }),
    ]);
    expect(outils.base.promoCode.lignes[0].usage_count).toBe(1);
    expect(outils.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'COUPON_APPLIQUE', actor_id: 'agent-1', entity_id: commande.id }),
    );
  });

  it("le rattrapage d'usage qui suit la création (commande ACCEPTED) ne compte pas le code une seconde fois", async () => {
    const outils = monter({ promos: [codePromo()] });
    // Moteur RÉEL des codes promo, sur la même base, à la place du simulacre.
    (outils.service as unknown as { promoCodeService: unknown }).promoCodeService = outils.promoCodeService;
    const commande = await creer(outils, { code_promo: 'BIENVENUE20' });
    // Puis l'encaissement (markPaidCash, ajout de paiement) le rappelle encore.
    await outils.promoCodeService.activateUsageForOrder(commande as never);

    expect(outils.base.promoCodeUsage.lignes).toHaveLength(1);
    expect(outils.base.promoCode.lignes[0].usage_count).toBe(1);
  });

  it('débite le bon, trace la commande et prévient le client', async () => {
    const outils = monter({ bons: [bon()] });
    const commande = await creer(outils, { code_promo: 'CN7K2XQ9' });

    expect(commande.discount).toBe(8000);
    expect(commande.amount).toBe(0);
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(2000);
    expect(outils.base.redemption.lignes).toEqual([
      expect.objectContaining({ order_id: commande.id, amount: 8000 }),
    ]);
    expect(outils.voucherService.notifierMouvementBon).toHaveBeenCalledWith(
      expect.objectContaining({ sens: 'DEBIT', montant: 8000, solde: 2000, customerId: CLIENT }),
    );
  });

  it('plafonne la remise aux articles : le total ne descend jamais sous les frais', async () => {
    const outils = monter({ bons: [bon({ remaining_amount: 50_000 })] });
    const commande = await creer(outils, { code_promo: 'CN7K2XQ9', type: OrderType.PICKUP });
    expect(commande.discount).toBe(8000);
    expect(commande.amount).toBe(0);
  });

  it("un code invalide n'écrit rien : ni commande, ni usage", async () => {
    const outils = monter({ promos: [codePromo({ is_active: false })] });
    await expect(creer(outils, { code_promo: 'BIENVENUE20' })).rejects.toThrow("Ce code promo n'est pas actif.");
    expect(outils.prisma.$transaction).not.toHaveBeenCalled();
    expect(outils.commandes).toHaveLength(0);
  });

  it("si la consommation échoue dans la transaction, la commande n'est pas créée", async () => {
    const outils = monter({ bons: [bon()] });
    // Bon débité par une autre commande entre la vérification et l'écriture.
    const updateMany = outils.base.voucher.updateMany;
    outils.base.voucher.updateMany = jest.fn(async (args: any) => {
      outils.base.voucher.lignes[0].remaining_amount = 500;
      return updateMany(args);
    }) as any;

    await expect(creer(outils, { code_promo: 'CN7K2XQ9' })).rejects.toThrow(/Le solde de ce bon a changé/);
    expect(outils.commandes).toHaveLength(0);
    expect(outils.base.redemption.lignes).toHaveLength(0);
    expect(outils.auditService.record).not.toHaveBeenCalled();
    expect(outils.voucherService.notifierMouvementBon).not.toHaveBeenCalled();
  });

  it('refuse le cumul points et coupon (RG-02), avant toute lecture', async () => {
    const outils = monter({ promos: [codePromo()] });
    const erreur = await creer(outils, { code_promo: 'BIENVENUE20', points: 100 }).catch((e) => e);
    expect(erreur).toBeInstanceOf(BadRequestException);
    expect(erreur.message).toMatch(/Non-cumul/);
    expect(outils.orderHelper.resolveCustomerData).not.toHaveBeenCalled();
  });

  it('refuse le cumul promotion et coupon', async () => {
    const outils = monter({ promos: [codePromo()] });
    await expect(
      creer(outils, { code_promo: 'BIENVENUE20', promotion_id: '77777777-7777-4777-8777-777777777777' }),
    ).rejects.toThrow('Une promotion et un code promo ou un bon ne se cumulent pas sur une même commande.');
  });

  it("route client historique (sans auteur) : le code n'est ni vérifié, ni écrit, ni compté", async () => {
    const outils = monter({ promos: [codePromo()] });
    const commande = await creer(outils, { code_promo: 'BIENVENUE20', user_id: undefined }, { id: CLIENT });

    expect(commande.code_promo).toBeUndefined();
    expect(commande.discount).toBe(0);
    expect(outils.base.promoCodeUsage.lignes).toHaveLength(0);
    expect(commande.status).toBe(OrderStatus.PENDING);
  });

  it("sans code, la création ne change pas : aucune remise, aucun audit de réduction", async () => {
    const outils = monter();
    const commande = await creer(outils);
    expect(commande.discount).toBe(0);
    expect(commande.amount).toBe(8000);
    expect(commande).not.toHaveProperty('code_promo');
    expect(outils.auditService.record).not.toHaveBeenCalled();
  });
});

describe('Aperçu = création', () => {
  it.each([
    ['code promo plafonné', { promos: [codePromo({ max_discount_amount: 1500 })] }, 'BIENVENUE20'],
    ['code à pourcentage non entier (1 066,4 F)', { promos: [codePromo({ discount_value: 13.33 })] }, 'BIENVENUE20'],
    ['bon plus petit que le panier', { bons: [bon({ remaining_amount: 3000.4 })] }, 'CN7K2XQ9'],
  ])('%s : même remise, même code, arrondie au franc', async (_cas, donnees, code) => {
    const outils = monter(donnees as Parameters<typeof monterCoupons>[0]);
    const apercu = await outils.service['orderCoupon'].apercu(agent, {
      code: code.toLowerCase(),
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      type: OrderType.PICKUP as any,
      items: [{ dish_id: PLAT, quantity: 2, epice: false }],
    });
    const commande = await creer(outils, { code_promo: code.toLowerCase() });

    expect(Number.isInteger(apercu.remise)).toBe(true);
    expect(commande.discount).toBe(apercu.remise);
    expect(commande.code_promo).toBe(apercu.code);
    expect(commande.net_amount).toBe(apercu.sous_total);
  });
});

describe('OrderService.update : coupon figé', () => {
  function preparer(commande: Record<string, unknown>) {
    const outils = monter();
    (outils.service as unknown as { findById: jest.Mock }).findById = jest.fn().mockResolvedValue({
      id: 'commande-1',
      type: OrderType.PICKUP,
      status: OrderStatus.ACCEPTED,
      restaurant_id: RESTAURANT_A,
      customer_id: CLIENT,
      order_items: [],
      tax: 0,
      delivery_fee: 0,
      ...commande,
    });
    (outils.prisma as any).order = { update: jest.fn() };
    (outils.prisma as any).dish = { findMany: jest.fn().mockResolvedValue([plat()]) };
    return outils;
  }

  it('refuse de changer le client d’une commande avec coupon', async () => {
    const outils = preparer({ code_promo: 'CN7K2XQ9', discount: 8000 });
    await expect(
      outils.service.update('commande-1', { customer_id: '99999999-9999-4999-8999-999999999999' } as any, { user: agent }),
    ).rejects.toThrow(ConflictException);
    expect((outils.prisma as any).order.update).not.toHaveBeenCalled();
  });

  it('refuse un panier qui passerait sous la remise', async () => {
    const outils = preparer({ code_promo: 'CN7K2XQ9', discount: 8000 });
    const erreur = await outils.service
      .update('commande-1', { items: [{ dish_id: PLAT, quantity: 1, epice: false }] } as any, { user: agent })
      .catch((e) => e);
    expect(erreur).toBeInstanceOf(ConflictException);
    expect(erreur.message).toMatch(/La réduction de cette commande .* dépasserait le montant des articles/);
    expect((outils.prisma as any).order.update).not.toHaveBeenCalled();
  });
});

describe('Restitution branchée sur l’annulation et la suppression', () => {
  it("l'annulation rend le bon, avec l'agent au journal", async () => {
    const leBon = bon({ remaining_amount: 2000 });
    const outils = monter({
      bons: [leBon],
      redemptions: [{ id: 'r1', voucher_id: leBon.id, order_id: 'commande-1', amount: 8000, entity_status: 'ACTIVE' }],
      users: [{ id: 'agent-1', fullname: 'Adjoua', email: 'a@cn.ci', role: UserRole.CALL_CENTER }],
    });
    (outils.service as unknown as { findById: jest.Mock }).findById = jest.fn().mockResolvedValue({
      id: 'commande-1',
      reference: 'CMD-1',
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      type: OrderType.PICKUP,
      status: OrderStatus.ACCEPTED,
      payment_method: PaymentMethod.OFFLINE,
    });
    Object.assign(outils.orderHelper, {
      validateStatusTransition: jest.fn(),
      assertPreparationAutorisee: jest.fn(),
      handleStatusSpecificActions: jest.fn().mockResolvedValue(undefined),
      calculateEstimatedTime: jest.fn().mockReturnValue(null),
    });
    (outils.prisma as any).order = {
      update: jest.fn().mockResolvedValue({ id: 'commande-1', customer_id: CLIENT, status: OrderStatus.CANCELLED }),
    };
    (outils.prisma as any).notificationSetting = { findUnique: jest.fn().mockResolvedValue(null) };

    await outils.service.updateStatus('commande-1', OrderStatus.CANCELLED, { userId: 'agent-1', role: UserRole.CALL_CENTER });

    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(outils.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'COUPON_RESTITUE', actor_id: 'agent-1', method: 'PATCH' }),
    );
  });

  it('la suppression rend le bon et décompte le code promo', async () => {
    const leBon = bon({ remaining_amount: 2000 });
    const promo = codePromo({ usage_count: 1 });
    const outils = monter({
      bons: [leBon],
      promos: [promo],
      redemptions: [{ id: 'r1', voucher_id: leBon.id, order_id: 'commande-1', amount: 8000, entity_status: 'ACTIVE' }],
      usages: [
        { id: 'u1', promo_code_id: promo.id, customer_id: CLIENT, order_id: 'commande-1', discount_amount: 1600, status: PromoCodeUsageStatus.ACTIVE },
      ],
    });
    (outils.service as unknown as { findById: jest.Mock }).findById = jest.fn().mockResolvedValue({
      id: 'commande-1',
      reference: 'CMD-1',
      customer_id: CLIENT,
      restaurant_id: RESTAURANT_A,
      paied: false,
    });
    (outils.prisma as any).order = { update: jest.fn().mockResolvedValue({ id: 'commande-1' }) };

    await outils.service.remove('commande-1', agent);

    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(outils.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.INACTIVE);
    expect(outils.base.promoCode.lignes[0].usage_count).toBe(0);
    expect(outils.voucherService.notifierMouvementBon).toHaveBeenCalledWith(
      expect.objectContaining({ sens: 'CREDIT', motif: 'SUPPRESSION' }),
    );
  });
});

describe('OrderService.update : restaurant et code promo réservé', () => {
  function preparerAvecCode(restaurant_ids: string[]) {
    const promo = codePromo({ restaurant_ids });
    const outils = monter({
      promos: [promo],
      usages: [
        { id: 'u1', promo_code_id: promo.id, customer_id: CLIENT, order_id: 'commande-1', discount_amount: 1600, status: PromoCodeUsageStatus.ACTIVE },
      ],
    });
    (outils.service as unknown as { findById: jest.Mock }).findById = jest.fn().mockResolvedValue({
      id: 'commande-1',
      type: OrderType.PICKUP,
      status: OrderStatus.ACCEPTED,
      restaurant_id: RESTAURANT_A,
      customer_id: CLIENT,
      code_promo: 'BIENVENUE20',
      discount: 1600,
      order_items: [],
      tax: 0,
      delivery_fee: 0,
    });
    (outils.prisma as any).order = { update: jest.fn().mockResolvedValue({ id: 'commande-1' }) };
    return outils;
  }

  it("refuse de déplacer la commande vers un restaurant où son code n'est pas valable", async () => {
    const outils = preparerAvecCode([RESTAURANT_A]);
    await expect(
      outils.service.update('commande-1', { restaurant_id: RESTAURANT_B } as any, { user: agent }),
    ).rejects.toThrow("Le code promo de cette commande n'est pas valable dans ce restaurant.");
    expect((outils.prisma as any).order.update).not.toHaveBeenCalled();
  });

  it('laisse déplacer une commande dont le code vaut partout', async () => {
    const outils = preparerAvecCode([]);
    await outils.service.update('commande-1', { restaurant_id: RESTAURANT_B } as any, { user: agent });
    expect((outils.prisma as any).order.update).toHaveBeenCalled();
  });
});

describe('Commande annulée : close pour de bon', () => {
  const helper = Object.create(OrderHelper.prototype) as OrderHelper;

  it.each([OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.IN_PROGRESS, OrderStatus.COMPLETED])(
    'refuse CANCELLED vers %s, administrateur compris',
    (vers) => {
      for (const type of [OrderType.DELIVERY, OrderType.PICKUP]) {
        expect(() =>
          helper.validateStatusTransition(type, OrderStatus.CANCELLED, vers, { allowCancelFromAnyStatus: true }),
        ).toThrow('Une commande annulée ne peut pas reprendre. Créez une nouvelle commande.');
      }
    },
  );

  it('refuse une seconde annulation, qui rejouerait le remboursement', () => {
    expect(() =>
      helper.validateStatusTransition(OrderType.PICKUP, OrderStatus.CANCELLED, OrderStatus.CANCELLED, {
        allowCancelFromAnyStatus: true,
      }),
    ).toThrow(ConflictException);
  });

  it("n'a rien changé pour les autres transitions", () => {
    expect(() => helper.validateStatusTransition(OrderType.PICKUP, OrderStatus.PENDING, OrderStatus.CANCELLED)).not.toThrow();
    expect(() => helper.validateStatusTransition(OrderType.PICKUP, OrderStatus.ACCEPTED, OrderStatus.CANCELLED)).not.toThrow();
    expect(() =>
      helper.validateStatusTransition(OrderType.DELIVERY, OrderStatus.PICKED_UP, OrderStatus.CANCELLED, {
        allowCancelFromAnyStatus: true,
      }),
    ).not.toThrow();
    expect(() => helper.validateStatusTransition(OrderType.PICKUP, OrderStatus.ACCEPTED, OrderStatus.IN_PROGRESS)).not.toThrow();
    expect(() => helper.validateStatusTransition(OrderType.PICKUP, OrderStatus.READY, OrderStatus.COMPLETED)).not.toThrow();
  });

  it("scénario : le bon rendu à l'annulation ne peut plus servir une seconde fois par la même commande", async () => {
    const outils = monter({ bons: [bon()], users: [{ id: 'agent-1', fullname: 'Adjoua', email: 'a@cn.ci', role: UserRole.ADMIN }] });
    const commande = await creer(outils, { code_promo: 'CN7K2XQ9' });
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(2000);

    let enBase: Record<string, any> = { ...commande, payment_method: PaymentMethod.OFFLINE };
    (outils.service as unknown as { findById: jest.Mock }).findById = jest.fn(async () => ({ ...enBase }));
    Object.assign(outils.orderHelper, {
      assertPreparationAutorisee: jest.fn(),
      handleStatusSpecificActions: jest.fn().mockResolvedValue(undefined),
      calculateEstimatedTime: jest.fn().mockReturnValue(null),
    });
    (outils.prisma as any).order = {
      update: jest.fn(async ({ data }: { data: Record<string, any> }) => (enBase = { ...enBase, ...data })),
    };
    (outils.prisma as any).notificationSetting = { findUnique: jest.fn().mockResolvedValue(null) };

    await outils.service.updateStatus(commande.id, OrderStatus.CANCELLED, { userId: 'agent-1', role: UserRole.ADMIN });
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);

    // Relancer la commande annulée : refusé, le bon n'est pas repris et la
    // commande ne garde pas une réduction qu'elle n'a plus payée.
    await expect(
      outils.service.updateStatus(commande.id, OrderStatus.PENDING, { userId: 'agent-1', role: UserRole.ADMIN }),
    ).rejects.toThrow(ConflictException);
    await expect(
      outils.service.updateStatus(commande.id, OrderStatus.COMPLETED, { userId: 'agent-1', role: UserRole.ADMIN }),
    ).rejects.toThrow(ConflictException);
    expect(enBase.status).toBe(OrderStatus.CANCELLED);
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
  });
});
