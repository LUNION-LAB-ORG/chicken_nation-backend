import { Injectable, Logger } from '@nestjs/common';

import { SettingsService } from 'src/modules/settings/settings.service';

/**
 * Valeurs par défaut pour le scoring + file d'attente + pénalités + chaînage + GPS livreur.
 * Utilisées si la clé Settings n'est pas définie en base — le backoffice expose
 * ces mêmes clés via `DeliverySettings.tsx` pour que l'admin les override.
 *
 * Convention : valeurs numériques brutes (minutes, mètres, ratios). Les ratios
 * des `score_weight_*` n'ont pas besoin de sommer à 1 — c'est un vote pondéré relatif.
 */
const DEFAULTS = {
  // Scoring — poids relatifs (somme non imposée)
  score_weight_queue: 0.5,
  score_weight_distance: 0.3,
  score_weight_chain: 0.15,
  score_weight_vehicle: 0.05,

  // File d'attente & pénalités (post-refus)
  refuse_penalty_positions: 3,
  refuse_penalty_duration_min: 10,

  // Auto-pause déclenchée par refus répétés
  auto_pause_refusals_threshold: 3,
  auto_pause_refusals_window_min: 15,
  auto_pause_duration_min: 30,

  // Chaînage de courses (fin de livraison → nouvelle offre si proche du resto)
  chain_max_distance_meters: 1000,
  chain_max_per_hour: 2,

  // Géolocalisation
  gps_update_interval_seconds: 60,
  gps_expiration_minutes: 5,
  gps_max_speed_kmh: 80,

  // Shadow mode (P6d) — si true, on log la décision scoring mais on utilise
  // le fallback `last_login_at DESC` pour l'assignation réelle. Permet de
  // valider la qualité du nouveau scoring en prod avant de basculer.
  scoring_shadow_mode: 0, // 0 = off, 1 = on (parsé en boolean)
} as const;

export interface IDelivererScoringSettings {
  // Scoring weights
  scoreWeightQueue: number;
  scoreWeightDistance: number;
  scoreWeightChain: number;
  scoreWeightVehicle: number;

  // Queue penalties
  refusePenaltyPositions: number;
  refusePenaltyDurationMin: number;

  // Auto-pause
  autoPauseRefusalsThreshold: number;
  autoPauseRefusalsWindowMin: number;
  autoPauseDurationMin: number;

  // Chaining
  chainMaxDistanceMeters: number;
  chainMaxPerHour: number;

  // GPS
  gpsUpdateIntervalSeconds: number;
  gpsExpirationMinutes: number;
  gpsMaxSpeedKmh: number;

  // Shadow mode
  scoringShadowMode: boolean;
}

/**
 * Wrapper sur SettingsService avec préfixe `deliverer.*`, parsing typé et fallback defaults.
 *
 * Consommé par :
 *   - `DelivererScoringService` → ranking des candidats pour une offre
 *   - `DelivererQueueService` → pénalités post-refus, auto-pause
 *   - `GpsLocationService` → validation vitesse aberrante, TTL position
 *   - `CourseGroupingService` (indirectement via chainMax) → détection fin imminente
 *
 * Pas de cache — relu à chaque appel pour que les changements admin soient
 * effectifs immédiatement (quantités faibles, pas de souci perf).
 */
@Injectable()
export class DelivererScoringSettingsHelper {
  private readonly logger = new Logger(DelivererScoringSettingsHelper.name);

  constructor(private readonly settingsService: SettingsService) {}

  /** Charge toutes les clés d'un coup (optimal — 1 query DB). */
  async load(): Promise<IDelivererScoringSettings> {
    const map = await this.settingsService.getMany([
      // Scoring
      'deliverer.score_weight_queue',
      'deliverer.score_weight_distance',
      'deliverer.score_weight_chain',
      'deliverer.score_weight_vehicle',
      // Queue & pénalités
      'deliverer.refuse_penalty_positions',
      'deliverer.refuse_penalty_duration_min',
      'deliverer.auto_pause_refusals_threshold',
      'deliverer.auto_pause_refusals_window_min',
      'deliverer.auto_pause_duration_min',
      // Chaining
      'deliverer.chain_max_distance_meters',
      'deliverer.chain_max_per_hour',
      // GPS
      'deliverer.gps_update_interval_seconds',
      'deliverer.gps_expiration_minutes',
      'deliverer.gps_max_speed_kmh',
      // Shadow mode
      'deliverer.scoring_shadow_mode',
    ]);

    return {
      scoreWeightQueue: this.toNumber(map['deliverer.score_weight_queue'], DEFAULTS.score_weight_queue, { allowZero: true }),
      scoreWeightDistance: this.toNumber(map['deliverer.score_weight_distance'], DEFAULTS.score_weight_distance, { allowZero: true }),
      scoreWeightChain: this.toNumber(map['deliverer.score_weight_chain'], DEFAULTS.score_weight_chain, { allowZero: true }),
      scoreWeightVehicle: this.toNumber(map['deliverer.score_weight_vehicle'], DEFAULTS.score_weight_vehicle, { allowZero: true }),

      refusePenaltyPositions: this.toNumber(map['deliverer.refuse_penalty_positions'], DEFAULTS.refuse_penalty_positions, { allowZero: true }),
      refusePenaltyDurationMin: this.toNumber(map['deliverer.refuse_penalty_duration_min'], DEFAULTS.refuse_penalty_duration_min),

      autoPauseRefusalsThreshold: this.toNumber(map['deliverer.auto_pause_refusals_threshold'], DEFAULTS.auto_pause_refusals_threshold),
      autoPauseRefusalsWindowMin: this.toNumber(map['deliverer.auto_pause_refusals_window_min'], DEFAULTS.auto_pause_refusals_window_min),
      autoPauseDurationMin: this.toNumber(map['deliverer.auto_pause_duration_min'], DEFAULTS.auto_pause_duration_min),

      chainMaxDistanceMeters: this.toNumber(map['deliverer.chain_max_distance_meters'], DEFAULTS.chain_max_distance_meters),
      chainMaxPerHour: this.toNumber(map['deliverer.chain_max_per_hour'], DEFAULTS.chain_max_per_hour, { allowZero: true }),

      gpsUpdateIntervalSeconds: this.toNumber(map['deliverer.gps_update_interval_seconds'], DEFAULTS.gps_update_interval_seconds),
      gpsExpirationMinutes: this.toNumber(map['deliverer.gps_expiration_minutes'], DEFAULTS.gps_expiration_minutes),
      gpsMaxSpeedKmh: this.toNumber(map['deliverer.gps_max_speed_kmh'], DEFAULTS.gps_max_speed_kmh),

      scoringShadowMode: this.toBoolean(map['deliverer.scoring_shadow_mode']),
    };
  }

  /** Parse boolean — accepte "true"/"1" comme vrai, le reste = faux. */
  private toBoolean(raw: string | undefined): boolean {
    if (!raw) return false;
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'on' || v === 'yes';
  }

  /**
   * Parse sécurisé. `allowZero: true` est utilisé pour les poids de scoring
   * (désactivation possible d'un critère) et pour `chain_max_per_hour` (0 = désactive
   * le chaînage). Les autres settings doivent être strictement positifs.
   */
  private toNumber(
    raw: string | undefined,
    fallback: number,
    opts: { allowZero?: boolean } = {},
  ): number {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      this.logger.warn(`Valeur non-numérique "${raw}" → fallback ${fallback}`);
      return fallback;
    }
    if (!opts.allowZero && n <= 0) {
      this.logger.warn(`Valeur <=0 "${raw}" refusée → fallback ${fallback}`);
      return fallback;
    }
    if (opts.allowZero && n < 0) {
      this.logger.warn(`Valeur négative "${raw}" refusée → fallback ${fallback}`);
      return fallback;
    }
    return n;
  }
}
