/**
 * Classement par temps de trajet réel (Google, `deliverer.travel_time_ranking`) :
 * les positions périmées sont écartées avant l'appel, comme pour la note de
 * distance. Une position de plus de 5 min ne dit plus où est le livreur.
 */
import { appliLivreurSimulee, livreur, monterBase } from './base-livreurs.simulee-spec';
import { DelivererScoringService } from './deliverer-scoring.service';

const MAINTENANT = new Date('2026-10-23T12:00:00.000Z');
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);

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
  chainMaxPerHour: 0,
  horsServiceSansSignalMin: 20,
  gpsUpdateIntervalSeconds: 60,
  gpsExpirationMinutes: 5,
  gpsMaxSpeedKmh: 80,
  scoringShadowMode: false,
  travelTimeRanking: true,
  travelTimeTopN: 4,
};

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

describe('temps de trajet des livreurs : positions périmées écartées', () => {
  it('seules les positions de moins de 5 min partent chez Google', async () => {
    const frais1 = livreur({ last_available_at: avant(30), last_location: { lat: 5.28, lng: -3.97 }, last_location_at: avant(1) });
    const frais2 = livreur({ last_available_at: avant(20), last_location: { lat: 5.29, lng: -3.98 }, last_location_at: avant(4) });
    const perime = livreur({ last_available_at: avant(10), last_location: { lat: 5.3, lng: -3.99 }, last_location_at: avant(40) });
    const base = monterBase({ livreurs: [frais1, frais2, perime] });
    const maps = { getTravelTimes: jest.fn(async () => [600, 120]) };
    const scoring = new DelivererScoringService(
      base.prisma,
      { load: jest.fn(async () => REGLAGES) } as never,
      maps as never,
      appliLivreurSimulee(base.prisma).service,
    );

    const meilleur = await scoring.pickBestCandidate({ restaurantId: frais1.restaurant_id });

    expect(maps.getTravelTimes).toHaveBeenCalledTimes(1);
    const [origines] = maps.getTravelTimes.mock.calls[0] as unknown as [unknown[]];
    expect(origines).toEqual([
      { latitude: 5.28, longitude: -3.97 },
      { latitude: 5.29, longitude: -3.98 },
    ]);
    // Le plus rapide à rejoindre le restaurant passe devant.
    expect(meilleur?.delivererId).toBe(frais2.id);
  });

  it('moins de deux positions fraîches : aucun appel, classement habituel', async () => {
    const frais = livreur({ last_available_at: avant(30), last_location: { lat: 5.28, lng: -3.97 }, last_location_at: avant(1) });
    const perime = livreur({ last_available_at: avant(10), last_location: { lat: 5.3, lng: -3.99 }, last_location_at: avant(6) });
    const sansDate = livreur({ last_available_at: avant(5), last_location: { lat: 5.3, lng: -3.99 }, last_location_at: null });
    const base = monterBase({ livreurs: [frais, perime, sansDate] });
    const maps = { getTravelTimes: jest.fn(async () => [60, 60, 60]) };
    const scoring = new DelivererScoringService(
      base.prisma,
      { load: jest.fn(async () => REGLAGES) } as never,
      maps as never,
      appliLivreurSimulee(base.prisma).service,
    );

    await scoring.pickBestCandidate({ restaurantId: frais.restaurant_id });

    expect(maps.getTravelTimes).not.toHaveBeenCalled();
  });
});
