import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CourseStatut, DelivererStatus, EntityStatus } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';
import { DelivererScoringService } from './deliverer-scoring.service';

/**
 * Vue scoring + file d'attente pour UN livreur.
 *
 * Conçu pour exposer côté UI (mobile + backoffice) tous les champs calculés
 * par le scoring P4 / queue P5 / chainage P6 : rang, score composite, breakdown,
 * pénalités glissantes, auto-pause, eligibilité chaînage.
 *
 * Lecture seule, pas d'effets de bord. Recalcule le rang et le score à la
 * demande (relativement coûteux : 1 query restaurant + 1 ranking + 1 lookup
 * livreur — total ~2-3 queries DB par appel).
 */
@Injectable()
export class DelivererInfoService {
  private readonly logger = new Logger(DelivererInfoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scoringService: DelivererScoringService,
    private readonly settings: DelivererScoringSettingsHelper,
  ) {}

  /**
   * Agrège tous les champs scoring/queue/refus/pause d'un livreur en une vue
   * destinée à l'affichage. Calcule le rang relatif aux autres livreurs du
   * même restaurant + le score composite actuel.
   *
   * @throws NotFoundException si le livreur n'existe pas
   */
  async getScoringInfo(delivererId: string): Promise<IDelivererScoringInfoView> {
    const now = new Date();

    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: {
        id: true,
        status: true,
        is_operational: true,
        restaurant_id: true,
        type_vehicule: true,
        last_available_at: true,
        last_location: true,
        last_location_at: true,
        pause_until: true,
        auto_pause_until: true,
        queue_penalty_until: true,
        queue_penalty_positions: true,
        recent_refusals: true,
        entity_status: true,
      },
    });

    if (!deliverer) {
      throw new NotFoundException(`Livreur ${delivererId} introuvable`);
    }

    const settings = await this.settings.load();

    // Refus récents : on ne garde que ceux dans la fenêtre glissante
    const refusalTimestamps = this.parseRefusalTimestamps(deliverer.recent_refusals);
    const windowStartMs = now.getTime() - settings.autoPauseRefusalsWindowMin * 60_000;
    const recentRefusalsInWindow = refusalTimestamps.filter(
      (t) => t.getTime() > windowStartMs,
    );

    // Status de pause
    const pauseUntil = deliverer.pause_until;
    const autoPauseUntil = deliverer.auto_pause_until;
    const isPaused = pauseUntil !== null && pauseUntil > now;
    const isAutoPaused = autoPauseUntil !== null && autoPauseUntil > now;

    // Course active ?
    const activeCourse = await this.prisma.course.findFirst({
      where: {
        deliverer_id: delivererId,
        statut: {
          in: [
            CourseStatut.ACCEPTED,
            CourseStatut.AT_RESTAURANT,
            CourseStatut.IN_DELIVERY,
          ],
        },
      },
      select: { id: true, reference: true, statut: true },
    });

    const baseInfo: IDelivererScoringInfoView = {
      delivererId: deliverer.id,
      restaurantId: deliverer.restaurant_id,
      isOperational: deliverer.is_operational,
      isInActiveCourse: activeCourse !== null,
      activeCourse: activeCourse
        ? { id: activeCourse.id, reference: activeCourse.reference, statut: activeCourse.statut }
        : null,
      lastAvailableAt: deliverer.last_available_at?.toISOString() ?? null,
      pauses: {
        pauseUntil: pauseUntil?.toISOString() ?? null,
        autoPauseUntil: autoPauseUntil?.toISOString() ?? null,
        isPaused,
        isAutoPaused,
      },
      refusals: {
        windowMinutes: settings.autoPauseRefusalsWindowMin,
        threshold: settings.autoPauseRefusalsThreshold,
        countInWindow: recentRefusalsInWindow.length,
        timestamps: recentRefusalsInWindow.map((t) => t.toISOString()),
        remainingBeforeAutoPause: Math.max(
          settings.autoPauseRefusalsThreshold - recentRefusalsInWindow.length,
          0,
        ),
      },
      queuePenalty: {
        positions: deliverer.queue_penalty_positions ?? 0,
        until: deliverer.queue_penalty_until?.toISOString() ?? null,
        active:
          deliverer.queue_penalty_until !== null && deliverer.queue_penalty_until > now,
      },
      ranking: null,
      scoring: null,
      reasons: this.buildReasons({
        deliverer,
        isPaused,
        isAutoPaused,
        hasActiveCourse: activeCourse !== null,
        now,
      }),
    };

    // Si le livreur n'est pas opérationnel ou pas affecté à un resto, on ne calcule
    // pas le ranking / scoring (ça n'a pas de sens, il n'est pas candidat).
    if (
      !deliverer.restaurant_id ||
      !deliverer.is_operational ||
      deliverer.status !== DelivererStatus.ACTIVE ||
      deliverer.entity_status !== EntityStatus.ACTIVE
    ) {
      return baseInfo;
    }

    // Calcul du rang + score : on demande le ranking complet pour son restaurant
    // SANS exclure ce livreur, puis on cherche sa position dans la liste.
    const ranked = await this.scoringService.rankCandidates({
      restaurantId: deliverer.restaurant_id,
      excludeIds: [],
    });

    const myEntry = ranked.find((r) => r.delivererId === delivererId);

    return {
      ...baseInfo,
      ranking: {
        position: myEntry ? ranked.findIndex((r) => r.delivererId === delivererId) + 1 : null,
        totalCandidates: ranked.length,
        rankInQueue: myEntry?.rank ?? null,
      },
      scoring: myEntry
        ? {
            currentScore: myEntry.score,
            distanceMeters: myEntry.distanceMeters,
            components: myEntry.components,
            weights: {
              queue: settings.scoreWeightQueue,
              distance: settings.scoreWeightDistance,
              chain: settings.scoreWeightChain,
              vehicle: settings.scoreWeightVehicle,
            },
          }
        : null,
    };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private parseRefusalTimestamps(raw: unknown): Date[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is string => typeof s === 'string')
      .map((s) => new Date(s))
      .filter((d) => !isNaN(d.getTime()));
  }

  /**
   * Liste lisible des raisons pour lesquelles le livreur est (ou n'est pas)
   * candidat aux offres. Affiché côté UI pour expliquer le statut courant.
   */
  private buildReasons(input: {
    deliverer: { is_operational: boolean; restaurant_id: string | null; status: DelivererStatus };
    isPaused: boolean;
    isAutoPaused: boolean;
    hasActiveCourse: boolean;
    now: Date;
  }): string[] {
    const reasons: string[] = [];
    if (input.deliverer.status !== DelivererStatus.ACTIVE) {
      reasons.push(`Compte non actif (statut : ${input.deliverer.status})`);
    }
    if (!input.deliverer.restaurant_id) {
      reasons.push('Aucun restaurant affecté');
    }
    if (!input.deliverer.is_operational) {
      reasons.push('Marqué non opérationnel');
    }
    if (input.isPaused) {
      reasons.push('Pause manuelle active');
    }
    if (input.isAutoPaused) {
      reasons.push('Auto-pause active (trop de refus récents)');
    }
    if (input.hasActiveCourse) {
      reasons.push('Course active en cours');
    }
    return reasons;
  }
}

// ============================================================
// TYPES PUBLICS
// ============================================================

export interface IDelivererScoringInfoView {
  delivererId: string;
  restaurantId: string | null;
  isOperational: boolean;

  isInActiveCourse: boolean;
  activeCourse: {
    id: string;
    reference: string;
    statut: CourseStatut;
  } | null;

  lastAvailableAt: string | null;

  pauses: {
    pauseUntil: string | null;
    autoPauseUntil: string | null;
    isPaused: boolean;
    isAutoPaused: boolean;
  };

  refusals: {
    /** Fenêtre glissante en minutes (paramétrable). */
    windowMinutes: number;
    /** Seuil de refus avant auto-pause. */
    threshold: number;
    /** Nombre de refus dans la fenêtre courante. */
    countInWindow: number;
    /** Timestamps ISO des refus dans la fenêtre. */
    timestamps: string[];
    /** Combien de refus avant déclenchement auto-pause. */
    remainingBeforeAutoPause: number;
  };

  queuePenalty: {
    /** Combien de positions de recul appliquées. */
    positions: number;
    /** Jusqu'à quand la pénalité s'applique. */
    until: string | null;
    /** True si actuellement pénalisé. */
    active: boolean;
  };

  /**
   * Ranking dans la file de son restaurant. `null` si pas opérationnel
   * (compte inactif, pas de resto, en pause, etc.).
   */
  ranking: {
    /** Position absolue dans la liste triée par score (1 = meilleur). */
    position: number | null;
    /** Nombre total de candidats actuels pour ce restaurant. */
    totalCandidates: number;
    /** Rang FIFO pur (1 = entré en queue en premier). */
    rankInQueue: number | null;
  } | null;

  /**
   * Score composite + breakdown + poids configurés. `null` si hors ranking.
   */
  scoring: {
    currentScore: number;
    distanceMeters: number | null;
    components: {
      queue: number;
      distance: number;
      chain: number;
      vehicle: number;
      penalty: number;
    };
    weights: {
      queue: number;
      distance: number;
      chain: number;
      vehicle: number;
    };
  } | null;

  /**
   * Liste lisible des raisons pour lesquelles le livreur n'est pas dans le ranking
   * ou de ce qui le pénalise (pause, auto-pause, course active, etc.).
   */
  reasons: string[];
}
