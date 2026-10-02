/**
 * Points utilisés sur une commande (02/10) :
 *  - retrait idempotent par commande, y compris quand deux retraits se
 *    croisent (le second relit le premier sous verrou) ;
 *  - aucun retrait sur une commande annulée ;
 *  - restitution à l'annulation, une seule fois, et rien pour une commande
 *    jamais déduite ;
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
    outils.prisma.loyaltyPoint.findFirst.mockResolvedValueOnce(null);

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

  it('rend exactement les points retirés, avec un libellé clair, une seule fois', async () => {
    const outils = await commandeDeduiteAnnulee();

    const premier = await outils.service.rendrePointsUtilises(COMMANDE);
    const second = await outils.service.rendrePointsUtilises(COMMANDE);

    expect(premier).toEqual({ points_rendus: 150 });
    expect(second).toEqual({ points_rendus: 0 });
    expect(outils.solde()).toBe(400);

    // La ligne de retrait ne compte plus comme utilisée.
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(0);
    const annule = outils.tables.loyaltyPoint.find((l) => l.order_id === COMMANDE);
    expect(annule).toEqual(
      expect.objectContaining({
        type: LoyaltyPointType.EXPIRED,
        reason: '150 points utilisés pour la commande #ORD-261002-1, annulée',
      }),
    );

    // Un seul crédit, dépensable, non rattaché à la commande.
    const credits = outils.lignesDe(LoyaltyPointType.BONUS);
    expect(credits).toHaveLength(1);
    expect(credits[0]).toEqual(
      expect.objectContaining({
        points: 150,
        order_id: null,
        is_used: LoyaltyPointIsUsed.NO,
        reason: '150 points rendus : commande #ORD-261002-1 annulée',
      }),
    );
    expect(credits[0].expires_at).toBeInstanceOf(Date);
    expect(outils.appGateway.emitToUser).toHaveBeenCalledWith(
      CLIENT,
      'customer',
      'loyalty:points_added',
      expect.objectContaining({ points: 150, type: LoyaltyPointType.BONUS }),
    );
  });

  it('les points rendus se dépensent sur une nouvelle commande', async () => {
    const outils = await commandeDeduiteAnnulee();
    await outils.service.rendrePointsUtilises(COMMANDE);
    const autre = '22222222-2222-4222-8222-222222222222';
    outils.tables.order.push(commande({ id: autre, reference: 'ORD-261002-2', points: 400 }));

    await outils.service.redeemPoints({ customer_id: CLIENT, points: 400, order_id: autre, reason: 'x' });

    expect(outils.solde()).toBe(0);
    expect(outils.lignesDe(LoyaltyPointType.BONUS)[0].is_used).toBe(LoyaltyPointIsUsed.YES);
  });

  it('panier jamais déduit (non payé) annulé : rien à rendre', async () => {
    const outils = monterFidelite({
      solde: 400,
      commandes: [commande({ status: OrderStatus.CANCELLED, paied: false })],
    });

    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 0 });
    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.BONUS)).toHaveLength(0);
    expect(outils.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('commande déduite mais pas annulée : rien à rendre', async () => {
    const outils = monterFidelite({ solde: 400 });
    await retirer(outils);

    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 0 });
    expect(outils.solde()).toBe(250);
  });

  it('commande réactivée entre la lecture et la restitution : retrait gardé, rien rendu', async () => {
    const outils = await commandeDeduiteAnnulee();
    const lire = outils.prisma.loyaltyPoint.findFirst.getMockImplementation()!;
    // La lecture voit encore l'annulation ; la réactivation tombe juste après.
    outils.prisma.loyaltyPoint.findFirst.mockImplementationOnce(async (args) => {
      const ligne = await lire(args);
      outils.tables.order[0].status = OrderStatus.ACCEPTED;
      return ligne;
    });

    expect(await outils.service.rendrePointsUtilises(COMMANDE)).toEqual({ points_rendus: 0 });
    expect(outils.solde()).toBe(250);
    expect(outils.lignesDe(LoyaltyPointType.REDEEMED)).toHaveLength(1);
    expect(outils.lignesDe(LoyaltyPointType.BONUS)).toHaveLength(0);
  });

  it('restitution puis annulation rejouée : la révocation des gains ne reprend pas le crédit', async () => {
    const outils = await commandeDeduiteAnnulee();
    await outils.service.rendrePointsUtilises(COMMANDE);

    await outils.service.revokeEarnedPointsForOrder(COMMANDE, 'annulée');

    expect(outils.solde()).toBe(400);
    expect(outils.lignesDe(LoyaltyPointType.BONUS)).toHaveLength(1);
  });

  it('commande rendue puis reprise (plus annulée) : de nouveau déduite', async () => {
    const outils = await commandeDeduiteAnnulee();
    await outils.service.rendrePointsUtilises(COMMANDE);
    outils.tables.order[0].status = OrderStatus.ACCEPTED;

    const resultat = await retirer(outils);

    expect(resultat).not.toEqual(expect.objectContaining({ already_redeemed: true }));
    expect(outils.solde()).toBe(250);
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
