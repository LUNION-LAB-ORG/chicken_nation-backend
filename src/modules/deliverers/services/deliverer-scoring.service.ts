import { Injectable, Logger } from '@nestjs/common';
import {
  CourseStatut,
  DelivererStatus,
  DeliveryStatut,
  EntityStatus,
  VehiculeType,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import {
  haversineMeters,
  type ILatLng,
} from 'src/modules/course/helpers/geo.helper';

import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';

export interface IRankInput {
  restaurantId: string;
  /** Livreurs à exclure du ranking (ex: ceux ayant déjà refusé/ignoré cette course). */
  excludeIds?: string[];
}

export interface IRankedCandidate {
  delivererId: string;
  /** Position FIFO (1 = tête de file, n = dernier entré). */
  rank: number;
  /** Distance Haversine livreur → restaurant en mètres. `null` si GPS trop ancien/absent. */
  distanceMeters: number | null;
  /** Score composite final — plus élevé = meilleur. */
  score: number;
  /** Décomposition du score pour debug / audit. */
  components: {
    queue: number;
    distance: number;
    chain: number;
    vehicle: number;
    penalty: number;
  };
}

/** Shape minimal nécessaire pour scorer un candidat. */
interface IChainableCandidate {
  id: string;
  last_available_at: Date | null;
  last_location: unknown; // JsonValue
  last_location_at: Date | null;
  type_vehicule: VehiculeType | null;
  queue_penalty_until: Date | null;
  queue_penalty_positions: number | null;
}

/**
 * Ranking multi-critères des livreurs candidats pour une Course donnée.
 *
 * Remplace le `findFirst(last_login_at DESC)` simpliste par un scoring pondéré
 * qui combine équité (FIFO queue) + efficacité (distance) + chaînage (bonus
 * fin imminente) + préférence véhicule, moins les pénalités de refus récents.
 *
 * Poids tous configurables via `DelivererScoringSettingsHelper` — modifiables
 * dans le backoffice (page Paramètres Livraison).
 */
@Injectable()
export class DelivererScoringService {
  private readonly logger = new Logger(DelivererScoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: DelivererScoringSettingsHelper,
  ) {}

  // ============================================================
  // API PUBLIQUE
  // ============================================================

  /**
   * Retourne la liste ordonnée des candidats éligibles (meilleur score en 1er).
   *
   * Deux sources fusionnées :
   *   1. **Candidats « normaux »** : livreurs en queue, sans course active.
   *   2. **Candidats « chaînage »** : livreurs avec une course `IN_DELIVERY`
   *      dont la dernière delivery est `DELIVERED < 2 min` ou `ARRIVED`, distance
   *      au nouveau restaurant ≤ `chain_max_distance_meters`, et qui n'ont pas
   *      déjà dépassé `chain_max_per_hour` chaînages dans la dernière heure.
   *      → reçoivent `chainScore = 1` pour compenser leur rang élevé (ou nul).
   */
  async rankCandidates(input: IRankInput): Promise<IRankedCandidate[]> {
    const now = new Date();
    const settings = await this.settings.load();
    const { restaurantId, excludeIds = [] } = input;

    // Fetch restaurant pour la distance
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { latitude: true, longitude: true },
    });
    const restaurantLoc: ILatLng | null =
      restaurant?.latitude && restaurant?.longitude
        ? { lat: restaurant.latitude, lng: restaurant.longitude }
        : null;

    // Lance les 2 fetches en parallèle
    const [regular, chainable] = await Promise.all([
      this.findRegularCandidates(restaurantId, excludeIds, now),
      settings.chainMaxPerHour > 0
        ? this.findChainableCandidates(restaurantId, excludeIds, now, settings, restaurantLoc)
        : Promise.resolve([] as IChainableCandidate[]),
    ]);

    // ID des chainables pour éviter un doublon si un livreur finit sa course
    // ENTRE les 2 queries (rare mais possible). Chainable prioritaire sur regular.
    const chainableIds = new Set(chainable.map((c) => c.id));
    const regularFiltered = regular.filter((c) => !chainableIds.has(c.id));

    if (regularFiltered.length === 0 && chainable.length === 0) return [];

    // Rank FIFO — les chainables sont toujours « en haut » (rank = 0.5 pour
    // passer devant le rank=1 des regular dans la formule 1/rank) car ils
    // sont déjà engagés et terminent imminemment.
    const sortedRegular = [...regularFiltered].sort((a, b) => {
      const av = a.last_available_at?.getTime() ?? Number.POSITIVE_INFINITY;
      const bv = b.last_available_at?.getTime() ?? Number.POSITIVE_INFINITY;
      return av - bv;
    });
    const rankMap = new Map<string, number>();
    sortedRegular.forEach((c, i) => rankMap.set(c.id, i + 1));
    // Les chainables ont un rank "virtuel" qui les met en tête de peloton
    // mais c'est surtout le chainScore qui compense.
    chainable.forEach((c) => rankMap.set(c.id, 1));

    const combined = [
      ...regularFiltered.map((c) => ({ ...c, isChainable: false })),
      ...chainable.map((c) => ({ ...c, isChainable: true })),
    ];

    const ranked: IRankedCandidate[] = combined.map((c) => {
      const rank = rankMap.get(c.id) ?? combined.length;

      // Composantes de score
      const queueScore = 1 / rank;
      const { score: distanceScore, meters } = this.computeDistanceScore(
        c.last_location,
        c.last_location_at,
        restaurantLoc,
        settings.gpsExpirationMinutes,
        now,
      );
      const chainScore = c.isChainable ? 1 : 0;
      const vehicleScore = this.computeVehicleScore(c.type_vehicule);
      const penaltyMalus = this.computePenaltyMalus(
        c.queue_penalty_until,
        c.queue_penalty_positions ?? 0,
        now,
      );

      const score =
        settings.scoreWeightQueue * queueScore +
        settings.scoreWeightDistance * distanceScore +
        settings.scoreWeightChain * chainScore +
        settings.scoreWeightVehicle * vehicleScore -
        penaltyMalus;

      return {
        delivererId: c.id,
        rank,
        distanceMeters: meters,
        score,
        components: {
          queue: queueScore,
          distance: distanceScore,
          chain: chainScore,
          vehicle: vehicleScore,
          penalty: penaltyMalus,
        },
      };
    });

    // Tri par score décroissant (tie-break = rank ASC = FIFO prévaut)
    ranked.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.rank - b.rank;
    });

    return ranked;
  }

  // ============================================================
  // FETCH CANDIDATS — split regular / chainable
  // ============================================================

  private async findRegularCandidates(
    restaurantId: string,
    excludeIds: string[],
    now: Date,
  ) {
    return this.prisma.deliverer.findMany({
      where: {
        restaurant_id: restaurantId,
        status: DelivererStatus.ACTIVE,
        is_operational: true,
        entity_status: EntityStatus.ACTIVE,
        id: { notIn: excludeIds },
        OR: [{ pause_until: null }, { pause_until: { lt: now } }],
        AND: [
          { OR: [{ auto_pause_until: null }, { auto_pause_until: { lt: now } }] },
          {
            courses: {
              none: {
                statut: {
                  in: [
                    CourseStatut.ACCEPTED,
                    CourseStatut.AT_RESTAURANT,
                    CourseStatut.IN_DELIVERY,
                  ],
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        last_available_at: true,
        last_location: true,
        last_location_at: true,
        type_vehicule: true,
        queue_penalty_until: true,
        queue_penalty_positions: true,
      },
    });
  }

  /**
   * Candidats « fin imminente » : livreurs avec UNE course IN_DELIVERY dont
   * la dernière delivery est DELIVERED (< 2 min) ou ARRIVED, proche du nouveau
   * restaurant, sous le quota horaire de chaînages.
   */
  private async findChainableCandidates(
    restaurantId: string,
    excludeIds: string[],
    now: Date,
    settings: {
      chainMaxDistanceMeters: number;
      chainMaxPerHour: number;
      gpsExpirationMinutes: number;
    },
    restaurantLoc: ILatLng | null,
  ): Promise<IChainableCandidate[]> {
    if (!restaurantLoc) return []; // sans coord resto, on ne peut pas check la distance

    const DELIVERED_THRESHOLD_MS = 2 * 60 * 1000; // 2 min
    const HOUR_AGO = new Date(now.getTime() - 3600_000);

    const raw = await this.prisma.deliverer.findMany({
      where: {
        restaurant_id: restaurantId,
        status: DelivererStatus.ACTIVE,
        is_operational: true,
        entity_status: EntityStatus.ACTIVE,
        id: { notIn: excludeIds },
        OR: [{ pause_until: null }, { pause_until: { lt: now } }],
        AND: [
          { OR: [{ auto_pause_until: null }, { auto_pause_until: { lt: now } }] },
          // Une course IN_DELIVERY active au moins
          { courses: { some: { statut: CourseStatut.IN_DELIVERY } } },
        ],
      },
      select: {
        id: true,
        last_available_at: true,
        last_location: true,
        last_location_at: true,
        type_vehicule: true,
        queue_penalty_until: true,
        queue_penalty_positions: true,
        courses: {
          where: { statut: CourseStatut.IN_DELIVERY },
          select: {
            id: true,
            assigned_at: true,
            deliveries: {
              orderBy: { sequence_order: 'desc' },
              take: 1,
              select: {
                statut: true,
                delivered_at: true,
                order: {
                  select: { address: true },
                },
              },
            },
          },
          take: 1,
        },
      },
    });

    // Post-filter en mémoire (plus simple que SQL complexe)
    const eligible: IChainableCandidate[] = [];
    for (const d of raw) {
      const activeCourse = d.courses[0];
      if (!activeCourse) continue;
      const lastDelivery = activeCourse.deliveries[0];
      if (!lastDelivery) continue;

      // 1. Delivery dans une fenêtre terminale
      const isArrived = lastDelivery.statut === DeliveryStatut.ARRIVED;
      const justDelivered =
        lastDelivery.statut === DeliveryStatut.DELIVERED &&
        lastDelivery.delivered_at !== null &&
        now.getTime() - lastDelivery.delivered_at.getTime() < DELIVERED_THRESHOLD_MS;
      if (!isArrived && !justDelivered) continue;

      // 2. Distance dernière_livraison → nouveau restaurant
      const lastAddress = this.parseOrderAddress(lastDelivery.order?.address);
      if (!lastAddress) continue;
      const distanceToRestaurant = haversineMeters(lastAddress, restaurantLoc);
      if (distanceToRestaurant > settings.chainMaxDistanceMeters) continue;

      // 3. Quota horaire : count des courses assigned_at > now - 1h
      // (on fait un count pour ce livreur précisément, simple query)
      const countRecent = await this.prisma.course.count({
        where: {
          deliverer_id: d.id,
          assigned_at: { gt: HOUR_AGO },
        },
      });
      if (countRecent >= settings.chainMaxPerHour) continue;

      eligible.push({
        id: d.id,
        last_available_at: d.last_available_at,
        last_location: d.last_location,
        last_location_at: d.last_location_at,
        type_vehicule: d.type_vehicule,
        queue_penalty_until: d.queue_penalty_until,
        queue_penalty_positions: d.queue_penalty_positions,
      });
    }

    if (eligible.length > 0) {
      this.logger.log(
        `Chainables détectés: ${eligible.length} livreur(s) en fin imminente proche du resto ${restaurantId.slice(0, 8)}`,
      );
    }
    return eligible;
  }

  /**
   * Parse `Order.address` qui peut être soit un objet (Prisma `Json`), soit
   * une string JSON stringifiée (legacy). Délègue à la même logique que
   * `parseOrderLatLng` du module course mais duplique localement pour garder
   * le service `deliverers` indépendant de l'import runtime course.
   */
  private parseOrderAddress(raw: unknown): ILatLng | null {
    if (raw === null || raw === undefined) return null;

    if (typeof raw === 'object') {
      return this.extractCoords(raw as Record<string, unknown>);
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      try {
        return this.extractCoords(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        return null;
      }
    }

    return null;
  }

  private extractCoords(obj: Record<string, unknown>): ILatLng | null {
    const lat = Number(obj.latitude);
    const lng = Number(obj.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat === 0 && lng === 0) return null;
    return { lat, lng };
  }

  /**
   * Retourne le meilleur candidat ou null si aucun. Log la décision (scores
   * du top 3) pour audit / tuning des poids.
   */
  async pickBestCandidate(input: IRankInput): Promise<IRankedCandidate | null> {
    const ranked = await this.rankCandidates(input);
    if (ranked.length === 0) return null;

    const top3 = ranked
      .slice(0, 3)
      .map(
        (c) =>
          `${c.delivererId.slice(0, 8)}(rank=${c.rank} · d=${c.distanceMeters ?? '?'}m · score=${c.score.toFixed(3)})`,
      )
      .join(' | ');
    this.logger.log(
      `Scoring restaurant=${input.restaurantId.slice(0, 8)} top3: ${top3}`,
    );

    return ranked[0];
  }

  // ============================================================
  // HELPERS PRIVÉS (composants du score)
  // ============================================================

  private computeDistanceScore(
    location: unknown,
    locationAt: Date | null,
    restaurantLoc: ILatLng | null,
    gpsExpirationMinutes: number,
    now: Date,
  ): { score: number; meters: number | null } {
    if (!restaurantLoc || !location || !locationAt) return { score: 0, meters: null };

    const ageMin = (now.getTime() - locationAt.getTime()) / 60_000;
    if (ageMin > gpsExpirationMinutes) return { score: 0, meters: null };

    const loc = location as { lat?: number; lng?: number };
    if (typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      return { score: 0, meters: null };
    }

    const meters = haversineMeters(restaurantLoc, { lat: loc.lat, lng: loc.lng });
    // Normalisation : 0m → 1, 1km → 0.5, 10km → 0.09, asymptote 0 à +∞
    const score = 1 / (1 + meters / 1000);
    return { score, meters };
  }

  private computeVehicleScore(vehicule: VehiculeType | null): number {
    switch (vehicule) {
      case VehiculeType.MOTO:
        return 1; // idéal pour fast-food urbain (Abidjan)
      case VehiculeType.VELO:
        return 0.5; // OK courte distance
      case VehiculeType.VOITURE:
        return 0.2; // overkill pour de la livraison repas, mais pas bloquant
      default:
        return 0;
    }
  }

  private computePenaltyMalus(
    penaltyUntil: Date | null,
    positions: number,
    now: Date,
  ): number {
    if (!penaltyUntil || penaltyUntil <= now) return 0;
    // 1 position de recul → 0.1 de malus. Rang compensé si les rangs sont peu espacés.
    return positions * 0.1;
  }
}
