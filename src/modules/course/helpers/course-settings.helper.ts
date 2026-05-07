import { Injectable, Logger } from '@nestjs/common';

import { SettingsService } from 'src/modules/settings/settings.service';

/**
 * Valeurs par défaut du module course.
 * Utilisées si la clé Settings n'est pas définie en base.
 */
const DEFAULTS = {
  // Offre & refus
  offer_duration_seconds: 90,
  max_refusal_count: 5,
  // Course ACCEPTED mais livreur jamais arrivé au resto (trafic, désistement silencieux)
  auto_cancel_accepted_after_min: 60,
  // Course AT_RESTAURANT mais caissière n'a jamais validé le pickup (oubli, absente)
  auto_cancel_at_restaurant_after_min: 30,

  // Regroupement intelligent (Phase P3) — voir `DeliverySettings.tsx` pour l'UI
  batch_window_seconds: 180,     // fenêtre MAX d'attente pour grouper plusieurs orders
  batch_min_wait_seconds: 120,   // attente MIN avant flush (même en saturation) — anti-précipitation
  max_orders_per_course: 3,      // plafond de livraisons dans une course
  max_detour_meters: 1500,       // distance max entre 2 destinations pour grouper
  max_route_duration_min: 25,    // durée totale max du trajet complet

  // Lookahead + re-balancing (Phase 6e)
  lookahead_in_progress: 1,         // 1 = check Orders IN_PROGRESS pour anticiper grouping
  rebalance_enabled: 1,             // 1 = re-grouping périodique des courses non récupérées
  rebalance_interval_seconds: 30,   // fréquence du cron de re-grouping
} as const;

export interface ICourseSettings {
  offerDurationSeconds: number;
  maxRefusalCount: number;
  autoCancelAcceptedAfterMin: number;
  autoCancelAtRestaurantAfterMin: number;
  // Grouping intelligent
  batchWindowSeconds: number;
  batchMinWaitSeconds: number;
  maxOrdersPerCourse: number;
  maxDetourMeters: number;
  maxRouteDurationMin: number;
  // Lookahead + re-balancing
  lookaheadInProgress: boolean;
  rebalanceEnabled: boolean;
  rebalanceIntervalSeconds: number;
}

/**
 * Wrapper sur SettingsService avec préfixe `course.*`, parsing typé et fallback defaults.
 * Les valeurs sont relues à chaque appel (pas de cache) — les quantités sont faibles et
 * on veut que les changements côté admin soient effectifs immédiatement.
 */
@Injectable()
export class CourseSettingsHelper {
  private readonly logger = new Logger(CourseSettingsHelper.name);

  constructor(private readonly settingsService: SettingsService) {}

  /** Charge toutes les clés d'un coup (optimal — 1 query DB). */
  async load(): Promise<ICourseSettings> {
    const map = await this.settingsService.getMany([
      // Offre & refus
      'course.offer_duration_seconds',
      'course.max_refusal_count',
      'course.auto_cancel_accepted_after_min',
      'course.auto_cancel_at_restaurant_after_min',
      // Legacy : si on trouve l'ancienne clé globale, elle sert de fallback
      // pour les 2 clés spécifiques non encore définies.
      'course.auto_cancel_after_min',
      // Grouping
      'course.batch_window_seconds',
      'course.batch_min_wait_seconds',
      'course.max_orders_per_course',
      'course.max_detour_meters',
      'course.max_route_duration_min',
      // Lookahead + re-balancing
      'course.lookahead_in_progress',
      'course.rebalance_enabled',
      'course.rebalance_interval_seconds',
    ]);

    const legacy = map['course.auto_cancel_after_min']; // string | undefined
    const acceptedRaw = map['course.auto_cancel_accepted_after_min'] ?? legacy;
    const atRestaurantRaw = map['course.auto_cancel_at_restaurant_after_min'] ?? legacy;

    return {
      offerDurationSeconds: this.toNumber(map['course.offer_duration_seconds'], DEFAULTS.offer_duration_seconds),
      maxRefusalCount: this.toNumber(map['course.max_refusal_count'], DEFAULTS.max_refusal_count),
      autoCancelAcceptedAfterMin: this.toNumber(acceptedRaw, DEFAULTS.auto_cancel_accepted_after_min),
      autoCancelAtRestaurantAfterMin: this.toNumber(atRestaurantRaw, DEFAULTS.auto_cancel_at_restaurant_after_min),
      batchWindowSeconds: this.toNumber(map['course.batch_window_seconds'], DEFAULTS.batch_window_seconds),
      batchMinWaitSeconds: this.toNumber(map['course.batch_min_wait_seconds'], DEFAULTS.batch_min_wait_seconds),
      maxOrdersPerCourse: this.toNumber(map['course.max_orders_per_course'], DEFAULTS.max_orders_per_course),
      maxDetourMeters: this.toNumber(map['course.max_detour_meters'], DEFAULTS.max_detour_meters),
      maxRouteDurationMin: this.toNumber(map['course.max_route_duration_min'], DEFAULTS.max_route_duration_min),
      lookaheadInProgress: this.toBoolean(map['course.lookahead_in_progress'], DEFAULTS.lookahead_in_progress),
      rebalanceEnabled: this.toBoolean(map['course.rebalance_enabled'], DEFAULTS.rebalance_enabled),
      rebalanceIntervalSeconds: this.toNumber(map['course.rebalance_interval_seconds'], DEFAULTS.rebalance_interval_seconds),
    };
  }

  private toBoolean(raw: string | undefined, fallback: number): boolean {
    if (raw === undefined || raw === '') return fallback === 1;
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'on' || v === 'yes';
  }

  private toNumber(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      this.logger.warn(`Valeur invalide "${raw}" → fallback ${fallback}`);
      return fallback;
    }
    return n;
  }
}
