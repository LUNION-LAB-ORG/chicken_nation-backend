/**
 * MapsService, ordre des arrêts d'une tournée (demande du client du 27/10) :
 * distance entre deux clients lue dans le cache routier de 30 jours sans
 * jamais appeler Google (`trajetEnCache`), et appel borné compté à part
 * (`ordre_arrets`, plafonné avec le regroupement) ; de même pour le second
 * avis du regroupement par tournée (`regroupement_route`, 28/10).
 *
 * ⚠️ Aucun appel réel à Google : `fetch` est remplacé, tout appel non prévu
 * fait échouer le test.
 */
import type { Cache } from 'cache-manager';

import { DELAI_CACHE_MS } from './cache-borne.helper';
import {
  cleCompteur,
  CompteurAppelsGoogleService,
  FONCTIONS_GOOGLE,
  FONCTIONS_PLAFONNEES,
} from './compteur-appels-google.service';
import { MapsService } from './maps.service';

const KOUMASSI = { lat: 5.283, lng: -3.955 };
const PORT_BOUET = { lat: 5.26, lng: -3.942 };
const CLE = 'maps:road-route:5.2830_-3.9550_5.2600_-3.9420';
const CLE_ECHEC = 'maps:road-route-echec:5.2830_-3.9550_5.2600_-3.9420';

function monter(get: (cle: string) => Promise<unknown> = async () => undefined) {
  process.env.GOOGLE_MAPS_API_KEY = 'cle-essai';
  const valeurs = new Map<string, unknown>();
  const durees = new Map<string, number>();
  const cache = {
    get: jest.fn(async (cle: string) => (valeurs.has(cle) ? valeurs.get(cle) : get(cle))),
    set: jest.fn(async (cle: string, valeur: unknown, ttl: number) => {
      valeurs.set(cle, valeur);
      durees.set(cle, ttl);
    }),
  };
  const compteur = { reserver: jest.fn(async (_f?: string) => true), compter: jest.fn() };
  const maps = new MapsService(cache as unknown as Cache, compteur as unknown as CompteurAppelsGoogleService);
  return { maps, valeurs, durees, compteur };
}

let fetchEspion: jest.SpyInstance;
const cleAvant = process.env.GOOGLE_MAPS_API_KEY;

beforeEach(() => {
  fetchEspion = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    throw new Error(`Appel à Google non prévu par le test : ${String(url)}`);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env.GOOGLE_MAPS_API_KEY = cleAvant;
});

describe('trajetEnCache', () => {
  it('mètres de l’itinéraire en cache (clé road-route), sans jamais appeler Google', async () => {
    const { maps, valeurs } = monter();
    await expect(maps.trajetEnCache(KOUMASSI, PORT_BOUET)).resolves.toBeNull();
    valeurs.set(CLE, { metres: 2600, secondes: 420, polyligne: '' });
    await expect(maps.trajetEnCache(KOUMASSI, PORT_BOUET)).resolves.toBe(2600);
    // Un seul sens : l'appelant essaie l'autre.
    await expect(maps.trajetEnCache(PORT_BOUET, KOUMASSI)).resolves.toBeNull();
    expect(fetchEspion).not.toHaveBeenCalled();
  });

  it('cache en panne ou lent : null, jamais d’exception, jamais plus de 400 ms', async () => {
    const enPanne = monter(async () => {
      throw new Error('Redis coupé');
    });
    await expect(enPanne.maps.trajetEnCache(KOUMASSI, PORT_BOUET)).resolves.toBeNull();
    const lent = monter(() => new Promise(() => undefined));
    const debut = Date.now();
    await expect(lent.maps.trajetEnCache(KOUMASSI, PORT_BOUET)).resolves.toBeNull();
    expect(Date.now() - debut).toBeLessThan(DELAI_CACHE_MS + 300);
    await expect(lent.maps.trajetEnCache({ lat: Number.NaN, lng: 1 }, PORT_BOUET)).resolves.toBeNull();
  });
});

describe('itineraireRoutier pour l’ordre des arrêts', () => {
  it('compté sous ordre_arrets, plafonné avec le regroupement, gardé 30 jours sous la même clé', async () => {
    expect(FONCTIONS_GOOGLE).toContain('ordre_arrets');
    expect(FONCTIONS_PLAFONNEES.has('ordre_arrets')).toBe(true);
    const { maps, valeurs, durees, compteur } = monter();
    fetchEspion.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'OK', routes: [{ overview_polyline: { points: '' }, legs: [{ distance: { value: 2600 }, duration: { value: 420 } }] }] }),
    } as unknown as Response);
    const r = await maps.itineraireRoutier(
      { originLat: KOUMASSI.lat, originLng: KOUMASSI.lng, destLat: PORT_BOUET.lat, destLng: PORT_BOUET.lng },
      { pour: 'ordre' },
    );
    expect(r?.metres).toBe(2600);
    expect(compteur.reserver).toHaveBeenCalledWith('ordre_arrets');
    expect(valeurs.has(CLE)).toBe(true);
    expect(durees.get(CLE)).toBe(30 * 24 * 60 * 60 * 1000);
    await expect(maps.trajetEnCache(KOUMASSI, PORT_BOUET)).resolves.toBe(2600);
  });

  it('plafond atteint : rien n’est envoyé ; échec de Google retenu 10 min', async () => {
    const plafonne = monter();
    plafonne.compteur.reserver.mockResolvedValue(false);
    const params = { originLat: KOUMASSI.lat, originLng: KOUMASSI.lng, destLat: PORT_BOUET.lat, destLng: PORT_BOUET.lng };
    await expect(plafonne.maps.itineraireRoutier(params, { pour: 'ordre' })).resolves.toBeNull();
    expect(fetchEspion).not.toHaveBeenCalled();

    const muet = monter();
    fetchEspion.mockResolvedValue({ ok: true, json: async () => ({ status: 'ZERO_RESULTS' }) } as unknown as Response);
    await expect(muet.maps.itineraireRoutier(params, { pour: 'ordre' })).resolves.toBeNull();
    expect(muet.durees.get(CLE_ECHEC)).toBe(10 * 60 * 1000);
    await muet.maps.itineraireRoutier(params, { pour: 'ordre' });
    expect(fetchEspion).toHaveBeenCalledTimes(1);
  });
});

describe('itineraireRoutier pour le second avis du regroupement (28/10)', () => {
  const params = { originLat: KOUMASSI.lat, originLng: KOUMASSI.lng, destLat: PORT_BOUET.lat, destLng: PORT_BOUET.lng };

  it('compté sous regroupement_route (maps:appels:<jour>:regroupement_route), plafonné, gardé 30 jours sous la même clé', async () => {
    expect(FONCTIONS_GOOGLE).toContain('regroupement_route');
    expect(FONCTIONS_PLAFONNEES.has('regroupement_route')).toBe(true);
    expect(cleCompteur('2026-10-28', 'regroupement_route')).toBe('maps:appels:2026-10-28:regroupement_route');
    const { maps, valeurs, durees, compteur } = monter();
    fetchEspion.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'OK', routes: [{ overview_polyline: { points: '' }, legs: [{ distance: { value: 2600 }, duration: { value: 420 } }] }] }),
    } as unknown as Response);
    const r = await maps.itineraireRoutier(params, { pour: 'regroupement' });
    expect(r?.metres).toBe(2600);
    expect(compteur.reserver).toHaveBeenCalledWith('regroupement_route');
    expect(durees.get(CLE)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(valeurs.has(CLE)).toBe(true);
    // Partagée ensuite avec l'ordre des arrêts et les frais : aucun nouvel appel.
    await expect(maps.itineraireRoutier(params, { pour: 'ordre' })).resolves.toMatchObject({ metres: 2600 });
    expect(fetchEspion).toHaveBeenCalledTimes(1);
  });

  it('plafond quotidien atteint : rien n’est envoyé ; échec de Google retenu 10 min', async () => {
    const plafonne = monter();
    plafonne.compteur.reserver.mockResolvedValue(false);
    await expect(plafonne.maps.itineraireRoutier(params, { pour: 'regroupement' })).resolves.toBeNull();
    expect(fetchEspion).not.toHaveBeenCalled();

    const muet = monter();
    fetchEspion.mockResolvedValue({ ok: true, json: async () => ({ status: 'ZERO_RESULTS' }) } as unknown as Response);
    await expect(muet.maps.itineraireRoutier(params, { pour: 'regroupement' })).resolves.toBeNull();
    expect(muet.durees.get(CLE_ECHEC)).toBe(10 * 60 * 1000);
    await muet.maps.itineraireRoutier(params, { pour: 'regroupement' });
    expect(fetchEspion).toHaveBeenCalledTimes(1);
  });
});
