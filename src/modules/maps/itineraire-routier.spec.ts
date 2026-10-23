/**
 * MapsService, côté dispatch : itinéraire routier (mètres + tracé, cache
 * 30 jours), distance routière qui s'appuie dessus, détour sans trafic,
 * délais de 2,5 s, compteur et plafond quotidien.
 *
 * ⚠️ Aucun appel réel à Google : `fetch` est remplacé dans chaque test, et
 * tout appel non prévu fait échouer le test.
 */
import type { Cache } from 'cache-manager';

import { CompteurAppelsGoogleService } from './compteur-appels-google.service';
import { MapsService } from './maps.service';

const TRENTE_JOURS_MS = 30 * 24 * 60 * 60 * 1000;

/** Cache en mémoire qui garde aussi la durée de vie demandée. */
function cacheSimule() {
  const valeurs = new Map<string, unknown>();
  const durees = new Map<string, number>();
  const cache = {
    get: jest.fn(async (cle: string) => valeurs.get(cle)),
    set: jest.fn(async (cle: string, valeur: unknown, ttl: number) => {
      valeurs.set(cle, valeur);
      durees.set(cle, ttl);
    }),
  };
  return { cache: cache as unknown as Cache, valeurs, durees, espions: cache };
}

function compteurSimule(autorise = true) {
  return {
    reserver: jest.fn(async (_fonction?: string) => autorise),
    compter: jest.fn(),
  };
}

/** Réponse Directions minimale. */
function reponseDirections(legs: { metres: number; secondes: number }[], polyligne = '_p~iF~ps|U_ulLnnqC') {
  return {
    ok: true,
    json: async () => ({
      status: 'OK',
      routes: [
        {
          overview_polyline: { points: polyligne },
          legs: legs.map((l) => ({
            distance: { value: l.metres },
            duration: { value: l.secondes },
            start_location: { lat: 0, lng: 0 },
            end_location: { lat: 0, lng: 0 },
          })),
        },
      ],
    }),
  } as unknown as Response;
}

const ZONE_4 = { originLat: 5.286, originLng: -3.9737 };
const PORT_BOUET = { destLat: 5.26, destLng: -3.942 };
const CLE_ROUTE = 'maps:road-route:5.2860_-3.9737_5.2600_-3.9420';
const CLE_ANCIENNE = 'maps:road-distance:5.2860_-3.9737_5.2600_-3.9420';

let appelsGoogle: jest.SpyInstance;
const cleAvant = process.env.GOOGLE_MAPS_API_KEY;

function monter(options: { autorise?: boolean; cle?: string } = {}) {
  process.env.GOOGLE_MAPS_API_KEY = options.cle ?? 'cle-essai';
  const c = cacheSimule();
  const compteur = compteurSimule(options.autorise ?? true);
  const maps = new MapsService(c.cache, compteur as unknown as CompteurAppelsGoogleService);
  return { maps, compteur, ...c };
}

beforeEach(() => {
  appelsGoogle = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    throw new Error(`Appel à Google non prévu par le test : ${String(url)}`);
  });
});

afterEach(() => {
  appelsGoogle.mockRestore();
  jest.useRealTimers();
  if (cleAvant === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = cleAvant;
});

describe('itineraireRoutier', () => {
  it('un appel Directions sans trafic, mètres + secondes + tracé gardés ensemble 30 jours', async () => {
    const { maps, compteur, valeurs, durees } = monter();
    appelsGoogle.mockResolvedValueOnce(reponseDirections([{ metres: 4800, secondes: 720 }], 'abc@'));

    const itineraire = await maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET });

    expect(itineraire).toEqual({ metres: 4800, secondes: 720, polyligne: 'abc@' });
    expect(compteur.reserver).toHaveBeenCalledWith('itineraire');
    const [url, init] = appelsGoogle.mock.calls[0];
    expect(String(url)).toContain('/directions/json');
    expect(String(url)).not.toContain('departure_time');
    // Délai maximal : la requête porte un signal d'abandon.
    expect((init as RequestInit).signal).toBeDefined();
    expect(valeurs.get(CLE_ROUTE)).toEqual({ metres: 4800, secondes: 720, polyligne: 'abc@' });
    expect(durees.get(CLE_ROUTE)).toBe(TRENTE_JOURS_MS);
  });

  it('servi par le cache : aucun appel, rien de compté', async () => {
    const { maps, compteur, valeurs } = monter();
    valeurs.set(CLE_ROUTE, { metres: 4800, secondes: 720, polyligne: 'abc@' });
    await expect(maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET })).resolves.toEqual({
      metres: 4800,
      secondes: 720,
      polyligne: 'abc@',
    });
    expect(appelsGoogle).not.toHaveBeenCalled();
    expect(compteur.reserver).not.toHaveBeenCalled();
  });

  it('plafond quotidien atteint : repli (null), aucun appel ; le cache reste servi', async () => {
    const { maps, valeurs } = monter({ autorise: false });
    await expect(maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET })).resolves.toBeNull();
    expect(appelsGoogle).not.toHaveBeenCalled();

    valeurs.set(CLE_ROUTE, { metres: 4800, secondes: 720, polyligne: '' });
    await expect(maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET })).resolves.toMatchObject({ metres: 4800 });
  });

  it('sans clé : null sans appel', async () => {
    const { maps } = monter({ cle: '' });
    await expect(maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET })).resolves.toBeNull();
    expect(appelsGoogle).not.toHaveBeenCalled();
  });

  it('Google en échec, sans itinéraire ou muet : null, rien en cache, jamais d’exception', async () => {
    const { maps, valeurs } = monter();
    appelsGoogle.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ZERO_RESULTS' }) } as unknown as Response);
    await expect(maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET })).resolves.toBeNull();
    appelsGoogle.mockRejectedValueOnce(new Error('réseau coupé'));
    await expect(maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET })).resolves.toBeNull();
    appelsGoogle.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);
    await expect(maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET })).resolves.toBeNull();
    expect(valeurs.size).toBe(0);
  });

  it('tracé du planificateur : échec de Google retenu 10 min, pas redemandé à chaque passage ; les frais redemandent (relecture)', async () => {
    const { maps, valeurs, durees, compteur } = monter();
    appelsGoogle.mockResolvedValue({ ok: true, json: async () => ({ status: 'ZERO_RESULTS' }) } as unknown as Response);
    await expect(maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET }, { pour: 'direction' })).resolves.toBeNull();
    expect(compteur.reserver).toHaveBeenCalledWith('trace_direction');
    const cleEchec = 'maps:road-route-echec:5.2860_-3.9737_5.2600_-3.9420';
    expect(valeurs.has(cleEchec)).toBe(true);
    expect(durees.get(cleEchec)).toBe(10 * 60 * 1000);
    expect(valeurs.has(CLE_ROUTE)).toBe(false);

    for (let i = 0; i < 5; i++) await maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET }, { pour: 'direction' });
    expect(appelsGoogle).toHaveBeenCalledTimes(1);
    expect(compteur.reserver).toHaveBeenCalledTimes(1);

    // Frais de livraison : jamais bloqués par cet échec retenu.
    await expect(maps.distanceRoutiereMetres({ ...ZONE_4, ...PORT_BOUET })).resolves.toBeNull();
    expect(appelsGoogle).toHaveBeenCalledTimes(2);
  });

  it('Google lent : abandon au bout de 2,5 s, repli', async () => {
    jest.useFakeTimers();
    const { maps } = monter();
    appelsGoogle.mockImplementation(
      (_url, init) =>
        new Promise((_ok, ko) => (init as RequestInit).signal!.addEventListener('abort', () => ko(new Error('abandon')))),
    );
    const attente = maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET });
    await jest.advanceTimersByTimeAsync(2500);
    await expect(attente).resolves.toBeNull();
  });

  it('tracé absent de la réponse : mètres gardés, tracé vide', async () => {
    const { maps } = monter();
    appelsGoogle.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'OK', routes: [{ legs: [{ distance: { value: 3000 }, duration: { value: 500 } }] }] }),
    } as unknown as Response);
    await expect(maps.itineraireRoutier({ ...ZONE_4, ...PORT_BOUET })).resolves.toEqual({
      metres: 3000,
      secondes: 500,
      polyligne: '',
    });
  });
});

describe('distanceRoutiereMetres', () => {
  it('s’appuie sur itineraireRoutier : le tracé est gardé au passage', async () => {
    const { maps, valeurs } = monter();
    appelsGoogle.mockResolvedValueOnce(reponseDirections([{ metres: 4800, secondes: 720 }]));
    await expect(maps.distanceRoutiereMetres({ ...ZONE_4, ...PORT_BOUET })).resolves.toBe(4800);
    expect(valeurs.get(CLE_ROUTE)).toMatchObject({ metres: 4800, polyligne: '_p~iF~ps|U_ulLnnqC' });
  });

  it('ancienne entrée (mètres seuls) encore servie : pas de second paiement pour les frais', async () => {
    const { maps, valeurs } = monter();
    valeurs.set(CLE_ANCIENNE, 4700);
    await expect(maps.distanceRoutiereMetres({ ...ZONE_4, ...PORT_BOUET })).resolves.toBe(4700);
    expect(appelsGoogle).not.toHaveBeenCalled();
    // Une valeur sérialisée en chaîne compte aussi.
    valeurs.set(CLE_ANCIENNE, '4650');
    await expect(maps.distanceRoutiereMetres({ ...ZONE_4, ...PORT_BOUET })).resolves.toBe(4650);
  });

  it('la nouvelle entrée passe avant l’ancienne', async () => {
    const { maps, valeurs } = monter();
    valeurs.set(CLE_ANCIENNE, 4700);
    valeurs.set(CLE_ROUTE, { metres: 4800, secondes: 720, polyligne: '' });
    await expect(maps.distanceRoutiereMetres({ ...ZONE_4, ...PORT_BOUET })).resolves.toBe(4800);
  });

  it('plafond du regroupement atteint : la facturation et l’acheminement gardent la route (relecture)', async () => {
    const { maps, compteur } = monter();
    // Comme le vrai compteur : seules les fonctions du regroupement sont coupées.
    compteur.reserver.mockImplementation(async (fonction: string) => fonction === 'itineraire');
    appelsGoogle.mockResolvedValueOnce(reponseDirections([{ metres: 4800, secondes: 720 }]));
    await expect(maps.distanceRoutiereMetres({ ...ZONE_4, ...PORT_BOUET })).resolves.toBe(4800);
    expect(compteur.reserver).toHaveBeenCalledWith('itineraire');
    // Le tracé du planificateur, lui, retombe sur son repli sans Google.
    await expect(maps.itineraireRoutier({ ...ZONE_4, destLat: 5.3, destLng: -3.95 }, { pour: 'direction' })).resolves.toBeNull();
    expect(compteur.reserver).toHaveBeenLastCalledWith('trace_direction');
    expect(appelsGoogle).toHaveBeenCalledTimes(1);
  });

  it('coordonnées illisibles : null sans appel', async () => {
    const { maps } = monter();
    await expect(maps.distanceRoutiereMetres({ ...ZONE_4, destLat: Number.NaN, destLng: -3.9 })).resolves.toBeNull();
    expect(appelsGoogle).not.toHaveBeenCalled();
  });
});

describe('detourSansTrafic', () => {
  const R = { latitude: 5.286, longitude: -3.9737 };
  const P = { latitude: 5.283, longitude: -3.955 };
  const L = { latitude: 5.26, longitude: -3.942 };
  const CLE_DETOUR = 'maps:detour:5.2860_-3.9737_5.2830_-3.9550_5.2600_-3.9420';

  it('trajet direct (en cache) et trajet avec l’étape, tous deux sans trafic, gardés 30 jours', async () => {
    const { maps, compteur, valeurs, durees } = monter();
    valeurs.set(CLE_ROUTE, { metres: 4800, secondes: 720, polyligne: '' });
    appelsGoogle.mockResolvedValueOnce(reponseDirections([{ metres: 2300, secondes: 400 }, { metres: 2700, secondes: 420 }]));

    await expect(maps.detourSansTrafic({ restaurant: R, proche: P, lointain: L })).resolves.toEqual({
      secondesDirect: 720,
      secondesAvecEtape: 820,
    });
    expect(compteur.reserver).toHaveBeenCalledWith('detour');
    const [url, init] = appelsGoogle.mock.calls[0];
    const adresse = new URL(String(url));
    expect(adresse.searchParams.get('waypoints')).toBe('5.283,-3.955');
    expect(adresse.searchParams.get('departure_time')).toBeNull();
    expect((init as RequestInit).signal).toBeDefined();
    expect(valeurs.get(CLE_DETOUR)).toBe(820);
    expect(durees.get(CLE_DETOUR)).toBe(TRENTE_JOURS_MS);

    // Second appel : tout en cache.
    appelsGoogle.mockClear();
    await expect(maps.detourSansTrafic({ restaurant: R, proche: P, lointain: L })).resolves.toEqual({
      secondesDirect: 720,
      secondesAvecEtape: 820,
    });
    expect(appelsGoogle).not.toHaveBeenCalled();
  });

  it('trajet direct indisponible : null, l’étape n’est même pas demandée (jamais de mélange)', async () => {
    const { maps } = monter({ autorise: false });
    await expect(maps.detourSansTrafic({ restaurant: R, proche: P, lointain: L })).resolves.toBeNull();
    expect(appelsGoogle).not.toHaveBeenCalled();
  });

  it('Google sans réponse utile pour l’étape : échec retenu 10 min, pas redemandé à chaque passage (relecture)', async () => {
    const { maps, valeurs, durees, compteur } = monter();
    valeurs.set(CLE_ROUTE, { metres: 4800, secondes: 720, polyligne: '' });
    appelsGoogle.mockResolvedValue({ ok: true, json: async () => ({ status: 'ZERO_RESULTS' }) } as unknown as Response);

    await expect(maps.detourSansTrafic({ restaurant: R, proche: P, lointain: L })).resolves.toBeNull();
    const cleEchec = 'maps:detour-echec:5.2860_-3.9737_5.2830_-3.9550_5.2600_-3.9420';
    expect(valeurs.has(cleEchec)).toBe(true);
    expect(durees.get(cleEchec)).toBe(10 * 60 * 1000);
    expect(valeurs.has(CLE_DETOUR)).toBe(false);

    for (let i = 0; i < 5; i++) await maps.detourSansTrafic({ restaurant: R, proche: P, lointain: L });
    expect(appelsGoogle).toHaveBeenCalledTimes(1);
    expect(compteur.reserver).toHaveBeenCalledTimes(1);

    // Passé les 10 min (entrée effacée par le cache) : redemandé.
    valeurs.delete(cleEchec);
    await maps.detourSansTrafic({ restaurant: R, proche: P, lointain: L });
    expect(appelsGoogle).toHaveBeenCalledTimes(2);
  });

  it('plafond atteint pour l’étape : null', async () => {
    const { maps, valeurs, compteur } = monter();
    valeurs.set(CLE_ROUTE, { metres: 4800, secondes: 720, polyligne: '' });
    compteur.reserver.mockResolvedValueOnce(false);
    await expect(maps.detourSansTrafic({ restaurant: R, proche: P, lointain: L })).resolves.toBeNull();
    expect(appelsGoogle).not.toHaveBeenCalled();
  });

  it('Google lent : abandon au bout de 2,5 s, null', async () => {
    jest.useFakeTimers();
    const { maps, valeurs } = monter();
    valeurs.set(CLE_ROUTE, { metres: 4800, secondes: 720, polyligne: '' });
    appelsGoogle.mockImplementation(
      (_url, init) =>
        new Promise((_ok, ko) => (init as RequestInit).signal!.addEventListener('abort', () => ko(new Error('abandon')))),
    );
    const attente = maps.detourSansTrafic({ restaurant: R, proche: P, lointain: L });
    await jest.advanceTimersByTimeAsync(2500);
    await expect(attente).resolves.toBeNull();
  });
});

describe('délais et compteurs des autres appels', () => {
  it('getDirections : compté (jamais plafonné), abandonné au bout de 2,5 s', async () => {
    jest.useFakeTimers();
    const { maps, compteur } = monter({ autorise: false });
    appelsGoogle.mockImplementation(
      (_url, init) =>
        new Promise((_ok, ko) => (init as RequestInit).signal!.addEventListener('abort', () => ko(new Error('abandon')))),
    );
    const attente = maps.getDirections({ originLat: 5.286, originLng: -3.9737, destLat: 5.26, destLng: -3.942 });
    await jest.advanceTimersByTimeAsync(2499);
    expect(appelsGoogle).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(attente).resolves.toBeNull();
    expect(compteur.compter).toHaveBeenCalledWith('trajet_trafic');
    expect(compteur.reserver).not.toHaveBeenCalled();
  });

  it('getTravelTimes : plafond atteint, null sans appel (classement habituel)', async () => {
    const { maps, compteur } = monter({ autorise: false });
    await expect(
      maps.getTravelTimes([{ latitude: 5.28, longitude: -3.97 }, { latitude: 5.29, longitude: -3.98 }], { latitude: 5.286, longitude: -3.9737 }),
    ).resolves.toBeNull();
    expect(compteur.reserver).toHaveBeenCalledWith('temps_trajet');
    expect(appelsGoogle).not.toHaveBeenCalled();
  });

  it('getTravelTimes : abandonné au bout de 2,5 s', async () => {
    jest.useFakeTimers();
    const { maps } = monter();
    appelsGoogle.mockImplementation(
      (_url, init) =>
        new Promise((_ok, ko) => (init as RequestInit).signal!.addEventListener('abort', () => ko(new Error('abandon')))),
    );
    const attente = maps.getTravelTimes(
      [{ latitude: 5.28, longitude: -3.97 }, { latitude: 5.29, longitude: -3.98 }],
      { latitude: 5.286, longitude: -3.9737 },
    );
    await jest.advanceTimersByTimeAsync(2500);
    await expect(attente).resolves.toBeNull();
  });
});
