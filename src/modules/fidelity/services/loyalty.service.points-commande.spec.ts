/**
 * Points utilisés sur une commande (02/10) :
 *  - retrait idempotent par commande, y compris quand deux retraits se
 *    croisent (le second relit le premier sous verrou) ;
 *  - aucun retrait sur une commande annulée ;
 *  - restitution à l'annulation (03/10 : ligne REFUNDED rattachée à la
 *    commande, ligne de retrait intacte), une seule fois, et rien pour une
 *    commande jamais déduite ;
 *  - points rendus : dépensables, soumis à l'expiration, jamais repris par
 *    la révocation des gains, hors niveau et lifetime_points ;
 *  - points engagés : déduits du solde utilisable.
 *
 * LoyaltyService RÉEL sur une base en mémoire.
 */
import { LoyaltyPointIsUsed, LoyaltyPointType, OrderStatus } from '@prisma/client';
import { CLIENT, COMMANDE, commande, gain, monterFidelite } from './loyalty.base-simulee-spec';

const retirer = (outils: ReturnType<typeof monterFidelite>, points = 150) =>
  outils.service.redeemPoints({
    customer_id: CLIENT,
    points,
    order_id: COMMANDE,
    reason: `🔥 ${points} points utilisés pour la commande #ORD-261002-1`,
  });

describe('LoyaltyService.redeemPoints : retrait lié à une commande', () => {
  it('retire une fois : ligne REDEEMED, solde débité, points gagnés consommés', async () => {
    const outils = monterFidelite({ solde: 400 });

    const resultat = await retirer(outils);

    expect(resultat).toEqual(expect.objectContaining({ total_points_used: 150 }));
    expect(outils.solde()).toBe(250);
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(1);
    expect(outils.lignesDe(LoyaltyPointType.EARNED)[0]).toEqual(
      expect.objectContaining({ points_used: 150, is_used: LoyaltyPointIsUsed.PARTIAL }),
    );
  });

  it('rejoué (paiement, acceptation, clôture) : aucun second débit', async () => {
    const outils = monterFidelite({ solde: 400 });

    await retirer(outils);
    const second = await retirer(outils);
    const troisieme = await retirer(outils);

    expect(second).toEqual(expect.objectContaining({ already_redeemed: true }));
    expect(troisieme).toEqual(expect.objectContaining({ already_redeemed: true }));
    expect(outils.solde()).toBe(250);
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(1);
  });

  it('retrait concurrent déjà validé, invisible à la première lecture : relu sous verrou, rien débité', async () => {
    // Un autre serveur vient de retirer ces points pour cette commande.
    const outils = monterFidelite({
      solde: 250,
      lignes: [
        gain(400, { points_used: 150, is_used: LoyaltyPointIsUsed.PARTIAL }),
        gain(150, {
          type: LoyaltyPointType.REDEEMED,
          order_id: COMMANDE,
          points_used: 150,
          is_used: LoyaltyPointIsUsed.YES,
        }),
      ],
    });
    // Lecture hors transaction faite AVANT que l'autre ne valide.
    outils.prisma.loyaltyPoint.findMany.mockResolvedValueOnce([]);

    const resultat = await retirer(outils);

    expect(resultat).toEqual(expect.objectContaining({ already_redeemed: true }));
    // Débit de tête annulé avec la transaction.
    expect(outils.solde()).toBe(250);
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(1);
    expect(outils.lignesDe(LoyaltyPointType.EARNED)[0].points_used).toBe(150);
    expect(outils.loyaltyEvent.redeemPointsEvent).not.toHaveBeenCalled();
  });

  it('commande annulée : aucun retrait, solde intact', async () => {
    const outils = monterFidelite({ solde: 400, commandes: [commande({ status: OrderStatus.CANCELLED })] });

    const resultat = await retirer(outils);

    expect(resultat).toEqual(expect.objectContaining({ commande_annulee: true, total_points_used: 0 }));
    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(0);
    expect(outils.lignesDe(LoyaltyPointType.EARNED)[0].points_used).toBe(0);
  });

  it('solde insuffisant : refusé, rien écrit', async () => {
    const outils = monterFidelite({ solde: 120 });

    await expect(retirer(outils)).rejects.toThrow('Points insuffisants');
    expect(outils.solde()).toBe(120);
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(0);
  });
});

describe('LoyaltyService.rendrePointsUtilises : annulation', () => {
  /** Commande payée, points retirés, puis annulée. */
  async function commandeDeduiteAnnulee() {
    const outils = monterFidelite({ solde: 400 });
    await retirer(outils);
    outils.tables.order[0].status = OrderStatus.CANCELLED;
    return outils;
  }

  it('rend exactement les points retirés : une ligne REFUNDED rattachée à la commande, le retrait intact', async () => {
    const outils = await commandeDeduiteAnnulee();
    const retrait = { ...outils.lignesDe(LoyaltyPointType.REDEEMED)[0] };

    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 150 });
    expect(outils.solde()).toBe(400);

    // La dépense reste une dépense : ni son type, ni sa raison, ni rien d'autre ne bouge.
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toEqual([retrait]);
    expect(retrait.reason).toBe('🔥 150 points utilisés pour la commande #ORD-261002-1');

    const rendus = outils.lignesDe(LoyaltyPointType.REFUNDED);
    expect(rendus).toHaveLength(1);
    expect(rendus[0]).toEqual(
      expect.objectContaining({
        customer_id: CLIENT,
        order_id: COMMANDE,
        points: 150,
        points_used: 0,
        is_used: LoyaltyPointIsUsed.NO,
        reason: '150 points rendus : commande #ORD-261002-1 annulée',
      }),
    );
    expect(rendus[0].expires_at).toBeInstanceOf(Date);

    // Plus de ligne « expirée » ni de « bonus » pour un remboursement.
    expect(outils.lignesDe(LoyaltyPointType.EXPIRED)).toHaveLength(0);
    expect(outils.lignesDe(LoyaltyPointType.BONUS)).toHaveLength(0);
    expect(outils.appGateway.emitToUser).toHaveBeenCalledWith(
      CLIENT,
      'customer',
      'loyalty:points_added',
      expect.objectContaining({ points: 150, type: LoyaltyPointType.REFUNDED }),
    );
  });

  it('une seule fois, même si l’annulation est rejouée', async () => {
    const outils = await commandeDeduiteAnnulee();

    const premier = await outils.service.rendrePointsUtilises(COMMANDE);
    const second = await outils.service.rendrePointsUtilises(COMMANDE);
    const troisieme = await outils.service.rendrePointsUtilises(COMMANDE);

    expect(premier).toEqual({ points_rendus: 150 });
    expect(second).toEqual({ points_rendus: 0 });
    expect(troisieme).toEqual({ points_rendus: 0 });
    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)).toHaveLength(1);
  });

  it('deux restitutions simultanées : la seconde relit la première sous verrou, aucun double crédit', async () => {
    const outils = await commandeDeduiteAnnulee();
    // Lecture hors transaction de la seconde, faite AVANT que la première ne valide.
    const avant = outils.tables.loyaltyPoint.map((l) => ({ ...l }));
    await outils.service.rendrePointsUtilises(COMMANDE);
    outils.prisma.loyaltyPoint.findMany.mockResolvedValueOnce(
      avant.filter((l) => l.order_id === COMMANDE && l.type === LoyaltyPointType.REDEEMED),
    );

    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 0 });

    // Crédit de tête annulé avec la transaction.
    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)).toHaveLength(1);
    expect(outils.appGateway.emitToUser).toHaveBeenCalledTimes(2); // retrait, puis une seule restitution
  });

  it('panier jamais déduit (non payé) annulé : rien à rendre', async () => {
    const outils = monterFidelite({
      solde: 400,
      commandes: [commande({ status: OrderStatus.CANCELLED, paied: false })],
    });

    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 0 });
    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)).toHaveLength(0);
    expect(outils.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('commande déduite mais pas annulée : rien à rendre', async () => {
    const outils = monterFidelite({ solde: 400 });
    await retirer(outils);

    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 0 });
    expect(outils.solde()).toBe(250);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)).toHaveLength(0);
  });

  it('commande réactivée entre la lecture et la restitution : retrait gardé, rien rendu', async () => {
    const outils = await commandeDeduiteAnnulee();
    const lire = outils.prisma.order.findUnique.getMockImplementation()!;
    // La lecture voit encore l'annulation ; la réactivation tombe juste après.
    outils.prisma.order.findUnique.mockImplementationOnce(async (args) => {
      const ligne = await lire(args);
      outils.tables.order[0].status = OrderStatus.ACCEPTED;
      return ligne;
    });

    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 0 });
    expect(outils.solde()).toBe(250);
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(1);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)).toHaveLength(0);
  });

  it('les points rendus se dépensent sur une nouvelle commande', async () => {
    const outils = await commandeDeduiteAnnulee();
    await outils.service.rendrePointsUtilises(COMMANDE);
    const autre = '22222222-2222-4222-8222-222222222222';
    outils.tables.order.push(commande({ id: autre, reference: 'ORD-261002-2', points: 400 }));

    const resultat = await outils.service.redeemPoints({
      customer_id: CLIENT,
      points: 400,
      order_id: autre,
      reason: 'x',
    });

    expect(outils.solde()).toBe(0);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)[0]).toEqual(
      expect.objectContaining({ points_used: 150, is_used: LoyaltyPointIsUsed.YES }),
    );
    expect(resultat.used_points_details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: LoyaltyPointType.REFUNDED, points_used: 150 }),
      ]),
    );
  });

  it('la révocation des gains de la commande annulée ne reprend jamais les points rendus', async () => {
    // La commande a aussi rapporté 60 points, gagnés au paiement.
    const outils = monterFidelite({
      solde: 460,
      lignes: [gain(400), gain(60, { order_id: COMMANDE })],
    });
    await retirer(outils);
    outils.tables.order[0].status = OrderStatus.CANCELLED;
    await outils.service.rendrePointsUtilises(COMMANDE);
    expect(outils.solde()).toBe(460);

    const revocation = await outils.service.revokeEarnedPointsForOrder(COMMANDE, 'annulée');
    await outils.service.revokeEarnedPointsForOrder(COMMANDE, 'annulée');

    // Seul le gain de la commande est repris.
    expect(revocation).toEqual({ revoked_records: 1, points_revoked: 60 });
    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)).toEqual([
      expect.objectContaining({ points: 150, is_used: LoyaltyPointIsUsed.NO, points_used: 0 }),
    ]);
  });

  it('ne compte ni pour le niveau ni pour lifetime_points', async () => {
    const outils = await commandeDeduiteAnnulee();
    // 650 points de statut : 150 de plus franchiraient le seuil VIP (700).
    Object.assign(outils.tables.customer[0], { status_points: 650, lifetime_points: 400 });

    await outils.service.rendrePointsUtilises(COMMANDE);

    expect(outils.tables.customer[0]).toEqual(
      expect.objectContaining({
        total_points: 400,
        lifetime_points: 400,
        status_points: 650,
        loyalty_level: 'STANDARD',
      }),
    );
    expect(outils.prisma.loyaltyLevelHistory.create).not.toHaveBeenCalled();
    expect(outils.loyaltyEvent.levelUpEvent).not.toHaveBeenCalled();
    expect(outils.loyaltyEvent.addPointsEvent).not.toHaveBeenCalled();
  });

  it('commande rendue puis reprise (plus annulée) : de nouveau déduite, puis rendue à une nouvelle annulation', async () => {
    const outils = await commandeDeduiteAnnulee();
    await outils.service.rendrePointsUtilises(COMMANDE);
    outils.tables.order[0].status = OrderStatus.ACCEPTED;

    const resultat = await retirer(outils);
    const rejeu = await retirer(outils);

    expect(resultat).not.toEqual(expect.objectContaining({ already_redeemed: true }));
    expect(rejeu).toEqual(expect.objectContaining({ already_redeemed: true }));
    expect(outils.solde()).toBe(250);

    outils.tables.order[0].status = OrderStatus.CANCELLED;
    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 150 });
    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 0 });
    expect(outils.solde()).toBe(400);
  });

  it('retrait tardif (paiement, clôture) sur la commande remboursée : rien de repris', async () => {
    const outils = await commandeDeduiteAnnulee();
    await outils.service.rendrePointsUtilises(COMMANDE);

    const resultat = await retirer(outils);

    expect(resultat).toEqual(expect.objectContaining({ commande_annulee: true, total_points_used: 0 }));
    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(1);
  });
});

describe('LoyaltyService.expirePoints : points rendus', () => {
  it('expirent comme les autres, mais la ligne reste REFUNDED : une annulation rejouée ne rend rien de plus', async () => {
    const outils = monterFidelite({ solde: 400 });
    await retirer(outils);
    outils.tables.order[0].status = OrderStatus.CANCELLED;
    await outils.service.rendrePointsUtilises(COMMANDE);
    // 100 des 150 points rendus dépensés, puis la date d'expiration passe.
    const rendus = outils.lignesDe(LoyaltyPointType.REFUNDED)[0];
    Object.assign(rendus, {
      points_used: 100,
      is_used: LoyaltyPointIsUsed.PARTIAL,
      expires_at: new Date(Date.now() - 1000),
    });

    const resultat = await outils.service.expirePoints();

    expect(resultat.total_points_expired).toBe(50);
    expect(outils.solde()).toBe(350);
    expect(outils.lignesDe(LoyaltyPointType.REFUNDED)).toEqual([
      expect.objectContaining({ points: 150, points_used: 100, is_used: LoyaltyPointIsUsed.YES }),
    ]);
    expect(outils.lignesDe(LoyaltyPointType.EXPIRED)).toEqual([
      expect.objectContaining({
        order_id: COMMANDE,
        points: 50,
        is_used: LoyaltyPointIsUsed.YES,
        reason: '50 points rendus expirés : commande #ORD-261002-1',
      }),
    ]);

    // Rejeu de l'annulation bien plus tard : déjà remboursée.
    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 0 });
    expect(await outils.service.expirePoints()).toEqual({ expired_point_records: 0, total_points_expired: 0 });
    expect(outils.solde()).toBe(350);
  });
});

describe('LoyaltyService.getLoyaltyStats : points utilisés', () => {
  it('les points rendus après annulation ne comptent plus comme utilisés', async () => {
    const outils = await (async () => {
      const o = monterFidelite({ solde: 400 });
      await retirer(o);
      o.tables.order[0].status = OrderStatus.CANCELLED;
      await o.service.rendrePointsUtilises(COMMANDE);
      return o;
    })();
    // Une autre commande, déduite et servie : 100 points utilisés pour de bon.
    outils.tables.loyaltyPoint.push(
      gain(100, { type: LoyaltyPointType.REDEEMED, order_id: 'autre', is_used: LoyaltyPointIsUsed.YES }),
    );
    const somme = (where: Record<string, unknown>) => {
      const lignes = outils.tables.loyaltyPoint.filter((l) => l.type === where.type);
      return { _sum: { points: lignes.length ? lignes.reduce((s, l) => s + l.points, 0) : null } };
    };
    Object.assign(outils.prisma.loyaltyPoint, {
      aggregate: jest.fn(async ({ where }) => somme(where)),
    });
    Object.assign(outils.prisma.customer, {
      aggregate: jest.fn().mockResolvedValue({ _sum: { total_points: 400, lifetime_points: 400 } }),
      count: jest.fn().mockResolvedValue(1),
    });

    const stats = await outils.service.getLoyaltyStats();

    expect(stats.points_redeemed).toBe(100);
    expect(stats.points_redeemed_xof).toBe(2000);
  });
});

describe('LoyaltyService : points engagés', () => {
  it('compte les commandes payées sans retrait, pas les paniers ni les annulées ni les déduites', async () => {
    const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
    const outils = monterFidelite({
      solde: 1000,
      commandes: [
        commande({ id: id(1), points: 150 }), // payée, pas déduite : engagée
        commande({ id: id(2), points: 100, status: OrderStatus.PENDING, paied: false }), // panier
        commande({ id: id(3), points: 200, status: OrderStatus.CANCELLED }), // annulée
        commande({ id: id(4), points: 120, status: OrderStatus.COMPLETED, paied: false }), // confirmée
        commande({ id: id(5), points: 300 }), // déduite
        commande({ id: id(6), points: 0 }),
        commande({ id: id(7), points: 50, entity_status: 'DELETED' }),
        // Ancienne commande jamais déduite (avant la règle) : relève de la réconciliation.
        commande({ id: id(8), points: 400, created_at: new Date('2026-07-10T12:00:00Z') }),
      ],
      lignes: [gain(1000), gain(300, { type: LoyaltyPointType.REDEEMED, order_id: id(5) })],
    });

    expect(await outils.service.pointsEngages(CLIENT)).toBe(270);
  });

  it('solde utilisable exposé au client : solde moins points engagés', async () => {
    const outils = monterFidelite({ solde: 400 });
    // Le service lit la fiche complète : on greffe ce qu'il en attend.
    outils.prisma.customer.findUnique.mockResolvedValueOnce({
      id: CLIENT,
      total_points: 400,
      lifetime_points: 400,
      status_points: 0,
      loyalty_level: 'STANDARD',
      loyalty_points: [],
      loyalty_level_history: [],
    });
    (outils.prisma.loyaltyPoint as Record<string, unknown>).groupBy = jest.fn().mockResolvedValue([]);

    const info = await outils.service.getCustomerLoyaltyInfo(CLIENT);

    expect(info.total_points).toBe(400);
    expect(info.redeemable_points).toBe(250);
  });
});
