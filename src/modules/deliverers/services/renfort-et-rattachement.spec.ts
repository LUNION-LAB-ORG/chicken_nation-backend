/**
 * Gestion des livreurs simplifiée (demande du 09/11) :
 *  - liste des livreurs : « En renfort près de … » quand un livreur libre est
 *    plus près d'un autre restaurant qui livre avec nos livreurs ;
 *  - changer de restaurant : ses plannings suivent (réponse `plannings`) ;
 *  - valider avec le restaurant : rattaché et ajouté à ses plannings.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DelivererStatus, DeliveryService, EntityStatus } from '@prisma/client';

import { DelivererChannels } from '../enums/deliverer-channels';
import { DelivererEvent } from '../events/deliverer.event';
import { DeliverersService } from './deliverers.service';

const M = new Date('2026-11-09T12:00:00.000Z');
const ilYA = (min: number) => new Date(M.getTime() - min * 60_000);
const KM_LNG = 1 / 110.8;
const ZONE4 = { id: 'r-zone4', name: 'Zone 4', latitude: 5.286, longitude: -3.9737 };
const FAYA = { id: 'r-faya', name: 'Faya', latitude: 5.286, longitude: -3.9737 + 8 * KM_LNG };
const PRES_DE_ZONE_4 = { lat: 5.286, lng: -3.9737 + 0.5 * KM_LNG };

beforeEach(() => {
  jest.useFakeTimers({ now: M, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

function ligne(id: string, position: { lat: number; lng: number }, surcharge: Record<string, unknown> = {}) {
  return {
    id,
    first_name: id,
    last_name: 'Test',
    image: null,
    type_vehicule: 'MOTO',
    restaurant_id: FAYA.id,
    restaurant: FAYA,
    last_location: position,
    last_location_at: ilYA(1),
    last_speed_kmh: null,
    last_heading_deg: null,
    last_available_at: ilYA(30),
    pause_until: null,
    auto_pause_until: null,
    dernier_signal_at: ilYA(1),
    protocole_appli: 4,
    expo_push_token: 'jeton',
    status: DelivererStatus.ACTIVE,
    is_operational: true,
    entity_status: EntityStatus.ACTIVE,
    offer_attempts: [],
    _count: { courses: 0, offer_attempts: 0 },
    courses: [],
    ...surcharge,
  };
}

function listeAvec(valeurs: Record<string, string>) {
  const lignes = [
    ligne('koffi', PRES_DE_ZONE_4),
    ligne('awa', { lat: FAYA.latitude, lng: FAYA.longitude }),
    ligne('pause', PRES_DE_ZONE_4, { pause_until: new Date(M.getTime() + 600_000) }),
    ligne('vieux', PRES_DE_ZONE_4, { last_location_at: ilYA(20) }),
  ];
  const prisma = {
    deliverer: { findMany: jest.fn(async () => lignes) },
    restaurant: { findMany: jest.fn(async () => [ZONE4, FAYA]) },
  };
  const reglages = { gpsExpirationMinutes: 5, appliFermeeApresS: 180, facteurRetard: 1.5, offreJoignablesSeulement: false };
  const service = new DeliverersService(
    prisma as never,
    {} as never,
    {} as never,
    { load: jest.fn(async () => reglages), lireValeurs: jest.fn(async () => valeurs) } as never,
    {} as never,
    { livreursConnectes: jest.fn(async () => new Set<string>()) } as never,
  );
  return async () =>
    Object.fromEntries((await service.getLiveLocations({ includeOffline: true })).map((l) => [l.id, l.renfort] as const));
}

describe('liste des livreurs : « En renfort près de … »', () => {
  const NOS_LIVREURS = { 'delivery.default_service': DeliveryService.CHICKEN_NATION };

  it('libre près de Zone 4 : renfort ; à Faya, en pause ou position périmée : rien', async () => {
    const renforts = await listeAvec(NOS_LIVREURS)();
    expect(renforts).toEqual({
      koffi: { restaurant_id: ZONE4.id, restaurant_name: 'Zone 4' },
      awa: null,
      pause: null,
      vieux: null,
    });
  });

  it('réglage coupé : rien', async () => {
    expect((await listeAvec({ ...NOS_LIVREURS, 'course.renfort': 'non' })()).koffi).toBeNull();
  });

  it('Zone 4 confiée à Turbo : pas de renfort affiché vers elle', async () => {
    const turbo = { ...NOS_LIVREURS, 'delivery.service_by_restaurant': JSON.stringify({ [ZONE4.id]: DeliveryService.TURBO }) };
    expect((await listeAvec(turbo)()).koffi).toBeNull();
  });
});

describe('changer de restaurant et valider : les plannings suivent', () => {
  const REPONSE = { retire_de: [{ plan_id: 'p-faya', restaurant_id: FAYA.id, creneaux: 9 }], ajoute_a: [{ plan_id: 'p-zone4', restaurant_id: ZONE4.id, creneaux: 11 }] };

  function monter(livreur: Record<string, unknown>) {
    const ecrit: Record<string, unknown>[] = [];
    const prisma = {
      deliverer: {
        findUnique: jest.fn(async () => livreur),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          ecrit.push(data);
          return { ...livreur, ...data };
        }),
      },
      restaurant: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => [ZONE4, FAYA].find((r) => r.id === where.id) ?? null) },
    };
    const evenement = { operationalChanged: jest.fn(), restaurantChange: jest.fn(async () => [undefined, REPONSE]) };
    const push = { notifyAccountActivated: jest.fn() };
    const service = new DeliverersService(prisma as never, {} as never, evenement as never, {} as never, push as never, {} as never);
    return { service, evenement, ecrit };
  }

  const ACTIF = { id: 'koffi', status: DelivererStatus.ACTIVE, entity_status: EntityStatus.ACTIVE, restaurant_id: FAYA.id };

  it('livreur actif passé de Faya à Zone 4 : le planning est prévenu et sa réponse rendue', async () => {
    const t = monter(ACTIF);
    const r = await t.service.assignRestaurant('koffi', { restaurant_id: ZONE4.id });
    expect(t.evenement.restaurantChange).toHaveBeenCalledWith({
      delivererId: 'koffi',
      ancienRestaurantId: FAYA.id,
      nouveauRestaurantId: ZONE4.id,
    });
    expect(r.plannings).toEqual(REPONSE);
  });

  it('même restaurant, ou livreur pas encore actif : plannings intouchés', async () => {
    const meme = monter(ACTIF);
    expect((await meme.service.assignRestaurant('koffi', { restaurant_id: FAYA.id })).plannings).toBeNull();
    const enAttente = monter({ ...ACTIF, status: DelivererStatus.PENDING_VALIDATION });
    expect((await enAttente.service.assignRestaurant('koffi', { restaurant_id: ZONE4.id })).plannings).toBeNull();
    expect(meme.evenement.restaurantChange).not.toHaveBeenCalled();
    expect(enAttente.evenement.restaurantChange).not.toHaveBeenCalled();
  });

  it('valider avec le restaurant : rattaché, opérationnel et ajouté à ses plannings, en un geste', async () => {
    const t = monter({
      ...ACTIF,
      status: DelivererStatus.PENDING_VALIDATION,
      restaurant_id: null,
      piece_identite: 'cni.jpg',
      permis_conduire: 'permis.jpg',
    });
    const r = await t.service.validate('koffi', ZONE4.id);
    expect(t.ecrit[0]).toMatchObject({ status: DelivererStatus.ACTIVE, is_operational: true, restaurant_id: ZONE4.id });
    expect(t.evenement.restaurantChange).toHaveBeenCalledWith({
      delivererId: 'koffi',
      ancienRestaurantId: null,
      nouveauRestaurantId: ZONE4.id,
    });
    expect(r.plannings).toEqual(REPONSE);
  });

  it('valider sans restaurant (ancien écran) : comme avant, ajouté aux plannings du sien s’il en a un', async () => {
    const t = monter({ ...ACTIF, status: DelivererStatus.PENDING_VALIDATION, piece_identite: 'a', permis_conduire: 'b' });
    await t.service.validate('koffi');
    expect(t.ecrit[0]).not.toHaveProperty('restaurant_id');
    expect(t.evenement.restaurantChange).toHaveBeenCalledWith(expect.objectContaining({ nouveauRestaurantId: FAYA.id }));
  });

  it('restaurant inconnu à la validation : refusé avant toute écriture', async () => {
    const t = monter({ ...ACTIF, status: DelivererStatus.PENDING_VALIDATION, piece_identite: 'a', permis_conduire: 'b' });
    await expect(t.service.validate('koffi', 'r-inconnu')).rejects.toThrow('Restaurant non trouvé ou inactif');
    expect(t.ecrit).toEqual([]);
  });
});

describe('DelivererEvent.restaurantChange : attend le planning, ne lève jamais', () => {
  it('rend les réponses des écouteurs ; un écouteur en erreur donne une liste vide', async () => {
    const bus = new EventEmitter2();
    const evenement = new DelivererEvent(bus);
    bus.on(DelivererChannels.DELIVERER_RESTAURANT_CHANGED, async () => ({ ajoute_a: [], retire_de: [] }));
    expect(await evenement.restaurantChange({ delivererId: 'k', ancienRestaurantId: null, nouveauRestaurantId: 'z' })).toEqual([
      { ajoute_a: [], retire_de: [] },
    ]);

    const enPanne = new EventEmitter2();
    enPanne.on(DelivererChannels.DELIVERER_RESTAURANT_CHANGED, async () => {
      throw new Error('base indisponible');
    });
    expect(await new DelivererEvent(enPanne).restaurantChange({ delivererId: 'k', ancienRestaurantId: null, nouveauRestaurantId: 'z' })).toEqual([]);
  });
});

/**
 * « Affecter à un livreur » (demande du 10/11) : tous les livreurs qui peuvent
 * livrer la commande, y compris ceux d'un autre restaurant détectés près de
 * celui de la commande (la règle du planificateur) ou déjà en course pour lui.
 */
describe('livreurs proposés pour « Affecter à un livreur »', () => {
  const EN_PAUSE = { pause_until: new Date(M.getTime() + 600_000) };

  function monterAffectation(valeurs: Record<string, string> = {}) {
    // Candidats au renfort de Zone 4 (lecture `whereCandidatsRenfort`) : d'autres restaurants.
    const candidats = [
      ligne('koffi', PRES_DE_ZONE_4),
      ligne('awa', { lat: FAYA.latitude, lng: FAYA.longitude }),
      ligne('renfort-en-pause', PRES_DE_ZONE_4, EN_PAUSE),
    ];
    // Ce que la liste lit ensuite : ceux de Zone 4, les renforts, ceux en course pour Zone 4.
    const lignes = [
      ligne('zone4-dispo', { lat: ZONE4.latitude, lng: ZONE4.longitude }, { restaurant_id: ZONE4.id, restaurant: ZONE4 }),
      ligne('zone4-pause', { lat: ZONE4.latitude, lng: ZONE4.longitude }, { restaurant_id: ZONE4.id, restaurant: ZONE4, ...EN_PAUSE }),
      ligne('koffi', PRES_DE_ZONE_4),
      ligne('renfort-en-pause', PRES_DE_ZONE_4, EN_PAUSE),
      ligne('faya-en-course-ici', PRES_DE_ZONE_4, { last_available_at: null, _count: { courses: 1, offer_attempts: 0 } }),
    ];
    const lectures: Record<string, any>[] = [];
    const prisma = {
      deliverer: {
        findMany: jest.fn(async (args: Record<string, any>) => {
          lectures.push(args);
          if (args.select) {
            const ids: string[] | undefined = args.where?.id?.in;
            return candidats.filter((c) => !ids || ids.includes(c.id));
          }
          return lignes;
        }),
      },
      restaurant: { findMany: jest.fn(async () => [ZONE4, FAYA]) },
    };
    const reglages = { gpsExpirationMinutes: 5, appliFermeeApresS: 180, facteurRetard: 1.5, offreJoignablesSeulement: false };
    const service = new DeliverersService(
      prisma as never,
      {} as never,
      {} as never,
      { load: jest.fn(async () => reglages), lireValeurs: jest.fn(async () => valeurs) } as never,
      {} as never,
      { livreursConnectes: jest.fn(async () => new Set<string>()) } as never,
    );
    return { service, lectures };
  }

  it('renfortsPour : libre près de Zone 4, avec sa distance ; à Faya : non ; même lecture que le planificateur', async () => {
    const t = monterAffectation();
    const renforts = await t.service.renfortsPour(ZONE4.id, M);

    expect([...renforts.keys()].sort()).toEqual(['koffi', 'renfort-en-pause']);
    expect(Math.round(renforts.get('koffi')!.distance_m / 100)).toBe(5);
    expect(t.lectures[0].where).toMatchObject({
      restaurant_id: { not: ZONE4.id },
      status: DelivererStatus.ACTIVE,
      is_operational: true,
      last_location_at: { gte: ilYA(5) },
    });
  });

  it('renfortsPour sur un seul livreur : ne lit que lui ; réglage coupé : aucun, sans lecture', async () => {
    const t = monterAffectation();
    expect([...(await t.service.renfortsPour(ZONE4.id, M, ['awa'])).keys()]).toEqual([]);
    expect(t.lectures[0].where.id).toEqual({ in: ['awa'] });

    const coupe = monterAffectation({ 'course.renfort': 'non' });
    expect((await coupe.service.renfortsPour(ZONE4.id, M)).size).toBe(0);
    expect(coupe.lectures).toHaveLength(0);
  });

  it('liste : ceux du restaurant (même en pause), le renfort libre, celui en course ici ; jamais un renfort en pause', async () => {
    const t = monterAffectation();
    const items = await t.service.livreursPourAffectation(ZONE4.id, M);
    const parId = Object.fromEntries(items.map((l) => [l.id, l.renfort] as const));

    expect(Object.keys(parId).sort()).toEqual(['faya-en-course-ici', 'koffi', 'zone4-dispo', 'zone4-pause']);
    expect(parId['zone4-dispo']).toBeNull();
    expect(parId['zone4-pause']).toBeNull();
    expect(parId.koffi).toMatchObject({ restaurant_id: FAYA.id, restaurant_name: 'Faya' });
    expect(Math.round(parId.koffi!.distance_m! / 100)).toBe(5);
    expect(parId['faya-en-course-ici']).toEqual({ restaurant_id: FAYA.id, restaurant_name: 'Faya', distance_m: null });

    // Lecture de la liste : son restaurant, les renforts détectés, ceux en course pour lui.
    const liste = t.lectures.find((a) => a.include)!;
    expect(liste.where.status).toBe(DelivererStatus.ACTIVE);
    expect(liste.where.OR).toEqual([
      { restaurant_id: ZONE4.id },
      { id: { in: expect.arrayContaining(['koffi', 'renfort-en-pause']) } },
      { courses: { some: expect.objectContaining({ restaurant_id: ZONE4.id, turbo_escalated_at: null }) } },
    ]);
  });

  it('réglage du renfort coupé : pas de renfort libre, celui déjà en course ici reste proposé', async () => {
    const t = monterAffectation({ 'course.renfort': 'non' });
    await t.service.livreursPourAffectation(ZONE4.id, M);
    const liste = t.lectures.find((a) => a.include)!;
    expect(liste.where.OR).toEqual([
      { restaurant_id: ZONE4.id },
      { courses: { some: expect.objectContaining({ restaurant_id: ZONE4.id }) } },
    ]);
  });
});
