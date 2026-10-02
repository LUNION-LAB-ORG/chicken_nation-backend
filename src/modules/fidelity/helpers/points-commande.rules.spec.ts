/**
 * Remise en points à la création d'une commande, et points qu'elle coûte.
 * Règle pure partagée par create-v2 (appli, site) et create (personnel).
 */
import { EntityStatus, LoyaltyPointType, OrderStatus } from '@prisma/client';
import {
  calculerRemiseFidelite,
  plafondRemiseFidelite,
  pointsEngagesWhere,
  pointsRetiresNets,
  libelleRestitution,
  libelleRendusExpires,
  DEBUT_POINTS_ENGAGES,
  TYPES_POINTS_DEPENSABLES,
  ReglagesPoints,
} from './points-commande.rules';

const REGLAGES: ReglagesPoints = {
  minimum_redemption_points: 100,
  point_value_in_xof: 20,
  max_redemption_pct: 50,
};

const remise = (
  pointsDemandes: number,
  assiette: number,
  surcharge: Partial<Parameters<typeof calculerRemiseFidelite>[0]> = {},
) =>
  calculerRemiseFidelite({
    pointsDemandes,
    soldeDisponible: 10_000,
    assiette,
    reglages: REGLAGES,
    ...surcharge,
  });

describe('plafondRemiseFidelite', () => {
  it('50 % de l’assiette, arrondi au franc inférieur', () => {
    expect(plafondRemiseFidelite(4000, 50)).toBe(2000);
    expect(plafondRemiseFidelite(4001, 50)).toBe(2000);
  });

  it('0, absent ou au moins 100 : borné à l’assiette, plus jamais au-delà', () => {
    expect(plafondRemiseFidelite(4000, 0)).toBe(4000);
    expect(plafondRemiseFidelite(4000, null)).toBe(4000);
    expect(plafondRemiseFidelite(4000, 100)).toBe(4000);
    expect(plafondRemiseFidelite(4000, 150)).toBe(4000);
  });

  it('assiette nulle ou négative : aucune remise possible', () => {
    expect(plafondRemiseFidelite(0, 50)).toBe(0);
    expect(plafondRemiseFidelite(-500, 0)).toBe(0);
  });
});

describe('calculerRemiseFidelite', () => {
  it('sans plafond atteint : remise pleine, points demandés', () => {
    expect(remise(150, 10_000)).toEqual({ remise: 3000, points: 150 });
  });

  it('plafonnée : la commande enregistre les points de la remise accordée, pas ceux demandés', () => {
    // Exemple de l’analyse : 4 000 F, 150 points, plafond 50 % = 2 000 F = 100 points.
    expect(remise(150, 4000)).toEqual({ remise: 2000, points: 100 });
  });

  it('arrondit au point supérieur ce que la remise coûte', () => {
    // Plafond 2 510 F, à 20 F le point : 125,5 points, donc 126.
    expect(remise(200, 5020)).toEqual({ remise: 2510, points: 126 });
  });

  it('jamais moins que le minimum : redeemPoints refuserait, et la remise serait offerte', () => {
    // Plafond 1 800 F = 90 points, sous le minimum de 100.
    expect(remise(150, 3600)).toEqual({ remise: 1800, points: 100 });
  });

  it('plafond à 0 ou au moins 100 : jamais plus que l’assiette', () => {
    const sansPlafond = { ...REGLAGES, max_redemption_pct: 0 };
    expect(remise(300, 4000, { reglages: sansPlafond })).toEqual({ remise: 4000, points: 200 });
    const cent = { ...REGLAGES, max_redemption_pct: 100 };
    expect(remise(300, 4000, { reglages: cent })).toEqual({ remise: 4000, points: 200 });
  });

  it('sous le minimum : rien, sans erreur (comportement de l’application conservé)', () => {
    expect(remise(99, 10_000)).toEqual({ remise: 0, points: 0 });
  });

  it('au-delà du solde DISPONIBLE : rien, sans erreur', () => {
    expect(remise(150, 10_000, { soldeDisponible: 149 })).toEqual({ remise: 0, points: 0 });
    expect(remise(150, 10_000, { soldeDisponible: 150 })).toEqual({ remise: 3000, points: 150 });
  });

  it('aucun point demandé, ou valeur du point nulle : rien', () => {
    expect(remise(0, 10_000)).toEqual({ remise: 0, points: 0 });
    expect(remise(150, 10_000, { reglages: { ...REGLAGES, point_value_in_xof: 0 } })).toEqual({
      remise: 0,
      points: 0,
    });
  });

  it('une promotion déjà prise : les points ne couvrent que ce qu’elle laisse', () => {
    // 4 000 F, plafond 2 000 F, promotion de 3 000 F : il reste 1 000 F, 50 points,
    // relevés au minimum de 100.
    expect(remise(150, 4000, { autresRemises: 3000 })).toEqual({ remise: 1000, points: 100 });
    // Promotion qui couvre tout : aucun point retiré.
    expect(remise(150, 4000, { autresRemises: 4000 })).toEqual({ remise: 0, points: 0 });
  });

  it('valeur du point décimale : pas d’erreur d’arrondi des flottants', () => {
    const decimale = { ...REGLAGES, point_value_in_xof: 0.7, minimum_redemption_points: 1 };
    // Plafond 21 F ; 21 / 0,7 vaut 30.000000000000004 en flottant : 30 points, pas 31.
    expect(remise(100, 42, { reglages: decimale })).toEqual({ remise: 21, points: 30 });
  });
});

describe('pointsEngagesWhere', () => {
  it('commandes payées ou confirmées depuis le 02/10, non annulées, non supprimées, sans retrait enregistré', () => {
    expect(pointsEngagesWhere('client-1')).toEqual({
      customer_id: 'client-1',
      created_at: { gte: DEBUT_POINTS_ENGAGES },
      points: { gt: 0 },
      entity_status: { not: EntityStatus.DELETED },
      status: { not: OrderStatus.CANCELLED },
      OR: [{ paied: true }, { status: { not: OrderStatus.PENDING } }],
      loyalty_points: { none: { type: LoyaltyPointType.REDEEMED } },
    });
  });

  it("les anciennes commandes jamais déduites ne baissent pas le solde utilisable (réconciliation à part)", () => {
    expect(DEBUT_POINTS_ENGAGES.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });
});

describe('points rendus (REFUNDED)', () => {
  const ligne = (type: LoyaltyPointType, points: number) => ({ type, points });

  it('points encore retirés : retraits moins points rendus, jamais négatif', () => {
    expect(pointsRetiresNets([])).toBe(0);
    expect(pointsRetiresNets([ligne(LoyaltyPointType.REDEEMED, 150)])).toBe(150);
    expect(
      pointsRetiresNets([ligne(LoyaltyPointType.REDEEMED, 150), ligne(LoyaltyPointType.REFUNDED, 150)]),
    ).toBe(0);
    // Reprise puis nouveau retrait : de nouveau déduite.
    expect(
      pointsRetiresNets([
        ligne(LoyaltyPointType.REDEEMED, 150),
        ligne(LoyaltyPointType.REFUNDED, 150),
        ligne(LoyaltyPointType.REDEEMED, 150),
      ]),
    ).toBe(150);
    // Les gains, bonus et expirations de la commande n'entrent pas dans le calcul.
    expect(
      pointsRetiresNets([
        ligne(LoyaltyPointType.EARNED, 60),
        ligne(LoyaltyPointType.BONUS, 150),
        ligne(LoyaltyPointType.EXPIRED, 60),
      ]),
    ).toBe(0);
    expect(pointsRetiresNets([ligne(LoyaltyPointType.REFUNDED, 150)])).toBe(0);
  });

  it('dépensables et soumis à l’expiration comme les gains et les bonus', () => {
    expect(TYPES_POINTS_DEPENSABLES).toEqual([
      LoyaltyPointType.EARNED,
      LoyaltyPointType.BONUS,
      LoyaltyPointType.REFUNDED,
    ]);
  });

  it('libellés tels que l’historique les affiche (la reprise SQL compare le premier à l’identique)', () => {
    expect(libelleRestitution(150, 'ORD-261002-1')).toBe('150 points rendus : commande #ORD-261002-1 annulée');
    expect(libelleRendusExpires(50, 'ORD-261002-1')).toBe('50 points rendus expirés : commande #ORD-261002-1');
    expect(libelleRendusExpires(50, null)).toBe('50 points rendus expirés');
  });
});
