/**
 * REGROUPEMENT PAR TOURNÉE côté services (retour du client du 28/10,
 * conception `regroupement-tournee.md`, T10 et T11) : distances entre
 * commandes à regrouper lues dans le cache routier seulement, appels Google
 * lancés sans attendre et bornés (6 par passage, jamais deux fois en vol,
 * échec sauté 10 min), jamais pour une paire compatible, perdue d'avance,
 * ou sans distance depuis le restaurant.
 *
 * ⚠️ Aucun appel réel à Google : `MapsService` est simulé.
 */
import { OrderStatus } from '@prisma/client';

import { appliLivreurSimulee } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { ILatLng } from '../helpers/geo.helper';
import { clePaire, REGLAGES_PLANIFICATION_DEFAUT, ReglagesPlanification } from '../helpers/planification.rules';
import { APPELS_REGROUPEMENT_PAR_PASSAGE } from '../helpers/regroupement-tournee.rules';
import { commande, monterBaseDispatch, RESTO } from './base-dispatch.simulee-spec';
import { DirectionService } from './direction.service';
import { InstantanePlanificationService } from './instantane-planification.service';

const MAINTENANT = new Date('2026-10-28T12:15:00.000Z');
const ZONE_4: ILatLng = { lat: 5.286, lng: -3.9737 };

/** Point à `km` du restaurant, cap en degrés (0 = nord, 90 = est). */
function polaire(km: number, capDeg: number): ILatLng {
  const parDegre = (Math.PI / 180) * 6_371_000;
  const nord = km * 1000 * Math.cos((capDeg * Math.PI) / 180);
  const est = km * 1000 * Math.sin((capDeg * Math.PI) / 180);
  return { lat: ZONE_4.lat + nord / parDegre, lng: ZONE_4.lng + est / (parDegre * Math.cos((ZONE_4.lat * Math.PI) / 180)) };
}

/** Un point à la précision de la clé du cache routier. */
const pos = (p: ILatLng) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
const cle = (o: ILatLng, d: ILatLng) => `${pos(o)}>${pos(d)}`;

interface Trajet {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
}

interface Client {
  position: ILatLng;
  /** Restaurant → client par la route ; `null` : Google n'a rien rendu. */
  route: number | null;
  /** Prête il y a ce nombre de minutes. */
  preteIlYa?: number;
}

/**
 * Commandes prêtes sans course, aux positions données ; le restaurant →
 * client par la route vient du simulateur de Google (`direction`), les
 * distances entre clients du cache `cache` (un sens).
 */
function monter(clients: Client[], cache: Map<string, number> = new Map()) {
  const commandes = clients.map((c, i) =>
    commande({
      status: OrderStatus.READY,
      address: { latitude: c.position.lat, longitude: c.position.lng },
      created_at: new Date(MAINTENANT.getTime() - (20 + (c.preteIlYa ?? i)) * 60_000),
      ready_at: new Date(MAINTENANT.getTime() - (c.preteIlYa ?? i) * 60_000),
      updated_at: MAINTENANT,
    }),
  );
  const routes = new Map(clients.map((c) => [`${c.position.lat.toFixed(6)},${c.position.lng.toFixed(6)}`, c.route]));
  const base = monterBaseDispatch({ commandes });
  const maps = {
    itineraireRoutier: jest.fn((p: Trajet, options?: { pour?: string }): Promise<unknown> => {
      if (options?.pour === 'regroupement' || options?.pour === 'ordre') return new Promise(() => undefined); // Google lent : jamais attendu
      const m = routes.get(`${p.destLat.toFixed(6)},${p.destLng.toFixed(6)}`);
      return Promise.resolve(m ? { metres: m, secondes: 0, polyligne: '' } : null);
    }),
    trajetEnCache: jest.fn(async (o: ILatLng, d: ILatLng) => cache.get(cle(o, d)) ?? null),
    detourSansTrafic: jest.fn(async () => null),
  };
  const instantanes = new InstantanePlanificationService(
    base.prisma,
    new DirectionService(maps as never, {} as never),
    { estimer: jest.fn(async () => new Map()) } as never,
    maps as never,
    { load: jest.fn() } as never,
    appliLivreurSimulee(base.prisma).service,
  );
  const lire = (google = true, r: ReglagesPlanification = REGLAGES_PLANIFICATION_DEFAUT) => instantanes.lire(RESTO, MAINTENANT, r, google);
  const appels = () => maps.itineraireRoutier.mock.calls.filter(([, o]) => o?.pour === 'regroupement');
  const demandees = () => appels().map(([p]) => cle({ lat: p.originLat, lng: p.originLng }, { lat: p.destLat, lng: p.destLng }));
  return { base, maps, lire, appels, demandees, commandes: commandes as { id: string }[] };
}

/** Le cas du client (T3) : A à 4 km cap 20°, B à 4,5 km cap 65°, « détour trop long ». */
const A_T3: Client = { position: { lat: 5.3198, lng: -3.9613 }, route: 5600, preteIlYa: 1 };
const B_T3: Client = { position: { lat: 5.3031, lng: -3.9369 }, route: 6300, preteIlYa: 0 };

describe('T10. distance entre les deux commandes manquante, puis connue', () => {
  it('passage 1 : rien en cache, un appel regroupement_route lancé du plus proche vers le plus lointain, sans l’attendre', async () => {
    const t = monter([A_T3, B_T3]);
    const lu = await t.lire(); // Google ne répond jamais : le passage n'attend pas.
    expect(lu.entreCandidats!.size).toBe(0);
    expect(t.demandees()).toEqual([cle(A_T3.position, B_T3.position)]);
  });

  it('passage 2 : la distance est en cache (un sens ou l’autre), elle entre dans la table du second avis, sans appel', async () => {
    const cache = new Map([[cle(B_T3.position, A_T3.position), 4200]]);
    const t = monter([A_T3, B_T3], cache);
    const lu = await t.lire();
    const [a, b] = t.commandes;
    expect(lu.entreCandidats!.get(clePaire(a.id, b.id))).toBe(4200);
    // La règle d'aujourd'hui n'en voit rien : la matrice de l'ordre des arrêts reste vide.
    expect(lu.matrice!.size).toBe(0);
    expect(t.appels()).toEqual([]);
  });

  it('Google coupé par réglage : la règle d’aujourd’hui, rien lu ni demandé', async () => {
    const t = monter([A_T3, B_T3]);
    const lu = await t.lire(false);
    expect(lu.entreCandidats!.size).toBe(0);
    expect(t.maps.trajetEnCache).not.toHaveBeenCalled();
    expect(t.appels()).toEqual([]);
  });

  it('distance depuis le restaurant inconnue pour l’une : ni lecture, ni appel', async () => {
    const t = monter([A_T3, { ...B_T3, route: null }]);
    const lu = await t.lire();
    expect(lu.entreCandidats!.size).toBe(0);
    expect(t.maps.trajetEnCache).not.toHaveBeenCalled();
    expect(t.appels()).toEqual([]);
  });

  it('interrupteur coupé : ni lecture, ni appel', async () => {
    const t = monter([A_T3, B_T3]);
    const lu = await t.lire(true, { ...REGLAGES_PLANIFICATION_DEFAUT, regroupementTournee: false });
    expect(lu.entreCandidats!.size).toBe(0);
    expect(t.maps.trajetEnCache).not.toHaveBeenCalled();
    expect(t.appels()).toEqual([]);
  });
});

describe('T11. coût Google borné', () => {
  /** 12 commandes prêtes tout autour du restaurant, à 2 ou 3 km. */
  const autour = (): Client[] =>
    Array.from({ length: 12 }, (_, i) => {
      const km = i % 2 ? 3 : 2;
      return { position: polaire(km, i * 30), route: km * 1400, preteIlYa: 12 - i };
    });

  it('au plus 6 appels par passage, jamais attendus, jamais deux fois la même paire en vol ; jamais une paire compatible', async () => {
    const t = monter(autour());
    const lu = await t.lire();
    expect(lu.entreCandidats!.size).toBe(0);
    expect(t.appels()).toHaveLength(APPELS_REGROUPEMENT_PAR_PASSAGE);
    await t.lire();
    expect(t.appels()).toHaveLength(2 * APPELS_REGROUPEMENT_PAR_PASSAGE);
    expect(new Set(t.demandees()).size).toBe(2 * APPELS_REGROUPEMENT_PAR_PASSAGE);

    // Chaque paire demandée est refusée par la direction.
    const parPosition = new Map(t.commandes.map((c, i) => [pos(autour()[i].position), c.id]));
    for (const [p] of t.appels()) {
      const o = parPosition.get(pos({ lat: p.originLat, lng: p.originLng }))!;
      const d = parPosition.get(pos({ lat: p.destLat, lng: p.destLng }))!;
      expect(lu.verdicts.get(clePaire(o, d))?.compatible).toBe(false);
    }
  });

  it('les plus anciennes commandes prêtes d’abord', async () => {
    const clients = autour();
    const t = monter(clients);
    await t.lire();
    // La plus ancienne (prête il y a 12 min) est dans la première paire demandée.
    const [[p]] = t.appels();
    const touche = [pos({ lat: p.originLat, lng: p.originLng }), pos({ lat: p.destLat, lng: p.destLng })];
    expect(touche).toContain(pos(clients[0].position));
  });

  it('Google sans réponse : les paires en échec sont sautées 10 min sans prendre de place', async () => {
    const t = monter(autour());
    t.maps.itineraireRoutier.mockImplementation((_p: Trajet, o?: { pour?: string }) =>
      o?.pour === 'regroupement' || o?.pour === 'ordre'
        ? Promise.resolve(null)
        : Promise.resolve({ metres: 2800, secondes: 0, polyligne: '' }),
    );
    const vider = () => new Promise((r) => setImmediate(r));
    const debut = Date.now();
    const horloge = jest.spyOn(Date, 'now').mockReturnValue(debut);
    try {
      await t.lire();
      await vider();
      expect(t.appels()).toHaveLength(6);
      await t.lire();
      await vider();
      // Les 6 en échec ne sont pas redemandées : 6 autres partent.
      expect(t.appels()).toHaveLength(12);
      expect(new Set(t.demandees()).size).toBe(12);
    } finally {
      horloge.mockRestore();
    }
  });

  it('paire perdue d’avance (tournée sûrement au-delà du plafond) : jamais demandée', async () => {
    const t = monter([
      { position: polaire(12, 0), route: 15_000 },
      { position: polaire(12, 180), route: 15_000 },
    ]);
    await t.lire();
    expect(t.maps.trajetEnCache).not.toHaveBeenCalled();
    expect(t.appels()).toEqual([]);
  });

  it('même adresse ou même direction : rien à demander (la règle d’aujourd’hui les groupe)', async () => {
    const t = monter([
      { position: polaire(2, 90), route: 2800 },
      { position: polaire(2.05, 90), route: 2870 },
      { position: polaire(3, 92), route: 4200 },
    ]);
    await t.lire();
    expect(t.appels()).toEqual([]);
  });
});
