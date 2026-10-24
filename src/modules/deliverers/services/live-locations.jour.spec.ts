/**
 * `GET /deliverers/live-locations` complété (conception du 24/10, 11.5) :
 * place dans la file PAR restaurant, coordonnées du restaurant, champs de la
 * course en cours (fin prévue, retard), et avec `jour=true` : planning du
 * jour, temps en ligne du minuteur tenu par le serveur, courses du jour.
 * Rien n'est retiré (`queue_rank` reste pour les anciens écrans).
 */
import { CourseStatut, DelivererStatus, EntityStatus, ShiftAssignmentStatus, ShiftType } from '@prisma/client';

import { DeliverersService } from './deliverers.service';

const M = new Date('2026-10-24T12:00:00.000Z');
const ilYA = (min: number) => new Date(M.getTime() - min * 60_000);
const ANGRE = { id: 'r-angre', name: 'Angré', latitude: 5.39, longitude: -3.97 };
const MARCORY = { id: 'r-marcory', name: 'Marcory', latitude: 5.3, longitude: -3.98 };

beforeEach(() => {
  jest.useFakeTimers({ now: M, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

function ligne(p: {
  id: string;
  restaurant: typeof ANGRE;
  last_available_at?: Date | null;
  courses?: unknown[];
}) {
  const courses = p.courses ?? [];
  return {
    id: p.id,
    first_name: p.id,
    last_name: 'Test',
    image: null,
    type_vehicule: 'MOTO',
    restaurant_id: p.restaurant.id,
    restaurant: p.restaurant,
    last_location: { lat: 5.3, lng: -3.9 },
    last_location_at: ilYA(1),
    last_speed_kmh: null,
    last_heading_deg: null,
    last_available_at: p.last_available_at ?? null,
    pause_until: null,
    auto_pause_until: null,
    dernier_signal_at: ilYA(1),
    protocole_appli: 4,
    expo_push_token: 'jeton',
    status: DelivererStatus.ACTIVE,
    is_operational: true,
    entity_status: EntityStatus.ACTIVE,
    offer_attempts: [],
    _count: { courses: courses.length, offer_attempts: 0 },
    courses,
  };
}

const COURSE_YAO = {
  id: 'c-yao',
  reference: 'CRS-241024-0042',
  statut: CourseStatut.IN_DELIVERY,
  restaurant_id: ANGRE.id,
  pickup_code: '614',
  assigned_at: ilYA(80),
  at_restaurant_at: ilYA(70),
  picked_up_at: ilYA(60),
  parti_at: ilYA(55),
  motif_depart: 'POSITION',
  estimated_duration_min: 30,
  delay_alerted_at: null,
  deliveries: [],
};

function monter(options: { minuteur?: Map<string, number> | null } = {}) {
  const lignes = [
    ligne({ id: 'koffi', restaurant: ANGRE, last_available_at: ilYA(120) }),
    ligne({ id: 'awa', restaurant: ANGRE, last_available_at: ilYA(180) }),
    ligne({ id: 'moussa', restaurant: MARCORY, last_available_at: ilYA(60) }),
    ligne({ id: 'yao', restaurant: ANGRE, courses: [COURSE_YAO] }),
  ];
  const prisma = {
    deliverer: { findMany: jest.fn(async () => lignes) },
    schedulePlan: {
      findMany: jest.fn(async () => [
        {
          id: 'plan-1',
          restaurant_id: ANGRE.id,
          shifts: [
            {
              type: ShiftType.MORNING,
              start_time: '09:00',
              end_time: '15:00',
              assignments: [
                { deliverer_id: 'awa', status: ShiftAssignmentStatus.CONFIRMED },
                { deliverer_id: 'yao', status: ShiftAssignmentStatus.REFUSED },
              ],
            },
            {
              type: ShiftType.EVENING,
              start_time: '15:00',
              end_time: '23:00',
              assignments: [{ deliverer_id: 'awa', status: ShiftAssignmentStatus.ASSIGNED }],
            },
          ],
        },
      ]),
    },
    restDay: { findMany: jest.fn(async () => [{ deliverer_id: 'koffi' }]) },
    dailyPresenceCheck: { findMany: jest.fn(async () => []) },
    course: { groupBy: jest.fn(async () => [{ deliverer_id: 'awa', _count: { _all: 7 } }]) },
  };
  const reglages = { gpsExpirationMinutes: 5, appliFermeeApresS: 180, facteurRetard: 1.5, offreJoignablesSeulement: false };
  const minuteur = {
    lirePlusieurs: jest.fn(async () =>
      options.minuteur === undefined ? new Map([['awa', 11_520], ['yao', 9_600]]) : options.minuteur,
    ),
  };
  const service = new DeliverersService(
    prisma as never,
    {} as never,
    {} as never,
    { load: jest.fn(async () => reglages) } as never,
    {} as never,
    { livreursConnectes: jest.fn(async () => new Set<string>()) } as never,
    minuteur as never,
  );
  const parId = async (params: { jour?: boolean; restaurantId?: string } = {}) =>
    Object.fromEntries(
      (await service.getLiveLocations({ includeOffline: true, ...params })).map((l) => [l.id, l] as const),
    );
  return { prisma, minuteur, service, parId };
}

describe('GET /deliverers/live-locations : file par restaurant, restaurant, course', () => {
  it('rang_file : chaque restaurant a son 1er ; queue_rank (anciens écrans) inchangé', async () => {
    const t = monter();
    const l = await t.parId();
    expect([l.awa.rang_file, l.koffi.rang_file, l.moussa.rang_file, l.yao.rang_file]).toEqual([1, 2, 1, null]);
    expect([l.awa.queue_rank, l.koffi.queue_rank, l.moussa.queue_rank, l.yao.queue_rank]).toEqual([1, 2, 3, null]);
  });

  it('restaurant avec ses coordonnées ; course en cours : code, heures, fin prévue et retard', async () => {
    const t = monter();
    const l = await t.parId();
    expect(l.awa.restaurant).toEqual(ANGRE);
    expect(l.yao.active_course).toMatchObject({
      id: 'c-yao',
      restaurant_id: ANGRE.id,
      pickup_code: '614',
      at_restaurant_at: ilYA(70).toISOString(),
      picked_up_at: ilYA(60).toISOString(),
      parti_at: ilYA(55).toISOString(),
      estimated_duration_min: 30,
      fin_prevue: ilYA(25).toISOString(),
      en_retard: true,
      retard_min: 25,
    });
    expect(l.awa.active_course).toBeNull();
  });

  it('sans `jour` : ni planning, ni minuteur, ni courses du jour lus', async () => {
    const t = monter();
    const l = await t.parId();
    expect('creneau_du_jour' in l.awa).toBe(false);
    expect(t.prisma.schedulePlan.findMany).not.toHaveBeenCalled();
    expect(t.minuteur.lirePlusieurs).not.toHaveBeenCalled();
    expect(t.prisma.course.groupBy).not.toHaveBeenCalled();
  });
});

describe('GET /deliverers/live-locations?jour=true : vue Livreurs « Aujourd’hui »', () => {
  it('planning du jour, temps en ligne, courses terminées de la journée', async () => {
    const t = monter();
    const l = await t.parId({ jour: true });
    expect(l.awa).toMatchObject({
      creneau_du_jour: { matin: 'CONFIRMED', soir: 'ASSIGNED', repos: false },
      en_ligne_aujourdhui_s: 11_520,
      courses_du_jour: 7,
    });
    expect(l.yao).toMatchObject({
      creneau_du_jour: { matin: 'REFUSED', soir: null, repos: false },
      en_ligne_aujourdhui_s: 9_600,
      courses_du_jour: 0,
    });
    expect(l.koffi).toMatchObject({
      creneau_du_jour: { matin: null, soir: null, repos: true },
      en_ligne_aujourdhui_s: 0,
    });
    // Une seule lecture du minuteur, en ligne : en service ou en course.
    expect(t.minuteur.lirePlusieurs).toHaveBeenCalledTimes(1);
    expect(t.minuteur.lirePlusieurs).toHaveBeenCalledWith(
      [
        { id: 'koffi', enLigne: true },
        { id: 'awa', enLigne: true },
        { id: 'moussa', enLigne: true },
        { id: 'yao', enLigne: true },
      ],
      180,
      M,
    );
    // Planning du jour de la journée de service, plannings envoyés ou confirmés.
    expect(t.prisma.schedulePlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['SENT', 'CONFIRMED'] },
          period_start: { lte: new Date('2026-10-24T00:00:00.000Z') },
          period_end: { gte: new Date('2026-10-24T00:00:00.000Z') },
        }),
      }),
    );
    expect(t.prisma.course.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ completed_at: { gte: new Date('2026-10-24T05:00:00.000Z') } }),
      }),
    );
  });

  it('minuteur muet (Redis) : en_ligne_aujourdhui_s à null, la liste répond quand même', async () => {
    const t = monter({ minuteur: null });
    const l = await t.parId({ jour: true });
    expect([l.awa.en_ligne_aujourdhui_s, l.yao.en_ligne_aujourdhui_s]).toEqual([null, null]);
    expect(l.awa.courses_du_jour).toBe(7);
  });
});
