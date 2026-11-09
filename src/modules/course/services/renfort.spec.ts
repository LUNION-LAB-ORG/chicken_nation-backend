/**
 * Renfort entre restaurants (demande du 09/11) : « un livreur affecté à Faya
 * livre une course près d'Angré : l'appli le détecte à Angré et il peut
 * livrer une commande d'Angré ». Règle de priorité choisie : le plus rapide
 * (un livreur du restaurant au comptoir passe d'abord).
 *
 * Banc : le planificateur de Zone 4 (`RESTO`) sur la base simulée, un second
 * restaurant (« Faya ») à 8 km à l'est.
 */
import { CourseOfferStatus, CourseStatut, DeliveryService } from '@prisma/client';

import { livreParNosLivreurs, restaurantsDeRenfort } from '../helpers/renfort.rules';
import { course, livreur } from './base-dispatch.simulee-spec';
import { AU_COMPTOIR, avant, KM_LNG, MAINTENANT, monter, prete, RESTAURANT } from './banc-planificateur.simulee-spec';

const FAYA = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const POSITION_FAYA = { lat: RESTAURANT.lat, lng: RESTAURANT.lng + 8 * KM_LNG };
const RESTAURANT_FAYA = { id: FAYA, name: 'Faya', latitude: POSITION_FAYA.lat, longitude: POSITION_FAYA.lng };

/** À 500 m de Zone 4, côté Faya : 7,5 km de Faya. */
const PRES_DE_ZONE_4 = { last_location: { lat: RESTAURANT.lat, lng: RESTAURANT.lng + 0.5 * KM_LNG }, last_location_at: avant(60) };

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('restaurantsDeRenfort : où un livreur libre peut prêter main-forte', () => {
  const zone4 = { id: 'zone4', name: 'Zone 4', position: RESTAURANT };
  const faya = { id: 'faya', name: 'Faya', position: POSITION_FAYA };
  const angre = { id: 'angre', name: 'Angré', position: { lat: RESTAURANT.lat, lng: RESTAURANT.lng + 2 * KM_LNG } };
  const tous = [zone4, faya, angre];
  const a = (km: number) => ({ lat: RESTAURANT.lat, lng: RESTAURANT.lng + km * KM_LNG });

  it('livreur de Faya à 500 m de Zone 4 : Zone 4, puis Angré (1,5 km), du plus proche au plus loin', () => {
    const r = restaurantsDeRenfort(a(0.5), 'faya', tous, 3000);
    expect(r.map((x) => x.id)).toEqual(['zone4', 'angre']);
    expect(Math.round(r[0].distance_m / 100)).toBe(5);
  });

  it('au-delà du rayon : aucun', () => {
    expect(restaurantsDeRenfort(a(-4), 'faya', tous, 3000)).toEqual([]);
  });

  it('plus près de son restaurant que de l’autre : jamais', () => {
    // À 6 km de Zone 4 : Faya à 2 km, Angré à 4 km, Zone 4 à 6 km.
    expect(restaurantsDeRenfort(a(6), 'faya', tous, 10_000)).toEqual([]);
    // À 4,5 km : Angré (2,5 km) est plus près que Faya (3,5 km), Zone 4 (4,5 km) non.
    expect(restaurantsDeRenfort(a(4.5), 'faya', tous, 10_000).map((x) => x.id)).toEqual(['angre']);
  });

  it('jamais son propre restaurant ; sans position ou sans restaurant : aucun', () => {
    // Livreur de Zone 4 à 500 m d'Angré : Angré seulement, jamais Zone 4.
    expect(restaurantsDeRenfort(a(1.5), 'zone4', tous, 3000).map((x) => x.id)).toEqual(['angre']);
    // Au comptoir de Zone 4 : aucun autre n'est plus près.
    expect(restaurantsDeRenfort(RESTAURANT, 'zone4', tous, 3000)).toEqual([]);
    expect(restaurantsDeRenfort(null, 'faya', tous, 3000)).toEqual([]);
    expect(restaurantsDeRenfort(a(0.5), null, tous, 3000)).toEqual([]);
  });

  it('son restaurant sans coordonnées : la distance seule décide', () => {
    const sansPosition = [zone4, { id: 'faya', name: 'Faya', position: null }];
    expect(restaurantsDeRenfort(a(0.5), 'faya', sansPosition, 3000).map((x) => x.id)).toEqual(['zone4']);
  });
});

describe('livreParNosLivreurs : le renfort ne sert que là où nos livreurs livrent', () => {
  it('réglage par restaurant, sinon le défaut, Turbo s’il manque ou est illisible', () => {
    expect(livreParNosLivreurs({}, 'r1')).toBe(false);
    expect(livreParNosLivreurs({ 'delivery.default_service': DeliveryService.CHICKEN_NATION }, 'r1')).toBe(true);
    const parRestaurant = JSON.stringify({ r1: DeliveryService.CHICKEN_NATION, r2: DeliveryService.TURBO });
    expect(livreParNosLivreurs({ 'delivery.service_by_restaurant': parRestaurant }, 'r1')).toBe(true);
    expect(
      livreParNosLivreurs(
        { 'delivery.service_by_restaurant': parRestaurant, 'delivery.default_service': DeliveryService.CHICKEN_NATION },
        'r2',
      ),
    ).toBe(false);
    expect(livreParNosLivreurs({ 'delivery.service_by_restaurant': '{oups', 'delivery.default_service': 'CHICKEN_NATION' }, 'r1')).toBe(true);
  });
});

describe('planificateur : un livreur libre d’un autre restaurant, près de celui-ci, reçoit ses courses', () => {
  const offresEnAttente = (t: ReturnType<typeof monter>) =>
    t.base.offres.filter((o) => o.status === CourseOfferStatus.PENDING);

  it('seul livreur libre près de Zone 4 : la course de Zone 4 lui est proposée, notée « renfort » au journal', async () => {
    const renfort = livreur({ ...PRES_DE_ZONE_4, restaurant_id: FAYA });
    const t = monter({ commandes: [prete()], livreurs: [renfort], restaurants: [RESTAURANT_FAYA] });

    await t.passer();

    expect(offresEnAttente(t)).toEqual([expect.objectContaining({ deliverer_id: renfort.id })]);
    expect(t.journalDe('OFFRE_PLANIFIEE')).toEqual([
      expect.objectContaining({ deliverer_id: renfort.id, details: expect.objectContaining({ renfort: true }) }),
    ]);
  });

  it('réglage « course.renfort » à non : rien, comme avant', async () => {
    const renfort = livreur({ ...PRES_DE_ZONE_4, restaurant_id: FAYA });
    const t = monter({ commandes: [prete()], livreurs: [renfort], restaurants: [RESTAURANT_FAYA] }, { reglages: { 'course.renfort': '0' } });

    await t.passer();

    expect(offresEnAttente(t)).toEqual([]);
  });

  it('le plus rapide : un livreur de Zone 4 au comptoir passe avant le renfort', async () => {
    const renfort = livreur({ ...PRES_DE_ZONE_4, restaurant_id: FAYA, last_available_at: avant(3600) });
    const maison = livreur({ ...AU_COMPTOIR, last_available_at: avant(60) });
    const t = monter({ commandes: [prete()], livreurs: [renfort, maison], restaurants: [RESTAURANT_FAYA] });

    await t.passer();

    expect(offresEnAttente(t)).toEqual([expect.objectContaining({ deliverer_id: maison.id })]);
    expect(t.journalDe('OFFRE_PLANIFIEE')[0].details).not.toHaveProperty('renfort');
  });

  it('en course pour Faya : jamais sollicité par Zone 4', async () => {
    const renfort = livreur({ ...PRES_DE_ZONE_4, restaurant_id: FAYA });
    const saCourse = course({ restaurant_id: FAYA, statut: CourseStatut.ACCEPTED, deliverer_id: renfort.id, assigned_at: avant(120) });
    const t = monter({ commandes: [prete()], courses: [saCourse], livreurs: [renfort], restaurants: [RESTAURANT_FAYA] });

    await t.passer();

    expect(offresEnAttente(t)).toEqual([]);
  });

  it('position de plus de 5 min : il n’est plus réputé près de Zone 4', async () => {
    const renfort = livreur({ ...PRES_DE_ZONE_4, last_location_at: avant(6 * 60), restaurant_id: FAYA });
    const t = monter({ commandes: [prete()], livreurs: [renfort], restaurants: [RESTAURANT_FAYA] });

    await t.passer();

    expect(offresEnAttente(t)).toEqual([]);
  });

  it('rayon réglé à 400 m : à 500 m, il n’est pas sollicité', async () => {
    const renfort = livreur({ ...PRES_DE_ZONE_4, restaurant_id: FAYA });
    const t = monter(
      { commandes: [prete()], livreurs: [renfort], restaurants: [RESTAURANT_FAYA] },
      { reglages: { 'course.renfort_rayon_m': '400' } },
    );

    await t.passer();

    expect(offresEnAttente(t)).toEqual([]);
  });
});
