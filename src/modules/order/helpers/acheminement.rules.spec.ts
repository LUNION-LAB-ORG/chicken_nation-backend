import { CANDIDATS_INTERROGES, choisirRestaurant, volOiseauKm } from './acheminement.rules';

/** Les cinq vrais restaurants, coordonnées de production du 14/10/2026. */
const ZONE4 = { id: 'zone4', latitude: 5.2860442, longitude: -3.9737121 };
const SOCOCE = { id: 'sococe', latitude: 5.3735398, longitude: -3.9990328 };
const ANGRE = { id: 'angre', latitude: 5.3899293, longitude: -3.9752886 };
const FAYA = { id: 'faya', latitude: 5.3714584, longitude: -3.9322304 };
const YOPOUGON = { id: 'yopougon', latitude: 5.331124, longitude: -4.103754 };
const TOUS = [ZONE4, SOCOCE, ANGRE, FAYA, YOPOUGON];

/** Riviera, juste au nord du péage du pont HKB : Cocody, bord de lagune. */
const RIVIERA_BORD_LAGUNE = { latitude: 5.327, longitude: -3.981 };

describe('volOiseauKm', () => {
  it('reproduit le cas constaté : à vol d’oiseau, Marcory gagne depuis Riviera', () => {
    const dZone4 = volOiseauKm(RIVIERA_BORD_LAGUNE, ZONE4);
    const dSococe = volOiseauKm(RIVIERA_BORD_LAGUNE, SOCOCE);
    expect(dZone4).toBeLessThan(dSococe);
    expect(dZone4).toBeCloseTo(4.63, 1);
    expect(dSococe).toBeCloseTo(5.55, 1);
  });
});

describe('choisirRestaurant', () => {
  /**
   * LE CAS QUI MOTIVE TOUT. Par la route, Riviera → Zone 4 passe par le pont à
   * péage (~12 km) alors que Sococé est à ~7 km : la route doit renverser le
   * vol d'oiseau.
   */
  it('par la route, une adresse de Cocody en bord de lagune ne part plus à Marcory', async () => {
    const route = async (r: { id: string }) => ({ zone4: 12_000, sococe: 7_000, angre: 9_000 }[r.id] ?? null);
    const choix = await choisirRestaurant(TOUS, RIVIERA_BORD_LAGUNE, route);
    expect(choix?.restaurant.id).toBe('sococe');
    expect(choix?.methode).toBe('route');
    expect(choix?.renverse).toBe(true);
  });

  it('n’interroge Google que pour les plus proches à vol d’oiseau', async () => {
    const vus: string[] = [];
    await choisirRestaurant(TOUS, RIVIERA_BORD_LAGUNE, async (r) => {
      vus.push(r.id);
      return 1_000;
    });
    expect(vus).toHaveLength(CANDIDATS_INTERROGES);
    // Yopougon, à 13 km à vol d'oiseau, n'a aucune chance : pas d'appel pour lui.
    expect(vus).not.toContain('yopougon');
  });

  /**
   * Google manque (clé absente, délai, panne) : la commande passe quand même,
   * au plus proche à vol d'oiseau, et on NE MÉLANGE PAS des mètres routiers
   * avec des kilomètres à vol d'oiseau dans une même comparaison.
   */
  it('à la moindre distance manquante, retombe entièrement sur le vol d’oiseau', async () => {
    const route = async (r: { id: string }) => (r.id === 'sococe' ? null : 5_000);
    const choix = await choisirRestaurant(TOUS, RIVIERA_BORD_LAGUNE, route);
    expect(choix?.methode).toBe('vol_oiseau');
    expect(choix?.restaurant.id).toBe('zone4');
    expect(choix?.renverse).toBe(false);
  });

  it('traite une distance aberrante (zéro, négative, infinie) comme manquante', async () => {
    for (const aberrante of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const choix = await choisirRestaurant(TOUS, RIVIERA_BORD_LAGUNE, async (r) =>
        r.id === 'zone4' ? aberrante : 5_000,
      );
      expect([aberrante, choix?.methode]).toEqual([aberrante, 'vol_oiseau']);
    }
  });

  it('un seul candidat : choisi sans appeler Google', async () => {
    const route = jest.fn(async () => 1_000);
    const choix = await choisirRestaurant([ZONE4], RIVIERA_BORD_LAGUNE, route);
    expect(choix?.restaurant.id).toBe('zone4');
    expect(choix?.methode).toBe('seul');
    expect(route).not.toHaveBeenCalled();
  });

  it('ignore un restaurant sans coordonnées, et rend null s’il n’en reste aucun', async () => {
    const sansCoord = { id: 'x', latitude: null, longitude: null };
    expect(await choisirRestaurant([sansCoord], RIVIERA_BORD_LAGUNE, async () => 1)).toBeNull();
    const choix = await choisirRestaurant([sansCoord, ZONE4], RIVIERA_BORD_LAGUNE, async () => 1);
    expect(choix?.restaurant.id).toBe('zone4');
  });

  it('quand la route confirme le vol d’oiseau, ne signale pas de renversement', async () => {
    const choix = await choisirRestaurant(TOUS, RIVIERA_BORD_LAGUNE, async (r) =>
      r.id === 'zone4' ? 4_000 : 9_000,
    );
    expect(choix?.restaurant.id).toBe('zone4');
    expect(choix?.renverse).toBe(false);
  });
});
