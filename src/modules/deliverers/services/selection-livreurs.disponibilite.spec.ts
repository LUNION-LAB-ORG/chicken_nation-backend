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
import { course, livreur, monterBase, offre } from './base-livreurs.simulee-spec';
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
    );

    expect(await scoring.rankCandidates({ restaurantId: enFinDeCourse.restaurant_id })).toEqual([]);
    // Une seule lecture : celle des candidats ordinaires, jamais celle du chaînage.
    expect(base.prisma.deliverer.findMany).toHaveBeenCalledTimes(1);
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
