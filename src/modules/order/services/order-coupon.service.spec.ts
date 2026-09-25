/**
 * Réductions à la prise de commande du personnel : résolution (motifs de refus
 * précis), consommation atomique, restitution, aperçu et bons du client.
 *
 * OrderCouponService RÉEL, moteur des codes promo RÉEL et calcul du panier
 * RÉEL, sur une base en mémoire dont les écritures conditionnées se comportent
 * comme en PostgreSQL (voir order-coupon.base-simulee-spec.ts).
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DiscountType, EntityStatus, OrderType, TargetType, User, UserRole, UserType } from '@prisma/client';
import {
  AUTRE_CLIENT,
  bon,
  CLIENT,
  codePromo,
  monterCoupons,
  plat,
  PLAT,
  PromoCodeUsageStatus,
  RESTAURANT_A,
  RESTAURANT_B,
  VoucherStatus,
} from './order-coupon.base-simulee-spec';

const JOUR = 24 * 60 * 60 * 1000;
const assiette = (prix: number, quantite = 1) => [{ dish_id: PLAT, quantity: quantite, price: prix }];

const resoudre = (outils: ReturnType<typeof monterCoupons>, code: string, netAmount = 8000, restaurantId = RESTAURANT_A) =>
  outils.service.resoudre({
    code,
    customerId: CLIENT,
    netAmount,
    assiette: assiette(netAmount),
    restaurantId,
  });

describe('OrderCouponService.resoudre : codes promo', () => {
  it('accepte un code valide, saisi en minuscules avec des espaces', async () => {
    const outils = monterCoupons({ promos: [codePromo()] });
    const coupon = await resoudre(outils, '  bienvenue20 ');
    expect(coupon).toEqual(
      expect.objectContaining({ type: 'PROMO_CODE', code: 'BIENVENUE20', remise: 1600 }),
    );
  });

  it('applique le plafond du pourcentage', async () => {
    const outils = monterCoupons({ promos: [codePromo({ max_discount_amount: 1000 })] });
    expect((await resoudre(outils, 'BIENVENUE20')).remise).toBe(1000);
  });

  it('arrondit la remise au franc', async () => {
    const outils = monterCoupons({ promos: [codePromo({ discount_value: 12.5 })] });
    // 12,5 % de 8 333 = 1 041,625
    const coupon = await resoudre(outils, 'BIENVENUE20', 8333);
    expect(coupon.remise).toBe(1042);
    expect(Number.isInteger(coupon.remise)).toBe(true);
  });

  it("un montant fixe supérieur au panier ne dépasse jamais les articles", async () => {
    const outils = monterCoupons({
      promos: [codePromo({ discount_type: DiscountType.FIXED_AMOUNT, discount_value: 20_000 })],
    });
    expect((await resoudre(outils, 'BIENVENUE20', 8000)).remise).toBe(8000);
  });

  it.each([
    ['expiré', { expiration_date: new Date(Date.now() - JOUR) }, 'Ce code promo a expiré.'],
    ['inactif', { is_active: false }, "Ce code promo n'est pas actif."],
    ['pas encore valide', { start_date: new Date(Date.now() + JOUR) }, "Ce code promo n'est pas encore valide."],
    ['supprimé', { entity_status: EntityStatus.DELETED }, "Ce code promo n'existe plus."],
    [
      'plafond global atteint',
      { max_usage: 5, usage_count: 5 },
      "Ce code promo a atteint son nombre maximum d'utilisations.",
    ],
    [
      'réservé à un autre restaurant',
      { restaurant_ids: [RESTAURANT_B] },
      "Ce code promo n'est pas valable dans ce restaurant.",
    ],
  ])('refuse un code %s avec un motif précis', async (_cas, surcharge, message) => {
    const outils = monterCoupons({ promos: [codePromo(surcharge)] });
    await expect(resoudre(outils, 'BIENVENUE20')).rejects.toThrow(message);
  });

  it('accepte un code réservé au restaurant de la commande', async () => {
    const outils = monterCoupons({ promos: [codePromo({ restaurant_ids: [RESTAURANT_A] })] });
    await expect(resoudre(outils, 'BIENVENUE20')).resolves.toBeDefined();
  });

  it("refuse un panier sous le minimum, montant mis en forme pour l'agent", async () => {
    const outils = monterCoupons({ promos: [codePromo({ min_order_amount: 10_000 })] });
    await expect(resoudre(outils, 'BIENVENUE20', 8000)).rejects.toThrow(
      /Le montant minimum de commande pour ce code est de 10.000 F, hors livraison\./,
    );
  });

  it('refuse un client qui a déjà utilisé le code autant que permis', async () => {
    const promo = codePromo({ max_usage_per_user: 1 });
    const outils = monterCoupons({
      promos: [promo],
      usages: [{ id: 'u0', promo_code_id: promo.id, customer_id: CLIENT, status: PromoCodeUsageStatus.ACTIVE }],
    });
    await expect(resoudre(outils, 'BIENVENUE20')).rejects.toThrow(
      'Ce client a déjà utilisé ce code promo le nombre maximum de fois.',
    );
  });

  it("refuse un code ciblé quand aucun article n'est concerné", async () => {
    const outils = monterCoupons({
      promos: [
        codePromo({
          target_type: TargetType.SPECIFIC_PRODUCTS,
          promo_code_targeted_dishes: [{ dish_id: 'autre-plat' }],
        }),
      ],
    });
    await expect(resoudre(outils, 'BIENVENUE20')).rejects.toThrow(
      "Ce code promo ne s'applique à aucun article de cette commande.",
    );
  });

  it('refuse en 400 un code valide qui ne retire rien', async () => {
    const outils = monterCoupons({ promos: [codePromo({ discount_value: 0 })] });
    const erreur = await resoudre(outils, 'BIENVENUE20').catch((e) => e);
    expect(erreur).toBeInstanceOf(BadRequestException);
    expect(erreur.message).toBe('Ce code ne donne aucune réduction sur cette commande.');
  });

  it("le code promo passe avant un bon au même code", async () => {
    const outils = monterCoupons({ promos: [codePromo({ code: 'CN7K2XQ9' })], bons: [bon()] });
    expect((await resoudre(outils, 'CN7K2XQ9')).type).toBe('PROMO_CODE');
  });
});

describe("Moteur des codes promo : l'application ne change pas", () => {
  it("sans restaurant transmis (chemin de l'app), restaurant_ids n'est pas appliqué", async () => {
    const outils = monterCoupons({ promos: [codePromo({ restaurant_ids: [RESTAURANT_B] })] });
    const res = await outils.promoCodeService.applyPromoCode('BIENVENUE20', CLIENT, 8000, assiette(8000));
    expect(res.discountAmount).toBe(1600);
  });

  it("garde ses messages d'origine pour l'application", async () => {
    const promo = codePromo();
    const outils = monterCoupons({
      promos: [promo],
      usages: [{ id: 'u0', promo_code_id: promo.id, customer_id: CLIENT, status: PromoCodeUsageStatus.ACTIVE }],
    });
    await expect(
      outils.promoCodeService.applyPromoCode('BIENVENUE20', CLIENT, 8000, assiette(8000)),
    ).rejects.toThrow('Vous avez déjà utilisé ce code promo le nombre maximum de fois');
  });
});

describe('OrderCouponService.resoudre : bons', () => {
  it("accepte le bon du client : remise = solde ou articles, jamais la livraison", async () => {
    const outils = monterCoupons({ bons: [bon()] });
    const coupon = await resoudre(outils, 'cn7k2xq9', 8000);
    expect(coupon).toEqual(
      expect.objectContaining({
        type: 'VOUCHER',
        code: 'CN7K2XQ9',
        remise: 8000,
        bon: expect.objectContaining({ solde: 10_000, solde_apres: 2000 }),
      }),
    );
  });

  it('un solde inférieur au panier est pris en entier, arrondi sans le dépasser', async () => {
    const outils = monterCoupons({ bons: [bon({ remaining_amount: 1500.6 })] });
    const coupon = await resoudre(outils, 'CN7K2XQ9', 8000);
    expect(coupon.remise).toBe(1500);
  });

  it("refuse le bon d'un autre client (403)", async () => {
    const outils = monterCoupons({ bons: [bon({ customer_id: AUTRE_CLIENT })] });
    const erreur = await resoudre(outils, 'CN7K2XQ9').catch((e) => e);
    expect(erreur).toBeInstanceOf(ForbiddenException);
    expect(erreur.message).toBe('Ce bon appartient à un autre client.');
  });

  it.each([
    ['épuisé', { status: VoucherStatus.REDEEMED, remaining_amount: 0 }, 'Ce bon est épuisé.'],
    ['à solde nul', { remaining_amount: 0 }, 'Ce bon est épuisé.'],
    ['expiré', { expires_at: new Date(Date.now() - JOUR) }, 'Ce bon a expiré.'],
    ['annulé', { status: VoucherStatus.CANCELLED }, 'Ce bon a été annulé.'],
  ])('refuse un bon %s', async (_cas, surcharge, message) => {
    const outils = monterCoupons({ bons: [bon(surcharge)] });
    await expect(resoudre(outils, 'CN7K2XQ9')).rejects.toThrow(message);
  });

  it('un code inconnu : 404, ni code promo ni bon', async () => {
    const outils = monterCoupons({ bons: [bon({ entity_status: EntityStatus.DELETED })] });
    const erreur = await resoudre(outils, 'CN7K2XQ9').catch((e) => e);
    expect(erreur).toBeInstanceOf(NotFoundException);
    expect(erreur.message).toBe('Aucun code promo ni bon ne correspond à ce code.');
  });
});

describe('OrderCouponService.consommer', () => {
  it('débite le bon une seule fois quand deux commandes le prennent en même temps', async () => {
    const leBon = bon();
    const outils = monterCoupons({ bons: [leBon] });
    const coupon = await resoudre(outils, 'CN7K2XQ9', 8000);

    const resultats = await Promise.allSettled([
      outils.service.consommer(outils.prisma, { coupon, orderId: 'commande-1', customerId: CLIENT }),
      outils.service.consommer(outils.prisma, { coupon, orderId: 'commande-2', customerId: CLIENT }),
    ]);

    expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refus = resultats.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refus.reason.message).toMatch(/Le solde de ce bon a changé entre-temps/);
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(2000);
    expect(outils.base.redemption.lignes).toHaveLength(1);
  });

  it('passe le bon à REDEEMED quand il est vidé, avec la trace de la commande', async () => {
    const outils = monterCoupons({ bons: [bon({ remaining_amount: 5000 })] });
    const coupon = await resoudre(outils, 'CN7K2XQ9', 8000);
    const conso = await outils.service.consommer(outils.prisma, { coupon, orderId: 'commande-1', customerId: CLIENT });

    expect(conso).toEqual(expect.objectContaining({ type: 'VOUCHER', remise: 5000, soldeApres: 0 }));
    expect(outils.base.voucher.lignes[0].status).toBe(VoucherStatus.REDEEMED);
    expect(outils.base.redemption.lignes[0]).toEqual(
      expect.objectContaining({ order_id: 'commande-1', amount: 5000 }),
    );
  });

  it('code promo : verrou, usage ACTIVE au montant exact, compteur augmenté', async () => {
    const promo = codePromo();
    const outils = monterCoupons({ promos: [promo] });
    const coupon = await resoudre(outils, 'BIENVENUE20', 8000);
    await outils.service.consommer(outils.prisma, { coupon, orderId: 'commande-1', customerId: CLIENT });

    expect(outils.base.verrous[0]).toMatch(/FOR UPDATE/);
    expect(outils.base.promoCodeUsage.lignes).toEqual([
      expect.objectContaining({
        promo_code_id: promo.id,
        order_id: 'commande-1',
        discount_amount: 1600,
        status: PromoCodeUsageStatus.ACTIVE,
      }),
    ]);
    expect(outils.base.promoCode.lignes[0].usage_count).toBe(1);
  });

  it("code promo à usage unique : une seconde commande, vérifiée avant la première, est refusée à l'écriture", async () => {
    const promo = codePromo({ max_usage: 1, max_usage_per_user: 1 });
    const outils = monterCoupons({ promos: [promo] });
    const coupon = await resoudre(outils, 'BIENVENUE20', 8000);

    await outils.service.consommer(outils.prisma, { coupon, orderId: 'commande-1', customerId: CLIENT });
    await expect(
      outils.service.consommer(outils.prisma, { coupon, orderId: 'commande-2', customerId: CLIENT }),
    ).rejects.toThrow(/nombre maximum/);
    expect(outils.base.promoCodeUsage.lignes).toHaveLength(1);
  });

  it.each([
    ['plafond global de 1', { max_usage: 1, max_usage_per_user: null }, AUTRE_CLIENT, /nombre maximum d'utilisations/],
    ['une fois par client', { max_usage: null, max_usage_per_user: 1 }, CLIENT, /déjà utilisé ce code promo/],
  ])(
    'code promo (%s) : deux transactions SIMULTANÉES, le verrou fait passer la seconde après la première, qui est refusée',
    async (_cas, surcharge, clientDeLaSeconde, motif) => {
      const promo = codePromo(surcharge);
      const outils = monterCoupons({ promos: [promo] });
      const coupon = await resoudre(outils, 'BIENVENUE20', 8000);

      const resultats = await Promise.allSettled([
        outils.prisma.$transaction((tx: unknown) =>
          outils.service.consommer(tx as never, { coupon, orderId: 'commande-1', customerId: CLIENT }),
        ),
        outils.prisma.$transaction((tx: unknown) =>
          outils.service.consommer(tx as never, { coupon, orderId: 'commande-2', customerId: clientDeLaSeconde }),
        ),
      ]);

      expect(resultats.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect((resultats[1] as PromiseRejectedResult).reason.message).toMatch(motif);
      expect(outils.base.promoCodeUsage.lignes).toHaveLength(1);
      expect(outils.base.promoCode.lignes[0].usage_count).toBe(1);
    },
  );
});

describe('OrderCouponService.restituerPourCommande', () => {
  const COMMANDE = { id: 'commande-1', reference: 'CMD-1', customer_id: CLIENT, restaurant_id: RESTAURANT_A };

  function avecUtilisation(surchargeBon: Record<string, unknown> = {}) {
    const leBon = bon({ remaining_amount: 2000, ...surchargeBon });
    return monterCoupons({
      bons: [leBon],
      redemptions: [{ id: 'red-1', voucher_id: leBon.id, order_id: COMMANDE.id, amount: 8000, entity_status: EntityStatus.ACTIVE }],
      users: [{ id: 'agent-1', fullname: 'Adjoua', email: 'a@cn.ci', role: UserRole.CALL_CENTER }],
    });
  }

  it("recrédite le bon, le remet ACTIVE et prévient le client", async () => {
    const outils = avecUtilisation({ status: VoucherStatus.REDEEMED, remaining_amount: 0 });
    const res = await outils.service.restituerPourCommande(COMMANDE, {
      motif: 'ANNULATION',
      acteurId: 'agent-1',
      acteurRole: UserRole.CALL_CENTER,
    });

    const leBon = outils.base.voucher.lignes[0];
    expect(leBon.remaining_amount).toBe(8000);
    expect(leBon.status).toBe(VoucherStatus.ACTIVE);
    expect(leBon.redeemed_at).toBeNull();
    expect(outils.base.redemption.lignes[0].entity_status).toBe(EntityStatus.DELETED);
    expect(res.bons).toHaveLength(1);
    expect(outils.voucherService.notifierMouvementBon).toHaveBeenCalledWith(
      expect.objectContaining({ sens: 'CREDIT', montant: 8000, solde: 8000, reference: 'CMD-1', motif: 'ANNULATION' }),
    );
    expect(outils.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COUPON_RESTITUE',
        actor_id: 'agent-1',
        actor_name: 'Adjoua',
        entity_id: 'commande-1',
      }),
    );
  });

  it('est idempotente : un second appel (événement rejoué) ne recrédite rien', async () => {
    const outils = avecUtilisation();
    await outils.service.restituerPourCommande(COMMANDE, { motif: 'ANNULATION' });
    const second = await outils.service.restituerPourCommande(COMMANDE, { motif: 'ANNULATION' });

    expect(second.bons).toHaveLength(0);
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
  });

  it('deux restitutions simultanées ne recréditent qu’une fois', async () => {
    const outils = avecUtilisation();
    await Promise.all([
      outils.service.restituerPourCommande(COMMANDE, { motif: 'ANNULATION' }),
      outils.service.restituerPourCommande(COMMANDE, { motif: 'SUPPRESSION' }),
    ]);
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
  });

  it('prolonge de 30 jours un bon expiré entre-temps', async () => {
    const outils = avecUtilisation({
      status: VoucherStatus.EXPIRED,
      expires_at: new Date(Date.now() - 2 * JOUR),
    });
    const avant = Date.now();
    await outils.service.restituerPourCommande(COMMANDE, { motif: 'ANNULATION' });

    const leBon = outils.base.voucher.lignes[0];
    expect(leBon.status).toBe(VoucherStatus.ACTIVE);
    const jours = (leBon.expires_at.getTime() - avant) / JOUR;
    expect(jours).toBeGreaterThan(29.9);
    expect(jours).toBeLessThan(30.1);
    expect(outils.voucherService.notifierMouvementBon).toHaveBeenCalledWith(
      expect.objectContaining({ valableJusquau: leBon.expires_at }),
    );
  });

  it("un bon annulé reste annulé : solde rendu, pas de notification", async () => {
    const outils = avecUtilisation({ status: VoucherStatus.CANCELLED });
    await outils.service.restituerPourCommande(COMMANDE, { motif: 'ANNULATION' });

    expect(outils.base.voucher.lignes[0].status).toBe(VoucherStatus.CANCELLED);
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(outils.voucherService.notifierMouvementBon).not.toHaveBeenCalled();
  });

  it("désactive l'usage du code promo et décompte une seule fois", async () => {
    const promo = codePromo({ usage_count: 1 });
    const outils = monterCoupons({
      promos: [promo],
      usages: [
        {
          id: 'usage-1',
          promo_code_id: promo.id,
          customer_id: CLIENT,
          order_id: COMMANDE.id,
          discount_amount: 1600,
          status: PromoCodeUsageStatus.ACTIVE,
        },
      ],
    });

    const [a, b] = await Promise.all([
      outils.service.restituerPourCommande(COMMANDE, { motif: 'ANNULATION', acteurId: CLIENT }),
      outils.service.restituerPourCommande(COMMANDE, { motif: 'ANNULATION', acteurId: CLIENT }),
    ]);

    expect(outils.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.INACTIVE);
    expect(outils.base.promoCode.lignes[0].usage_count).toBe(0);
    expect(a.codesPromo.length + b.codesPromo.length).toBe(1);
    // Annulation par le client : pas d'agent au journal.
    expect(outils.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COUPON_RESTITUE',
        actor_id: null,
        summary: expect.stringContaining('(par le client)'),
      }),
    );
  });

  it('rend aussi l’usage d’un code promo désactivé entre-temps par un administrateur', async () => {
    const promo = codePromo({ usage_count: 3, is_active: false });
    const outils = monterCoupons({
      promos: [promo],
      usages: [
        {
          id: 'usage-1',
          promo_code_id: promo.id,
          customer_id: CLIENT,
          order_id: COMMANDE.id,
          discount_amount: 1600,
          status: PromoCodeUsageStatus.ACTIVE,
        },
      ],
    });
    const res = await outils.service.restituerPourCommande(COMMANDE, { motif: 'SUPPRESSION' });

    expect(res.codesPromo).toEqual([{ promoCodeId: promo.id, code: 'BIENVENUE20', montant: 1600 }]);
    expect(outils.base.promoCodeUsage.lignes[0].status).toBe(PromoCodeUsageStatus.INACTIVE);
    expect(outils.base.promoCode.lignes[0].usage_count).toBe(2);
    // Le code reste désactivé : rendre l'usage ne le réactive pas.
    expect(outils.base.promoCode.lignes[0].is_active).toBe(false);
  });

  it("une commande sans coupon ne laisse aucune trace", async () => {
    const outils = monterCoupons();
    const res = await outils.service.restituerPourCommande(COMMANDE, { motif: 'ANNULATION' });
    expect(res).toEqual({ bons: [], codesPromo: [] });
    expect(outils.auditService.record).not.toHaveBeenCalled();
  });
});

describe('OrderCouponService.apercu et bons du client', () => {
  const agent = (type: UserType, restaurant_id: string | null = null) =>
    ({ id: 'agent-1', role: type === UserType.RESTAURANT ? UserRole.CAISSIER : UserRole.CALL_CENTER, type, restaurant_id }) as unknown as User;

  const dto = (surcharge: Record<string, unknown> = {}) => ({
    code: 'BIENVENUE20',
    customer_id: CLIENT,
    restaurant_id: RESTAURANT_A,
    type: OrderType.PICKUP,
    items: [{ dish_id: PLAT, quantity: 2, epice: false }],
    ...surcharge,
  });

  it('recalcule le panier côté serveur et renvoie la forme lue par l’écran', async () => {
    const outils = monterCoupons({ promos: [codePromo({ max_discount_amount: 1000 })], plats: [plat()] });
    const reponse = await outils.service.apercu(agent(UserType.BACKOFFICE), dto() as any);

    expect(reponse).toEqual({
      type: 'PROMO_CODE',
      code: 'BIENVENUE20',
      remise: 1000,
      sous_total: 8000,
      total_articles_apres_remise: 7000,
      libelle: expect.stringContaining('20 % sur la commande'),
      code_promo: expect.objectContaining({
        discount_type: DiscountType.PERCENTAGE,
        discount_value: 20,
        max_discount_amount: 1000,
        min_order_amount: 0,
        target_type: TargetType.ALL_PRODUCTS,
        expiration_date: expect.any(Date),
      }),
    });
  });

  it('pour un bon : solde avant et après', async () => {
    const outils = monterCoupons({ bons: [bon()], plats: [plat()] });
    const reponse: any = await outils.service.apercu(agent(UserType.BACKOFFICE), dto({ code: 'CN7K2XQ9' }) as any);
    expect(reponse).toEqual(
      expect.objectContaining({
        type: 'VOUCHER',
        remise: 8000,
        libelle: "Bon d'achat",
        bon: { solde: 10_000, solde_apres: 2000, expire_le: expect.any(Date) },
      }),
    );
  });

  it("n'écrit rien", async () => {
    const outils = monterCoupons({ bons: [bon()], plats: [plat()] });
    await outils.service.apercu(agent(UserType.BACKOFFICE), dto({ code: 'CN7K2XQ9' }) as any);
    expect(outils.base.voucher.lignes[0].remaining_amount).toBe(10_000);
    expect(outils.base.redemption.create).not.toHaveBeenCalled();
    expect(outils.base.promoCodeUsage.create).not.toHaveBeenCalled();
  });

  it("interdit à un caissier de viser un autre restaurant, avant tout calcul", async () => {
    const outils = monterCoupons({ promos: [codePromo()], plats: [plat()] });
    await expect(
      outils.service.apercu(agent(UserType.RESTAURANT, RESTAURANT_B), dto() as any),
    ).rejects.toThrow(ForbiddenException);
    expect(outils.orderHelper.getDishesWithDetails).not.toHaveBeenCalled();
  });

  it('laisse le caissier vérifier un code pour son restaurant', async () => {
    const outils = monterCoupons({ promos: [codePromo()], plats: [plat()] });
    await expect(
      outils.service.apercu(agent(UserType.RESTAURANT, RESTAURANT_A), dto() as any),
    ).resolves.toEqual(expect.objectContaining({ remise: 1600 }));
  });

  it('liste les bons utilisables du client, code masqué, jamais le code complet', async () => {
    const outils = monterCoupons({
      bons: [
        bon({ code: 'CN7K2XQ9' }),
        bon({ code: 'CNAAAAAA', status: VoucherStatus.REDEEMED, remaining_amount: 0 }),
        bon({ code: 'CNBBBBBB', customer_id: AUTRE_CLIENT }),
        bon({ code: 'CNCCCCCC', expires_at: new Date(Date.now() - JOUR) }),
      ],
    });
    const { data } = await outils.service.listerBonsClient(agent(UserType.BACKOFFICE), CLIENT);

    expect(data).toEqual([
      {
        id: expect.any(String),
        code_masque: 'CN••••Q9',
        solde: 10_000,
        montant_initial: 10_000,
        expire_le: expect.any(Date),
      },
    ]);
    expect(JSON.stringify(data)).not.toContain('CN7K2XQ9');
  });
});
