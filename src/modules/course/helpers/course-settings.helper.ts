import { Injectable, Logger } from '@nestjs/common';

import { SettingsService } from 'src/modules/settings/settings.service';

import {
  CLE_PLANIFICATEUR,
  CLE_PLANIFICATEUR_RESTAURANTS,
  CLES_REGLAGES_PLANIFICATION,
  lirePlanificateur,
  lireReglagesPlanification,
  planificateurDuRestaurant,
  PlanificateurLu,
  ReglagesPlanificationLus,
  VersionPlanificateur,
} from './planification.rules';
import { CLES_REGLAGES_PREPARATION, lireReglagesPreparation, ReglagesPreparationLus } from './preparation.rules';

/** Réglages du planificateur v2, lus d'un seul tenant (planification.rules.ts, preparation.rules.ts). */
export interface PlanificationLue {
  planificateur: PlanificateurLu;
  planification: ReglagesPlanificationLus;
  preparation: ReglagesPreparationLus;
  /** Toutes les valeurs refusées (remplacées par leur défaut), à signaler. */
  refusees: { cle: string; valeur: string }[];
}

/** Un même avertissement de réglage refusé au plus une fois par minute. */
const INTERVALLE_SIGNALEMENT_MS = 60 * 1000;

/**
 * Valeurs par défaut du module course.
 * Utilisées si la clé Settings n'est pas définie en base.
 */
const DEFAULTS = {
  // Offre & refus
  // 120 s (et non 90) : la fenêtre doit laisser la place à 2 relances (30 s et
  // 60 s) tout en gardant au livreur le temps de réagir après la dernière.
  offer_duration_seconds: 120,
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

  // Aucun livreur disponible : relance + alerte (au lieu d'expirer en silence)
  no_deliverer_alert_after_min: 5,  // délai avant d'alerter le staff (cloche)
  no_deliverer_max_wait_min: 60,    // au-delà, la course expire pour de bon (anti-zombie)

  // Détection des retards de livraison
  delay_alert_factor: 1.5,          // alerte si le réel dépasse l'estimé de 50 %

  // Saturation interne → bascule sur la flotte externe Turbo
  turbo_fallback_enabled: 1,        // 1 = sous-traiter à Turbo si aucun livreur interne
  turbo_fallback_after_min: 4,      // minutes d'attente avant de basculer (< alerte staff)
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
  // Aucun livreur disponible
  noDelivererAlertAfterMin: number;
  noDelivererMaxWaitMin: number;
  // Détection des retards
  delayAlertFactor: number;
  // Bascule flotte externe Turbo
  turboFallbackEnabled: boolean;
  turboFallbackAfterMin: number;
}

/**
 * Wrapper sur SettingsService avec préfixe `course.*`, parsing typé et fallback defaults.
 * Les valeurs sont relues à chaque appel (pas de cache) — les quantités sont faibles et
 * on veut que les changements côté admin soient effectifs immédiatement.
 */
@Injectable()
export class CourseSettingsHelper {
  private readonly logger = new Logger(CourseSettingsHelper.name);
  private readonly derniersSignalements = new Map<string, number>();

  constructor(private readonly settingsService: SettingsService) {}

  /**
   * PLANIFICATEUR v2 : version (`course.planificateur`, v2 par défaut),
   * restaurants concernés (`course.planificateur_restaurants`, vide = tous),
   * réglages du regroupement et de la préparation. Relus à chaque appel, en
   * une requête. Contrairement à `toNumber`, 0 est accepté là où il a un
   * sens ; une valeur refusée est remplacée par son défaut et SIGNALÉE (journal
   * au plus une fois par minute, et `refusees` pour le backoffice).
   */
  async lirePlanification(): Promise<PlanificationLue> {
    const valeurs = await this.settingsService.getMany([
      CLE_PLANIFICATEUR,
      CLE_PLANIFICATEUR_RESTAURANTS,
      ...CLES_REGLAGES_PLANIFICATION,
      ...Object.values(CLES_REGLAGES_PREPARATION),
    ]);
    const planificateur = lirePlanificateur(valeurs);
    const planification = lireReglagesPlanification(valeurs);
    const preparation = lireReglagesPreparation(valeurs);
    const refusees = [...planificateur.refusees, ...planification.refusees, ...preparation.refusees];
    const maintenant = Date.now();
    for (const { cle, valeur } of refusees) {
      if (maintenant - (this.derniersSignalements.get(cle) ?? 0) < INTERVALLE_SIGNALEMENT_MS) continue;
      this.derniersSignalements.set(cle, maintenant);
      this.logger.warn(`Réglage refusé ${cle} = « ${valeur} » : valeur par défaut appliquée.`);
    }
    return { planificateur, planification, preparation, refusees };
  }

  /** Planificateur d'un restaurant : `v2` (défaut) ou `v1` (ancien regroupement par lots). */
  async versionPour(restaurantId: string): Promise<VersionPlanificateur> {
    const valeurs = await this.settingsService.getMany([CLE_PLANIFICATEUR, CLE_PLANIFICATEUR_RESTAURANTS]);
    return planificateurDuRestaurant(lirePlanificateur(valeurs), restaurantId);
  }

  /** Lecture unique pour plusieurs restaurants (tâches qui parcourent tout le réseau). */
  async planificateurLu(): Promise<PlanificateurLu> {
    const valeurs = await this.settingsService.getMany([CLE_PLANIFICATEUR, CLE_PLANIFICATEUR_RESTAURANTS]);
    return lirePlanificateur(valeurs);
  }

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
      // Aucun livreur disponible
      'course.no_deliverer_alert_after_min',
      'course.no_deliverer_max_wait_min',
      'course.delay_alert_factor',
      // Bascule Turbo
      'course.turbo_fallback_enabled',
      'course.turbo_fallback_after_min',
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
      noDelivererAlertAfterMin: this.toNumber(map['course.no_deliverer_alert_after_min'], DEFAULTS.no_deliverer_alert_after_min),
      noDelivererMaxWaitMin: this.toNumber(map['course.no_deliverer_max_wait_min'], DEFAULTS.no_deliverer_max_wait_min),
      delayAlertFactor: this.toNumber(map['course.delay_alert_factor'], DEFAULTS.delay_alert_factor),
      turboFallbackEnabled: this.toBoolean(map['course.turbo_fallback_enabled'], DEFAULTS.turbo_fallback_enabled),
      turboFallbackAfterMin: this.toNumber(map['course.turbo_fallback_after_min'], DEFAULTS.turbo_fallback_after_min),
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
