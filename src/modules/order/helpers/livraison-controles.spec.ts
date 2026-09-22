/**
 * Les seuils des contrôles de livraison.
 *
 * Si l'un de ces tests casse, ne l'adaptez pas au nouveau comportement : ces
 * seuils ont été calibrés sur les données réelles de production, et les changer
 * change le débit d'alertes reçu par l'équipe. Un canal qui parle trop finit
 * ignoré, ce qui est pire que pas d'alerte du tout.
 */

import {
  acheminementInterpelle,
  courseTresLongue,
  ecartTarifInexplique,
  pointExploitable,
  SEUIL_ECART_ACHEMINEMENT_KM,
  SEUIL_LOIN_KM,
} from './livraison-controles';

describe('Écart tarifaire', () => {
  it('se tait quand la remise explique exactement l’écart', () => {
    // 123 cas sur 135 en neuf jours : des gestes commerciaux normaux.
    expect(ecartTarifInexplique(1000, 3000, 2000).motif).toBeNull();
  });

  it('se tait quand rien n’a bougé', () => {
    expect(ecartTarifInexplique(2000, 2000, 0).motif).toBeNull();
  });

  it('voit la SURFACTURATION, que la remise ne peut pas enregistrer', () => {
    // `delivery_discount = Math.max(0, base - facturé)` vaut 0 dès que le
    // facturé dépasse la base : c'est le seul contrôle qui rend ce cas visible.
    // 11 cas en neuf jours, 7 000 F, tous en centre d'appel.
    const v = ecartTarifInexplique(3000, 2000, 0);
    expect(v.motif).toBe('surfacture');
    expect(v.montant).toBe(1000);
  });

  it('voit la remise appliquée sans être enregistrée', () => {
    const v = ecartTarifInexplique(1000, 3000, 0);
    expect(v.motif).toBe('sous-facture');
    expect(v.montant).toBe(2000);
  });

  it('voit une remise enregistrée INCOHÉRENTE avec l’écart réel', () => {
    // Signature d'un PATCH qui a réécrit delivery_fee sans toucher à la base
    // ni à la remise.
    expect(ecartTarifInexplique(1000, 3000, 1500).motif).toBe('sous-facture');
  });

  it('ne dit rien sans base calculée', () => {
    // Commande antérieure au champ, ou enlèvement : pas de référence, donc pas
    // d'anomalie possible.
    expect(ecartTarifInexplique(1500, 0, 0).motif).toBeNull();
  });

  it('absorbe l’arrondi au franc', () => {
    expect(ecartTarifInexplique(2000.4, 2000, 0).motif).toBeNull();
  });
});

describe('Point de livraison', () => {
  it('accepte un point abidjanais', () => {
    expect(pointExploitable(5.3364, -4.0267)).toBe(true);
  });

  it('refuse (0,0), qui signale un point manquant et non une adresse', () => {
    expect(pointExploitable(0, 0)).toBe(false);
  });

  it('refuse l’absence de point', () => {
    expect(pointExploitable(null, -4.02)).toBe(false);
    expect(pointExploitable(undefined, undefined)).toBe(false);
  });

  it('refuse des coordonnées hors du monde', () => {
    expect(pointExploitable(200, 10)).toBe(false);
    expect(pointExploitable(NaN, 0)).toBe(false);
  });
});

describe('Acheminement', () => {
  it('se tait sous le seuil : c’est du bruit géométrique', () => {
    // 15 des 30 écarts de trente jours tiennent sous le kilomètre.
    expect(acheminementInterpelle(2.4, 0.9)).toBe(false);
  });

  it('interpelle exactement au seuil', () => {
    expect(acheminementInterpelle(SEUIL_ECART_ACHEMINEMENT_KM, 0)).toBe(true);
  });

  it('interpelle nettement au-delà', () => {
    expect(acheminementInterpelle(12.4, 3.1)).toBe(true);
  });

  it('ne dit rien quand un candidat manque de coordonnées', () => {
    expect(acheminementInterpelle(12, null)).toBe(false);
    expect(acheminementInterpelle(null, 2)).toBe(false);
  });

  it('ne se déclenche pas quand le retenu EST le plus proche', () => {
    expect(acheminementInterpelle(2.1, 2.1)).toBe(false);
  });

  it('le cas Grand-Bassam ne se déclenche pas, et c’est voulu', () => {
    // Depuis Bassam, ZONE 4 est à 27,36 km et FAYA à 27,88 km : 0,52 km
    // d'écart, et l'ordre bascule selon le quartier. Ce cas relève du contrôle
    // de distance, pas de celui d'acheminement.
    expect(acheminementInterpelle(27.88, 27.36)).toBe(false);
  });
});

describe('Course très longue', () => {
  it('se tait sous le seuil', () => {
    expect(courseTresLongue(14.9)).toBe(false);
  });

  it('interpelle au seuil', () => {
    expect(courseTresLongue(SEUIL_LOIN_KM)).toBe(true);
  });

  it('ne dit rien sans distance connue', () => {
    // Toute commande antérieure au 14/09/2026 : la colonne n'existait pas.
    expect(courseTresLongue(null)).toBe(false);
    expect(courseTresLongue(undefined)).toBe(false);
  });
});
