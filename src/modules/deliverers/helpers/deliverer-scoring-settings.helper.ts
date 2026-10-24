import { Injectable, Logger } from '@nestjs/common';

import { SettingsService } from 'src/modules/settings/settings.service';

import { CLE_OFFRE_JOIGNABLES_SEULEMENT, lireOffreJoignablesSeulement } from './disponibilite.rules';

/** Réglage de course du retard d'une tournée, et son défaut (`CourseSettingsHelper`). */
const CLE_FACTEUR_RETARD = 'course.delay_alert_factor';
const FACTEUR_RETARD_DEFAUT = 1.5;

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
  // SUSPENDU dans le code (deliverer-scoring.service.ts, lot 9 de la
  // conception) : ce réglage ne le réactive plus.
  chain_max_distance_meters: 1000,
  chain_max_per_hour: 2,

  // Filet pour les téléphones oubliés : un livreur qui laisse expirer une
  // offre sans aucun signal (position ou requête) depuis ce nombre de minutes
  // passe hors service. 0 = coupé.
  hors_service_sans_signal_min: 20,

  // Appli fermée (demande du 24/10) : sans socket ouvert ni signe de vie
  // (position ou requête) depuis ce nombre de secondes, l'appli du livreur est
  // réputée fermée et il ne reçoit plus d'offre jusqu'à sa réouverture, sans
  // pause ni pénalité. 0 = règle coupée.
  appli_fermee_apres_s: 180,

  // Classement par TEMPS DE TRAJET réel (Google Distance Matrix)
  // Désactivé par défaut : chaque offre déclenche un appel Google facturé.
  // À activer quand le gain de pertinence justifie le coût.
  travel_time_ranking: 0,
  travel_time_top_n: 4,

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

  /** Minutes sans signal après lesquelles une offre ignorée met hors service. 0 = coupé. */
  horsServiceSansSignalMin: number;
  /** Secondes sans socket ni signe de vie après lesquelles l'appli est réputée fermée. 0 = coupé. */
  appliFermeeApresS: number;
  /**
   * Offre aux seuls livreurs joignables (socket ouvert ou jeton de
   * notification). Réglage de course `course.offre_joignables_seulement`
   * (défaut 1, 0 = coupé), lu ici avec ceux de l'appli : la règle unique des
   * offres est au module des livreurs.
   */
  offreJoignablesSeulement: boolean;

  // GPS
  gpsUpdateIntervalSeconds: number;
  gpsExpirationMinutes: number;
  gpsMaxSpeedKmh: number;

  /**
   * Retard d'une tournée : réglage de course `course.delay_alert_factor`
   * (défaut 1,5, comme `CourseSettingsHelper`), lu ici pour la course en
   * cours de chaque livreur (`GET /deliverers/live-locations`).
   */
  facteurRetard: number;

  // Shadow mode
  scoringShadowMode: boolean;
  /** Affiner le classement des meilleurs candidats par temps de trajet réel. */
  travelTimeRanking: boolean;
  /** Nombre de candidats soumis au calcul de temps de trajet (borne le coût). */
  travelTimeTopN: number;
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
      // Hors service sans signal
      'deliverer.hors_service_sans_signal_min',
      // Appli fermée
      'deliverer.appli_fermee_apres_s',
      // Livreurs joignables seulement (réglage de course)
      CLE_OFFRE_JOIGNABLES_SEULEMENT,
      // GPS
      'deliverer.travel_time_ranking',
      'deliverer.travel_time_top_n',
      'deliverer.gps_update_interval_seconds',
      'deliverer.gps_expiration_minutes',
      'deliverer.gps_max_speed_kmh',
      // Retard d'une tournée (réglage de course)
      CLE_FACTEUR_RETARD,
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

      travelTimeRanking: this.toBoolean(map['deliverer.travel_time_ranking']),
      travelTimeTopN: this.toNumber(map['deliverer.travel_time_top_n'], DEFAULTS.travel_time_top_n),
      chainMaxDistanceMeters: this.toNumber(map['deliverer.chain_max_distance_meters'], DEFAULTS.chain_max_distance_meters),
      chainMaxPerHour: this.toNumber(map['deliverer.chain_max_per_hour'], DEFAULTS.chain_max_per_hour, { allowZero: true }),
      // 0 accepté : coupe le filet.
      horsServiceSansSignalMin: this.toNumber(map['deliverer.hors_service_sans_signal_min'], DEFAULTS.hors_service_sans_signal_min, { allowZero: true }),
      // 0 accepté : coupe la règle de l'appli fermée.
      appliFermeeApresS: this.toNumber(map['deliverer.appli_fermee_apres_s'], DEFAULTS.appli_fermee_apres_s, { allowZero: true }),
      // Défaut 1, comme les autres réglages de course à deux valeurs.
      offreJoignablesSeulement: lireOffreJoignablesSeulement(map[CLE_OFFRE_JOIGNABLES_SEULEMENT]),

      gpsUpdateIntervalSeconds: this.toNumber(map['deliverer.gps_update_interval_seconds'], DEFAULTS.gps_update_interval_seconds),
      gpsExpirationMinutes: this.toNumber(map['deliverer.gps_expiration_minutes'], DEFAULTS.gps_expiration_minutes),
      gpsMaxSpeedKmh: this.toNumber(map['deliverer.gps_max_speed_kmh'], DEFAULTS.gps_max_speed_kmh),

      facteurRetard: this.toNumber(map[CLE_FACTEUR_RETARD], FACTEUR_RETARD_DEFAUT),

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
