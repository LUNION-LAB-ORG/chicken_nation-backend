/**
 * Trajet réutilisé : un livreur qui suit sa route ne repaie pas Google.
 *
 * ⚠️ Aucun appel réel à Google : `fetch` est remplacé dans chaque test, et
 * tout appel non prévu fait échouer le test.
 */
import type { Cache } from 'cache-manager';

import { encoderPolyligne } from 'src/modules/course/helpers/polyligne';

import { CompteurAppelsGoogleService } from './compteur-appels-google.service';
import { MapsService } from './maps.service';
import {
  ajouterTrajet,
  couperTrajet,
  DUREE_TRAJET_VIF_MS,
  reprendreTrajet,
  TRAJETS_VIFS_MAX,
  TrajetVif,
} from './trajet-vif.rules';

// Une ligne droite vers le nord : 0,01 degré de latitude ≈ 1 112 m.
const DEPART = { latitude: 5.3, longitude: -4 };
const MILIEU = { latitude: 5.31, longitude: -4 };
const ARRIVEE = { latitude: 5.32, longitude: -4 };
const TRACE = [DEPART, MILIEU, ARRIVEE];
const AILLEURS = { latitude: 5.31, longitude: -3.99 }; // ≈ 1,1 km à l'est du tracé

const trajet = (calculeA = 0, coordinates = TRACE): TrajetVif => ({ calculeA, coordinates, metres: 2224, secondes: 600 });

describe('couperTrajet', () => {
  it('à mi-chemin : la moitié de la distance et de la durée, tracé depuis le livreur', () => {
    const r = couperTrajet(MILIEU, trajet())!;
    expect(r.totalDistanceMeters).toBe(1112);
    expect(r.totalDurationSeconds).toBe(300);
    expect(r.totalDurationWithStopsSeconds).toBe(300);
    expect(r.coordinates[0]).toEqual(MILIEU);
    expect(r.coordinates[r.coordinates.length - 1]).toEqual(ARRIVEE);
    // Une seule étape, comme une vraie réponse sans arrêt : l'heure d'arrivée la lit.
    expect(r.legs).toEqual([
      { distanceMeters: 1112, durationSeconds: 300, startCoord: MILIEU, endCoord: ARRIVEE },
    ]);
  });

  it('légèrement à côté de la route (flottement du GPS) : encore sur le tracé', () => {
    expect(couperTrajet({ latitude: 5.31, longitude: -3.9995 }, trajet())).not.toBeNull(); // ≈ 55 m
  });

  it('dans une autre rue, à plus de 150 m : un vrai trajet est nécessaire', () => {
    expect(couperTrajet({ latitude: 5.31, longitude: -3.998 }, trajet())).toBeNull(); // ≈ 220 m
  });

  it('au départ et à l’arrivée : jamais plus que le trajet entier ni moins que zéro', () => {
    expect(couperTrajet({ latitude: 5.2995, longitude: -4 }, trajet())!.totalDurationSeconds).toBe(600);
    expect(couperTrajet({ latitude: 5.3205, longitude: -4 }, trajet())!.totalDurationSeconds).toBe(0);
  });

  it('tracé vide ou réduit à un point : pas de réutilisation', () => {
    expect(couperTrajet(MILIEU, trajet(0, []))).toBeNull();
    expect(couperTrajet(MILIEU, trajet(0, [MILIEU]))).toBeNull();
  });
});

describe('reprendreTrajet', () => {
  const autreRoute = (calculeA: number) => trajet(calculeA, [AILLEURS, ARRIVEE]);

  it('tracé de plus de 5 minutes : périmé, le trafic a pu changer', () => {
    expect(reprendreTrajet(MILIEU, [trajet(0)], DUREE_TRAJET_VIF_MS - 1)).not.toBeNull();
    expect(reprendreTrajet(MILIEU, [trajet(0)], DUREE_TRAJET_VIF_MS)).toBeNull();
  });

  it('deux livreurs vers le même restaurant : chacun retrouve sa route', () => {
    const trajets = [trajet(0), autreRoute(1)];
    expect(reprendreTrajet(MILIEU, trajets, 2)!.totalDurationSeconds).toBe(300);
    expect(reprendreTrajet(AILLEURS, trajets, 2)!.totalDurationSeconds).toBe(600);
  });

  it('sur deux tracés à la fois : le plus récent, au trafic le plus frais', () => {
    const recent = { ...trajet(5), secondes: 1200 };
    expect(reprendreTrajet(MILIEU, [trajet(0), recent], 6)!.totalDurationSeconds).toBe(600);
  });
});

describe('ajouterTrajet', () => {
  it('les périmés sortent, le maximum est tenu, le nouveau reste', () => {
    const anciens = Array.from({ length: TRAJETS_VIFS_MAX + 2 }, (_, i) => trajet(i + 100));
    const r = ajouterTrajet([trajet(0), ...anciens], trajet(DUREE_TRAJET_VIF_MS + 50));
    expect(r).toHaveLength(TRAJETS_VIFS_MAX);
    expect(r.some((t) => t.calculeA === 0)).toBe(false);
    expect(r[r.length - 1].calculeA).toBe(DUREE_TRAJET_VIF_MS + 50);
  });
});

describe('MapsService : ce qui part chez Google', () => {
  let appels: jest.SpyInstance;
  let maintenant: jest.SpyInstance;
  const cleAvant = process.env.GOOGLE_MAPS_API_KEY;

  const reponse = () =>
    ({
      ok: true,
      json: async () => ({
        status: 'OK',
        routes: [
          {
            overview_polyline: {
              points: encoderPolyligne(TRACE.map((p) => ({ lat: p.latitude, lng: p.longitude }))),
            },
            legs: [
              {
                distance: { value: 2224 },
                duration: { value: 500 },
                duration_in_traffic: { value: 600 },
                start_location: { lat: DEPART.latitude, lng: DEPART.longitude },
                end_location: { lat: ARRIVEE.latitude, lng: ARRIVEE.longitude },
              },
            ],
          },
        ],
      }),
    }) as unknown as Response;

  function monter() {
    process.env.GOOGLE_MAPS_API_KEY = 'cle-essai';
    const valeurs = new Map<string, unknown>();
    const cache = {
      // Comme Redis : ce qui revient a été sérialisé.
      get: jest.fn(async (cle: string) => (valeurs.has(cle) ? JSON.parse(valeurs.get(cle) as string) : undefined)),
      set: jest.fn(async (cle: string, valeur: unknown) => void valeurs.set(cle, JSON.stringify(valeur))),
    };
    const compteur = { reserver: jest.fn(async () => true), compter: jest.fn() };
    const maps = new MapsService(cache as unknown as Cache, compteur as unknown as CompteurAppelsGoogleService);
    return { maps, compteur };
  }

  const depuis = (p: { latitude: number; longitude: number }) => ({
    originLat: p.latitude,
    originLng: p.longitude,
    destLat: ARRIVEE.latitude,
    destLng: ARRIVEE.longitude,
  });

  beforeEach(() => {
    appels = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      throw new Error(`Appel à Google non prévu par le test : ${String(url)}`);
    });
    maintenant = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    appels.mockRestore();
    maintenant.mockRestore();
    if (cleAvant === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = cleAvant;
  });

  it('livreur qui avance sur sa route : un seul appel, le trafic est gardé', async () => {
    const { maps, compteur } = monter();
    appels.mockResolvedValueOnce(reponse());

    await maps.getDirections(depuis(DEPART));
    const r = await maps.getDirections(depuis(MILIEU));

    expect(appels).toHaveBeenCalledTimes(1);
    expect(String(appels.mock.calls[0][0])).toContain('departure_time=now');
    expect(r).toMatchObject({ totalDurationSeconds: 300, totalDistanceMeters: 1112 });
    expect(compteur.compter).toHaveBeenCalledWith('trajet_trafic');
    expect(compteur.compter).toHaveBeenCalledWith('trajet_reutilise');
  });

  it('livreur sorti de sa route, puis 5 minutes écoulées : Google est rappelé', async () => {
    const { maps } = monter();
    appels.mockImplementation(async () => reponse());

    await maps.getDirections(depuis(DEPART));
    await maps.getDirections(depuis(AILLEURS));
    expect(appels).toHaveBeenCalledTimes(2);

    maintenant.mockReturnValue(1_000_000 + DUREE_TRAJET_VIF_MS);
    await maps.getDirections(depuis({ latitude: 5.305, longitude: -4 }));
    expect(appels).toHaveBeenCalledTimes(3);
  });

  it('tournée à plusieurs arrêts : jamais reprise, les étapes comptent', async () => {
    const { maps } = monter();
    appels.mockImplementation(async () => reponse());

    await maps.getDirections(depuis(DEPART));
    await maps.getDirections({ ...depuis(MILIEU), waypoints: [AILLEURS] });

    expect(appels).toHaveBeenCalledTimes(2);
    expect(String(appels.mock.calls[1][0])).toContain('waypoints=');
  });

  it('vignette du panier : pas d’appel avec trafic, le tracé des frais suffit', async () => {
    const { maps, compteur } = monter();
    const image = {
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array(2048).buffer,
    } as unknown as Response;
    appels.mockResolvedValueOnce(reponse()).mockResolvedValueOnce(image);

    await maps.staticRoute({ ...depuis(DEPART), width: 400, height: 200, scale: 2 });

    const adresses = appels.mock.calls.map(([url]) => String(url));
    expect(adresses[0]).toContain('/directions/json');
    expect(adresses[0]).not.toContain('departure_time');
    expect(compteur.compter).not.toHaveBeenCalledWith('trajet_trafic');
    expect(adresses[1]).toContain('/staticmap');
    expect(decodeURIComponent(adresses[1])).toContain('5.31000,-4.00000');
  });
});
