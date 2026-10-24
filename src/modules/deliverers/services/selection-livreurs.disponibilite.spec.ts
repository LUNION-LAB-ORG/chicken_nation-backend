/**
 * Sélection automatique et file d'attente passées par la règle unique
 * `peutRecevoirOffre` (disponibilite.rules.ts), et chaînage suspendu.
 *
 * La base simulée ÉVALUE le filtre Prisma de la sélection : retirer une
 * condition du filtre fait sortir un livreur qui ne doit pas recevoir d'offre.
 */
import { CourseStatut, DeliveryStatut } from '@prisma/client';

import { CourseOfferService } from 'src/modules/course/services/course-offer.service';

import { FIN_PAUSE_INDEFINIE } from '../helpers/disponibilite.rules';
import { appliLivreurSimulee, course, livreur, monterBase, offre } from './base-livreurs.simulee-spec';
import { DelivererQueueService } from './deliverer-queue.service';
import { DelivererScoringService } from './deliverer-scoring.service';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);
const apres = (min: number) => new Date(MAINTENANT.getTime() + min * 60_000);

const REGLAGES = {
  scoreWeightQueue: 0.5,
  scoreWeightDistance: 0.3,
  scoreWeightChain: 0.15,
  scoreWeightVehicle: 0.05,
  refusePenaltyPositions: 3,
  refusePenaltyDurationMin: 10,
  autoPauseRefusalsThreshold: 3,
  autoPauseRefusalsWindowMin: 15,
  autoPauseDurationMin: 30,
  chainMaxDistanceMeters: 1000,
  // Le réglage d'aujourd'hui (2) ne doit plus réactiver le chaînage.
  chainMaxPerHour: 2,
  horsServiceSansSignalMin: 20,
  gpsUpdateIntervalSeconds: 60,
  gpsExpirationMinutes: 5,
  gpsMaxSpeedKmh: 80,
  scoringShadowMode: false,
  travelTimeRanking: false,
  travelTimeTopN: 4,
};

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

describe('sélection automatique des livreurs', () => {
  it('ne propose qu’aux livreurs qui peuvent recevoir une offre', async () => {
    const libre = livreur({ last_available_at: avant(30) });
    const libreAutre = livreur({ last_available_at: avant(10) });
    const pauseEchue = livreur({ pause_until: avant(1), last_available_at: avant(5) });
    const enPause = livreur({ pause_until: FIN_PAUSE_INDEFINIE });
    const enPauseAuto = livreur({ auto_pause_until: apres(20) });
    const horsService = livreur({ last_available_at: null });
    const avecOffre = livreur();
    const enCourse = livreur({ last_available_at: null });
    const coursePourOffre = course();
    const coursePrise = course({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: enCourse.id });

    const base = monterBase({
      livreurs: [libre, libreAutre, pauseEchue, enPause, enPauseAuto, horsService, avecOffre, enCourse],
      courses: [coursePourOffre, coursePrise],
      offres: [offre({ course_id: coursePourOffre.id, deliverer_id: avecOffre.id })],
    });
    const scoring = new DelivererScoringService(
      base.prisma,
      { load: jest.fn(async () => REGLAGES) } as never,
      {} as never,
      appliLivreurSimulee(base.prisma).service,
    );

    const classes = await scoring.rankCandidates({ restaurantId: libre.restaurant_id });

    // File : le plus ancien d'abord.
    expect(classes.map((c) => c.delivererId)).toEqual([libre.id, libreAutre.id, pauseEchue.id]);
  });

  it('exclut les livreurs déjà sollicités pour la course et ceux d’un autre restaurant', async () => {
    const deja = livreur();
    const ailleurs = livreur({ restaurant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    const candidat = livreur();
    const base = monterBase({ livreurs: [deja, ailleurs, candidat] });
    const scoring = new DelivererScoringService(
      base.prisma,
      { load: jest.fn(async () => REGLAGES) } as never,
      {} as never,
      appliLivreurSimulee(base.prisma).service,
    );

    const meilleur = await scoring.pickBestCandidate({
      restaurantId: candidat.restaurant_id,
      excludeIds: [deja.id],
    });

    expect(meilleur?.delivererId).toBe(candidat.id);
  });

  it('chaînage suspendu : un livreur qui finit sa livraison près du restaurant ne reçoit rien', async () => {
    const enFinDeCourse = livreur({ last_available_at: null });
    const base = monterBase({
      livreurs: [enFinDeCourse],
      courses: [
        course({
          statut: CourseStatut.IN_DELIVERY,
          deliverer_id: enFinDeCourse.id,
          deliveries: [
            {
              statut: DeliveryStatut.ARRIVED,
              delivered_at: null,
              order: { address: { latitude: 5.287, longitude: -3.974 } },
            },
          ],
        }),
      ],
    });
    const scoring = new DelivererScoringService(
      base.prisma,
      { load: jest.fn(async () => REGLAGES) } as never,
      {} as never,
      appliLivreurSimulee(base.prisma).service,
    );

    expect(await scoring.rankCandidates({ restaurantId: enFinDeCourse.restaurant_id })).toEqual([]);
    // Deux lectures : les livreurs dont l'appli est à vérifier, puis les
    // candidats ordinaires ; jamais celle du chaînage (course en livraison).
    expect(base.prisma.deliverer.findMany).toHaveBeenCalledTimes(2);
    const lectures = base.prisma.deliverer.findMany.mock.calls.map((a: any[]) => JSON.stringify(a[0].where));
    expect(lectures.some((w: string) => w.includes('"some"'))).toBe(false);
  });
});

describe('appli fermée (demande du 24/10) : la sélection ne propose qu’aux applis actives', () => {
  const S = 180;
  const avantS = (s: number) => new Date(MAINTENANT.getTime() - s * 1000);

  function monterSelection(livreurs: Record<string, any>[], options: Parameters<typeof appliLivreurSimulee>[1]) {
    const base = monterBase({ livreurs });
    const appli = appliLivreurSimulee(base.prisma, options);
    const scoring = new DelivererScoringService(
      base.prisma,
      { load: jest.fn(async () => REGLAGES) } as never,
      {} as never,
      appli.service,
    );
    return { base, appli, scoring };
  }

  it('signe de vie récent (appli en arrière-plan) ou socket ouvert : candidat ; ni l’un ni l’autre : écarté', async () => {
    const arrierePlan = livreur({ last_available_at: avant(30), dernier_signal_at: avantS(40) });
    const socketSeul = livreur({ last_available_at: avant(20), dernier_signal_at: avantS(900) });
    const ferme = livreur({ last_available_at: avant(40), dernier_signal_at: avantS(S) });
    const jamaisVu = livreur({ last_available_at: avant(50), dernier_signal_at: null });
    const t = monterSelection([arrierePlan, socketSeul, ferme, jamaisVu], { seuilS: S, connectes: [socketSeul.id] });

    const classes = await t.scoring.rankCandidates({ restaurantId: arrierePlan.restaurant_id });

    expect(classes.map((c) => c.delivererId)).toEqual([arrierePlan.id, socketSeul.id]);
    // Présence demandée seulement pour ceux dont le signe de vie ne suffit pas.
    expect(t.appli.gateway.livreursConnectes).toHaveBeenCalledTimes(1);
    expect([...t.appli.gateway.livreursConnectes.mock.calls[0][0]].sort()).toEqual(
      [socketSeul.id, ferme.id, jamaisVu.id].sort(),
    );
  });

  it('tous les signes de vie récents : aucune question au serveur temps réel', async () => {
    const a = livreur({ dernier_signal_at: avantS(5) });
    const b = livreur({ dernier_signal_at: avantS(100) });
    const t = monterSelection([a, b], { seuilS: S, connectes: [] });

    expect((await t.scoring.rankCandidates({ restaurantId: a.restaurant_id })).map((c) => c.delivererId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(t.appli.gateway.livreursConnectes).not.toHaveBeenCalled();
  });

  it('présence inconnue (Redis muet) : jugé sur le seul signe de vie', async () => {
    const recent = livreur({ dernier_signal_at: avantS(30) });
    const vieux = livreur({ dernier_signal_at: avantS(600) });
    const t = monterSelection([recent, vieux], { seuilS: S, connectes: null });

    expect((await t.scoring.rankCandidates({ restaurantId: recent.restaurant_id })).map((c) => c.delivererId)).toEqual([
      recent.id,
    ]);
  });

  it('réglage à 0 : règle coupée, comme avant', async () => {
    const vieux = livreur({ dernier_signal_at: avantS(6000) });
    const t = monterSelection([vieux], { seuilS: 0, connectes: [] });

    expect((await t.scoring.pickBestCandidate({ restaurantId: vieux.restaurant_id }))?.delivererId).toBe(vieux.id);
    expect(t.appli.gateway.livreursConnectes).not.toHaveBeenCalled();
  });

  it('mode comparatif (ancien algorithme) : même règle, l’appli fermée est écartée', async () => {
    const ferme = livreur({ last_login_at: new Date('2026-10-22T13:59:00.000Z'), dernier_signal_at: avantS(400) });
    const actif = livreur({ last_login_at: new Date('2026-10-22T08:00:00.000Z'), dernier_signal_at: avantS(20) });
    const base = monterBase({ livreurs: [ferme, actif] });
    const service = new CourseOfferService(
      base.prisma,
      {} as never,
      {} as never,
      {} as never,
      { pickBestCandidate: jest.fn(async () => null) } as never,
      {} as never,
      { load: jest.fn(async () => ({ scoringShadowMode: true })) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      appliLivreurSimulee(base.prisma, { seuilS: S, connectes: [] }).service,
    );

    expect(await (service as any).findBestDeliverer(actif.restaurant_id, [])).toEqual({ id: actif.id, isChainBonus: false });
  });
});

describe('mode comparatif (ancien algorithme, qui décide en mode observation)', () => {
  it('même règle : ni pause, ni hors service, ni offre en attente', async () => {
    const enPause = livreur({ pause_until: FIN_PAUSE_INDEFINIE });
    const horsService = livreur({ last_available_at: null });
    const avecOffre = livreur();
    const libre = livreur();
    const c = course();
    const base = monterBase({
      livreurs: [enPause, horsService, avecOffre, libre],
      courses: [c],
      offres: [offre({ course_id: c.id, deliverer_id: avecOffre.id })],
    });
    const service = new CourseOfferService(
      base.prisma,
      {} as never,
      {} as never,
      {} as never,
      { pickBestCandidate: jest.fn(async () => null) } as never,
      {} as never,
      { load: jest.fn(async () => ({ scoringShadowMode: true })) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      appliLivreurSimulee(base.prisma).service,
    );

    const choisi = await (service as any).findBestDeliverer(libre.restaurant_id, []);

    expect(choisi).toEqual({ id: libre.id, isChainBonus: false });
  });
});

describe("file d'attente : retour en file en fin de course", () => {
  const monterFile = (l: Record<string, any>) => {
    const base = monterBase({ livreurs: [l] });
    return new DelivererQueueService(base.prisma, {} as never, {} as never, {} as never);
  };

  it('en pause : reste hors de la file', async () => {
    const l = livreur({ pause_until: apres(10), last_available_at: null });
    await monterFile(l).onComplete(l.id);
    expect(l.last_available_at).toBeNull();
  });

  it('en pause automatique : reste hors de la file', async () => {
    const l = livreur({ auto_pause_until: apres(10), last_available_at: null });
    await monterFile(l).onComplete(l.id);
    expect(l.last_available_at).toBeNull();
  });

  it('pause échue : revient en file', async () => {
    const l = livreur({ pause_until: avant(1), last_available_at: null });
    await monterFile(l).onComplete(l.id);
    expect(l.last_available_at).toEqual(MAINTENANT);
  });
});
