/**
 * Conditions de commande publiques (GET /orders/conditions-commande).
 *
 * La grille publiée doit être EXACTEMENT celle que `priceForDistance`
 * facture : le dernier bloc le vérifie distance par distance. Si l'un de ces
 * tests casse, relisez conditions-commande.rules.ts avant de l'adapter.
 */

import { DELIVERY_FEE_DEFAULT_GRID, DeliveryFeeHelper, IDeliveryFeeTier } from './delivery-fee.helper';
import { conditionsCommandePubliques, grillePublique, PalierPublic, tauxPublic } from './conditions-commande.rules';

describe('tauxPublic', () => {
  it('un taux lisible est publié tel quel', () => {
    expect(tauxPublic(0.01)).toBe(0.01);
    expect(tauxPublic(0.05)).toBe(0.05);
    expect(tauxPublic(0)).toBe(0);
  });

  it('un réglage mal saisi (Number("1 %") vaut NaN) ou négatif : null, jamais un montant faux', () => {
    expect(tauxPublic(Number('1 %'))).toBeNull();
    expect(tauxPublic(Number.POSITIVE_INFINITY)).toBeNull();
    expect(tauxPublic(-0.01)).toBeNull();
    expect(tauxPublic(undefined)).toBeNull();
    expect(tauxPublic(null)).toBeNull();
  });
});

describe('grillePublique', () => {
  it('grille par défaut : 9 paliers, dans l\'ordre, le dernier « au-delà »', () => {
    expect(grillePublique(DELIVERY_FEE_DEFAULT_GRID)).toEqual([
      { distance_max_km: 2, montant: 1000 },
      { distance_max_km: 4, montant: 1500 },
      { distance_max_km: 5, montant: 2000 },
      { distance_max_km: 7, montant: 2500 },
      { distance_max_km: 10, montant: 3000 },
      { distance_max_km: 12.5, montant: 3500 },
      { distance_max_km: 14, montant: 4000 },
      { distance_max_km: 16, montant: 4500 },
      { distance_max_km: null, montant: 5000 },
    ]);
  });

  it('paliers saisis dans le désordre au backoffice : triés, « au-delà » en dernier', () => {
    const grille: IDeliveryFeeTier[] = [
      { maxKm: null, price: 4000 },
      { maxKm: 6, price: 2000 },
      { maxKm: 3, price: 1000 },
    ];
    expect(grillePublique(grille)).toEqual([
      { distance_max_km: 3, montant: 1000 },
      { distance_max_km: 6, montant: 2000 },
      { distance_max_km: null, montant: 4000 },
    ]);
  });

  it('sans palier « au-delà » : le dernier prix vaut pour toute distance plus longue', () => {
    expect(
      grillePublique([
        { maxKm: 3, price: 1000 },
        { maxKm: 8, price: 2500 },
      ]),
    ).toEqual([
      { distance_max_km: 3, montant: 1000 },
      { distance_max_km: null, montant: 2500 },
    ]);
  });

  it('deux paliers à la même borne : seul le premier saisi est facturé, donc publié', () => {
    expect(
      grillePublique([
        { maxKm: 3, price: 1000 },
        { maxKm: 3, price: 9000 },
        { maxKm: null, price: 2000 },
        { maxKm: null, price: 7000 },
      ]),
    ).toEqual([
      { distance_max_km: 3, montant: 1000 },
      { distance_max_km: null, montant: 2000 },
    ]);
  });

  it('une borne illisible n\'est jamais atteinte : retirée', () => {
    expect(
      grillePublique([
        { maxKm: Number.NaN, price: 500 },
        { maxKm: 0, price: 600 },
        { maxKm: -2, price: 700 },
        { maxKm: 4, price: 1500 },
        { maxKm: null, price: 3000 },
      ]),
    ).toEqual([
      { distance_max_km: 4, montant: 1500 },
      { distance_max_km: null, montant: 3000 },
    ]);
  });

  it('un prix nul ou négatif n\'est jamais facturé (verrou des frais) : aucune grille publiée', () => {
    expect(grillePublique([{ maxKm: 3, price: 0 }, { maxKm: null, price: 2000 }])).toEqual([]);
    expect(grillePublique([{ maxKm: 3, price: 1000 }, { maxKm: null, price: -5 }])).toEqual([]);
    expect(grillePublique([{ maxKm: 3, price: Number.NaN }])).toEqual([]);
  });

  it('un prix nul sur un palier jamais atteint ne compte pas', () => {
    expect(
      grillePublique([
        { maxKm: 3, price: 1000 },
        { maxKm: 3, price: 0 },
        { maxKm: null, price: 2000 },
      ]),
    ).toEqual([
      { distance_max_km: 3, montant: 1000 },
      { distance_max_km: null, montant: 2000 },
    ]);
  });

  it('grille absente ou vide : liste vide', () => {
    expect(grillePublique(undefined)).toEqual([]);
    expect(grillePublique(null)).toEqual([]);
    expect(grillePublique([])).toEqual([]);
  });

  it('ne modifie pas la grille reçue', () => {
    const grille: IDeliveryFeeTier[] = [
      { maxKm: 8, price: 2500 },
      { maxKm: 3, price: 1000 },
    ];
    const copie = JSON.parse(JSON.stringify(grille));
    grillePublique(grille);
    expect(grille).toEqual(copie);
  });
});

describe('conditionsCommandePubliques', () => {
  it('ne publie que le taux, la grille et son statut : rien d\'autre', () => {
    const conditions = conditionsCommandePubliques({
      tauxFraisService: 0.01,
      grille: [{ maxKm: 2, price: 1000 }, { maxKm: null, price: 2000 }],
      zonesLivreurActives: false,
    });
    expect(Object.keys(conditions).sort()).toEqual(
      ['grille_frais', 'grille_frais_appliquee', 'taux_frais_service'].sort(),
    );
    expect(conditions).toEqual({
      taux_frais_service: 0.01,
      grille_frais: [
        { distance_max_km: 2, montant: 1000 },
        { distance_max_km: null, montant: 2000 },
      ],
      grille_frais_appliquee: true,
    });
  });

  it('zones du livreur actives : la grille ne sert que de secours, elle est signalée non appliquée', () => {
    const conditions = conditionsCommandePubliques({
      tauxFraisService: 0.01,
      grille: DELIVERY_FEE_DEFAULT_GRID,
      zonesLivreurActives: true,
    });
    expect(conditions.grille_frais_appliquee).toBe(false);
    expect(conditions.grille_frais).toHaveLength(9);
  });
});

describe('la grille publiée est celle que priceForDistance facture', () => {
  // priceForDistance ne lit que la grille passée : aucune dépendance à fournir.
  const helper = Object.create(DeliveryFeeHelper.prototype) as DeliveryFeeHelper;

  const lirePalier = (paliers: PalierPublic[], km: number) =>
    paliers.find((p) => p.distance_max_km == null || km <= p.distance_max_km)?.montant;

  const grilles: Array<[string, IDeliveryFeeTier[]]> = [
    ['par défaut', DELIVERY_FEE_DEFAULT_GRID],
    ['désordonnée', [{ maxKm: null, price: 4000 }, { maxKm: 6, price: 2000 }, { maxKm: 3, price: 1000 }]],
    ['sans « au-delà »', [{ maxKm: 3, price: 1000 }, { maxKm: 8, price: 2500 }]],
    ['bornes en double', [{ maxKm: 3, price: 1000 }, { maxKm: 3, price: 9000 }, { maxKm: null, price: 2000 }]],
    ['un seul palier borné', [{ maxKm: 5, price: 1500 }]],
  ];

  it.each(grilles)('grille %s : même prix de 0 à 30 km, au dixième près', (_nom, grille) => {
    const paliers = grillePublique(grille);
    expect(paliers.length).toBeGreaterThan(0);
    for (let dixiemes = 0; dixiemes <= 300; dixiemes += 1) {
      const km = dixiemes / 10;
      expect(lirePalier(paliers, km)).toBe(helper.priceForDistance(grille, km));
    }
    // Pile sur une borne et juste au-dessus : le palier « jusqu'à » inclut sa borne.
    for (const p of paliers) {
      if (p.distance_max_km == null) continue;
      expect(lirePalier(paliers, p.distance_max_km)).toBe(helper.priceForDistance(grille, p.distance_max_km));
      expect(lirePalier(paliers, p.distance_max_km + 0.001)).toBe(
        helper.priceForDistance(grille, p.distance_max_km + 0.001),
      );
    }
  });
});
