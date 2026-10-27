/**
 * ORDRE DES ARRÊTS côté services (demande du client du 27/10) : écriture de
 * l'ordre sous garde (course pas partie), lecture des distances entre
 * clients dans le cache seulement (appels Google lancés sans attendre, 6 au
 * plus par passage), lots et relance qui gardent leur ordre. Contrat
 * `tournee-contrat.md`, A2 à A5 (O5, O7, O8, O9, O10, O11, O12).
 */
import { CourseStatut, DeliveryService, DeliveryStatut, OrderStatus } from '@prisma/client';

import { appliLivreurSimulee } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { estRaisonDuPlanificateur, RaisonsPlanificateur } from '../helpers/application-plan.rules';
import { CourseHelper } from '../helpers/course.helper';
import { ActionOrdonner, clePaire, PlanRestaurant, REGLAGES_PLANIFICATION_DEFAUT } from '../helpers/planification.rules';
import { ApplicationPlanService } from './application-plan.service';
import { commande, course, livraison, livreur, monterBaseDispatch, RESTO } from './base-dispatch.simulee-spec';
import { CourseGroupingService } from './course-grouping.service';
import { CourseOfferService } from './course-offer.service';
import { DirectionService } from './direction.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { InstantanePlanificationService } from './instantane-planification.service';

const MAINTENANT = new Date('2026-10-27T15:30:00.000Z');

// ─── Écriture de l'ordre (ApplicationPlanService.ordonner) ───────────────────

function monterOrdre(surchargeCourse: Record<string, unknown>, rangs: number[] = [1, 2]) {
  const l = livreur();
  const c = course({ statut: CourseStatut.ACCEPTED, deliverer_id: l.id, assigned_at: MAINTENANT, ...surchargeCourse });
  const commandes = rangs.map(() => commande({ status: OrderStatus.READY }));
  const livraisons = commandes.map((o, i) => livraison({ course_id: c.id, order_id: o.id, sequence_order: rangs[i] }));
  const base = monterBaseDispatch({ livreurs: [l], courses: [c], commandes, livraisons });
  const courseEvent = {
    courseStatutChanged: jest.fn(async (_p: Record<string, unknown>) => undefined),
    offerNew: jest.fn(async () => undefined),
    courseCancelled: jest.fn(async () => undefined),
  };
  const push = Object.fromEntries(
    [
      'notifyCommandeAjoutee',
      'notifyCommandeRetiree',
      'notifyCourseAttente',
      'notifyCourseToutPret',
      'notifyCommandeRemise',
      'notifyNewCourseOffer',
      'notifyCourseAssigned',
    ].map((nom) => [nom, jest.fn()]),
  );
  const application = new ApplicationPlanService(
    base.prisma,
    {} as never,
    new CourseHelper(),
    courseEvent as never,
    push as never,
    new DispatchJournalService(base.prisma),
    {} as never,
    {} as never,
  );
  const appliquer = (sequence: string[]) => {
    const action: ActionOrdonner = { type: 'ORDONNER', course_id: c.id, sequence, motif: 'MEILLEUR_ORDRE', base: 'route', gain_s: 164 };
    const plan: PlanRestaurant = { restaurant_id: RESTO, maintenant: MAINTENANT, actions: [action], refus: [] };
    return application.appliquer(
      plan,
      { instantane: {} as never, verdicts: new Map(), contexte: ApplicationPlanService.contexteVide(RESTO) },
      { maxRefus: 3 },
    );
  };
  const rangsDe = () => Object.fromEntries(livraisons.map((x) => [x.order_id, x.sequence_order]));
  return { base, c, commandes, livraisons, courseEvent, push, appliquer, rangsDe };
}

describe('ORDONNER : écriture de l’ordre', () => {
  it('O8 après l’acceptation : réordonnée en silence (ni notification, ni offre renvoyée), raison ARRETS_ORDONNES', async () => {
    const t = monterOrdre({});
    const [premiere, seconde] = t.commandes;
    const r = await t.appliquer([seconde.id, premiere.id]);

    expect(r.appliquees).toEqual(['ORDONNER']);
    expect(t.rangsDe()).toEqual({ [seconde.id]: 1, [premiere.id]: 2 });
    expect(t.base.journal.filter((l) => l.type === 'ARRETS_ORDONNES')).toEqual([
      expect.objectContaining({
        motif: 'MEILLEUR_ORDRE',
        course_id: t.c.id,
        details: { sequence: [seconde.id, premiere.id], motif: 'MEILLEUR_ORDRE', base: 'route', gain_s: 164 },
      }),
    ]);
    expect(t.courseEvent.courseStatutChanged).toHaveBeenCalledTimes(1);
    expect(t.courseEvent.courseStatutChanged.mock.calls[0][0]).toMatchObject({ reason: 'ARRETS_ORDONNES' });
    expect(RaisonsPlanificateur.ARRETS_ORDONNES).toBe('ARRETS_ORDONNES');
    expect(estRaisonDuPlanificateur('ARRETS_ORDONNES')).toBe(true);
    for (const f of Object.values(t.push)) expect(f).not.toHaveBeenCalled();
    expect(t.courseEvent.offerNew).not.toHaveBeenCalled();
  });

  it('O7 : livreur parti entre le plan et son application : action abandonnée COURSE_PARTIE, rien d’écrit', async () => {
    const t = monterOrdre({ statut: CourseStatut.IN_DELIVERY, picked_up_at: MAINTENANT, parti_at: MAINTENANT });
    const [premiere, seconde] = t.commandes;
    const r = await t.appliquer([seconde.id, premiere.id]);
    expect(r.abandonnees).toEqual([{ type: 'ORDONNER', motif: 'COURSE_PARTIE' }]);
    expect(t.rangsDe()).toEqual({ [premiere.id]: 1, [seconde.id]: 2 });
    expect(t.base.journal.filter((l) => l.type === 'ARRETS_ORDONNES')).toEqual([]);
    expect(t.base.journal.filter((l) => l.type === 'ACTION_ABANDONNEE')).toEqual([
      expect.objectContaining({ motif: 'ORDONNER', details: { raison: 'COURSE_PARTIE' } }),
    ]);
    expect(t.courseEvent.courseStatutChanged).not.toHaveBeenCalled();
  });

  it('O9 : rangs 1 et 3 après un retrait : renumérotés 1 et 2, sans trou', async () => {
    const t = monterOrdre({}, [1, 3]);
    const [a, g] = t.commandes;
    await t.appliquer([a.id, g.id]);
    expect(t.rangsDe()).toEqual({ [a.id]: 1, [g.id]: 2 });
  });
});

// ─── Lecture des distances entre clients (InstantanePlanificationService) ───

/** Clients à l'est du restaurant de la base simulée, distance routière donnée par la longitude. */
function monterInstantane(groupes: { statut?: CourseStatut; metres: number[] }[], cache: Map<string, number> = new Map()) {
  const courses: Record<string, unknown>[] = [];
  const commandes: Record<string, unknown>[] = [];
  const livraisons: Record<string, unknown>[] = [];
  const routes = new Map<string, number>();
  groupes.forEach((g, i) => {
    const c = course({ statut: g.statut ?? CourseStatut.PENDING_ASSIGNMENT, created_at: new Date(MAINTENANT.getTime() - (10 - i) * 60_000) });
    courses.push(c);
    g.metres.forEach((m, j) => {
      const lng = -3.9737 + m / 110_000 + i * 0.0001;
      const o = commande({ status: OrderStatus.READY, address: { latitude: 5.286 + i * 0.01, longitude: lng } });
      routes.set(lng.toFixed(6), m);
      commandes.push(o);
      livraisons.push(livraison({ course_id: c.id, order_id: o.id, sequence_order: j + 1 }));
    });
  });
  const base = monterBaseDispatch({ courses, commandes, livraisons });
  const cle = (o: { lat: number; lng: number }, d: { lat: number; lng: number }) =>
    `${o.lat.toFixed(4)},${o.lng.toFixed(4)}>${d.lat.toFixed(4)},${d.lng.toFixed(4)}`;
  const maps = {
    itineraireRoutier: jest.fn((p: { originLng: number; destLng: number }, options?: { pour?: string }) =>
      options?.pour === 'ordre'
        ? new Promise(() => undefined) // Google lent : jamais attendu par le passage
        : Promise.resolve({ metres: routes.get(p.destLng.toFixed(6)) ?? 1000, secondes: 0, polyligne: '' }),
    ),
    trajetEnCache: jest.fn(async (o: { lat: number; lng: number }, d: { lat: number; lng: number }) => cache.get(cle(o, d)) ?? null),
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
  const lire = (google = true) => instantanes.lire(RESTO, MAINTENANT, REGLAGES_PLANIFICATION_DEFAUT, google);
  const appelsOrdre = () => maps.itineraireRoutier.mock.calls.filter(([, o]) => o?.pour === 'ordre');
  return { base, maps, lire, appelsOrdre, commandes, cle };
}

describe('Instantané : distances entre clients, cache seulement', () => {
  it('O12 : paire en cache, aucun appel Google ; la distance entre dans la matrice du passage', async () => {
    const t = monterInstantane([{ metres: [2600, 3000] }]);
    const [a, b] = t.commandes as { id: string; address: { latitude: number; longitude: number } }[];
    const pa = { lat: a.address.latitude, lng: a.address.longitude };
    const pb = { lat: b.address.latitude, lng: b.address.longitude };
    const chaud = monterInstantane([{ metres: [2600, 3000] }], new Map([[t.cle(pb, pa), 5500]]));
    const [ca, cb] = chaud.commandes as { id: string }[];
    const lu = await chaud.lire();
    expect(lu.matrice!.get(clePaire(ca.id, cb.id))).toBe(5500);
    expect(chaud.appelsOrdre()).toEqual([]);
  });

  it('O5 : paires manquantes lancées sans attendre, 6 au plus par passage, jamais deux fois en vol', async () => {
    const t = monterInstantane([{ metres: [1000, 2000, 3000] }, { metres: [1500, 2500, 3500] }, { metres: [1200, 2200, 3200] }]);
    const lu = await t.lire(); // Google ne répond jamais : le passage n'attend pas.
    expect(lu.matrice!.size).toBe(0);
    expect(t.appelsOrdre()).toHaveLength(6);
    // Du client le plus proche du restaurant vers le plus lointain.
    for (const [p] of t.appelsOrdre()) expect(p.destLng).toBeGreaterThan(p.originLng);

    await t.lire();
    const toutes = t.appelsOrdre().map(([p]) => `${p.originLng}>${p.destLng}`);
    expect(toutes).toHaveLength(9);
    expect(new Set(toutes).size).toBe(9);
  });

  it('Google coupé par réglage : rien n’est lu ni demandé pour l’ordre', async () => {
    const t = monterInstantane([{ metres: [1000, 2000] }]);
    const lu = await t.lire(false);
    expect(lu.matrice!.size).toBe(0);
    expect(t.maps.trajetEnCache).not.toHaveBeenCalled();
    expect(t.appelsOrdre()).toEqual([]);
  });
});

// ─── Lots et relance ─────────────────────────────────────────────────────────

describe('O10 : lots (v1, Turbo d’origine)', () => {
  const ZONE4 = { lat: 5.2860442, lng: -3.9737121 };

  it('l’ordre part du restaurant : Koumassi puis Port-Bouët, même quand Port-Bouët est la plus ancienne', () => {
    const ordre: string[] = (CourseGroupingService.prototype as any).optimizeOrderSequence.call({}, [
      { id: 'pb', address: { latitude: 5.26, longitude: -3.942 }, created_at: new Date('2026-10-27T15:00:00.000Z') },
      { id: 'k', address: { latitude: 5.283, longitude: -3.955 }, created_at: new Date('2026-10-27T15:05:00.000Z') },
      { id: 'x', address: null, created_at: new Date('2026-10-27T14:55:00.000Z') },
    ], ZONE4);
    expect(ordre).toEqual(['k', 'pb', 'x']);
  });

  it('createFromReadyOrders garde l’ordre reçu, quel que soit l’ordre rendu par la base', async () => {
    const voulu = ['c-k', 'c-pb'];
    let creees: { order_id: string; sequence_order: number }[] = [];
    const ligne = (id: string) => ({ id, delivery_fee: 1000, address: null, delivery_service: DeliveryService.CHICKEN_NATION, recovery_code: '1234' });
    const tx = {
      $executeRaw: async () => 1,
      course: {
        findMany: async () => [],
        create: async ({ data }: any) => {
          creees = data.deliveries.create.map((d: any) => ({ order_id: d.order_id, sequence_order: d.sequence_order }));
          return { id: 'k1', reference: 'CRS-K1', ...data };
        },
      },
      order: {
        updateMany: async () => ({ count: voulu.length }),
        // La base rend `id IN (…)` dans son propre ordre.
        findMany: async () => ['c-pb', 'c-k'].map(ligne),
      },
    };
    const prisma = {
      order: { findMany: jest.fn(async () => ['c-pb', 'c-k'].map(ligne)) },
      delivery: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    const vide = {} as never;
    const service = new CourseOfferService(prisma as never, vide, new CourseHelper(), vide, vide, vide, vide, vide, vide, vide, vide, vide);
    jest.spyOn(service, 'offerNextDeliverer').mockResolvedValue(undefined);
    await service.createFromReadyOrders({ restaurantId: 'resto', orderIds: voulu });
    expect(creees).toEqual([
      { order_id: 'c-k', sequence_order: 1 },
      { order_id: 'c-pb', sequence_order: 2 },
    ]);
  });
});

describe('O11 : relance d’une course annulée', () => {
  it('la nouvelle course garde l’ordre d’avant (B = 1, A = 2)', async () => {
    const annulee = course({ statut: CourseStatut.CANCELLED, cancelled_at: MAINTENANT });
    const a = commande({ status: OrderStatus.READY });
    const b = commande({ status: OrderStatus.READY });
    const livA = livraison({ course_id: annulee.id, order_id: a.id, sequence_order: 2, statut: DeliveryStatut.CANCELLED, reportee_at: null });
    const livB = livraison({ course_id: annulee.id, order_id: b.id, sequence_order: 1, statut: DeliveryStatut.CANCELLED, reportee_at: null });
    const base = monterBaseDispatch({ courses: [annulee], commandes: [a, b], livraisons: [livA, livB] });
    const lecture = jest.spyOn(base.prisma.course, 'findUnique');
    const vide = {} as never;
    const service = new CourseOfferService(base.prisma, vide, new CourseHelper(), vide, vide, vide, vide, vide, vide, vide, vide, vide);

    const r = await service.relancerCourseAnnulee(annulee.id);

    expect(r.ok).toBe(true);
    expect((lecture.mock.calls[0][0] as any).select.deliveries.orderBy).toEqual({ sequence_order: 'asc' });
    expect([livB.course_id, livB.sequence_order, livA.course_id, livA.sequence_order]).toEqual([r.newCourseId, 1, r.newCourseId, 2]);
  });
});
