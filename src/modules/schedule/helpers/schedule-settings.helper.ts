import { Injectable, Logger } from '@nestjs/common';

import { SettingsService } from 'src/modules/settings/settings.service';

/**
 * Valeurs par défaut du module schedule (P7).
 * Utilisées si la clé Settings n'est pas définie en base.
 *
 * Les 17 settings sont catégorisés en 6 groupes pour faciliter le paramétrage
 * côté backoffice (page Paramètres → Planning) :
 *
 *   A. Période & rotation       (2 clés)
 *   B. Repos                     (4 clés)
 *   C. Créneaux                  (5 clés)
 *   D. Volume                    (2 clés)
 *   E. Workflow envoi            (3 clés)
 *   F. Check-in matin            (1 clé)
 */
const DEFAULTS = {
  // ── A. Période & rotation ──────────────────────────────────────────────
  /// Durée d'un plan en semaines (2 = quinzaine).
  planning_period_weeks: 2,
  /// Durée du cycle de rotation des jours de repos en semaines.
  /// 4 = chaque livreur change de jour de repos toutes les 4 semaines.
  rotation_cycle_weeks: 4,

  // ── B. Repos ───────────────────────────────────────────────────────────
  /// Nombre de jours de repos en semaine (lun-ven) par livreur sur la période.
  weekday_rest_days_per_deliverer: 1,
  /// `1` autorise le repos en weekend (sam/dim), `0` jamais.
  weekend_rest_allowed: 0,
  /// Si UN SEUL livreur dans le restaurant : jour de repos forcé (string).
  /// Valeurs : 'monday' | 'tuesday' | … | 'sunday'
  solo_deliverer_rest_day: 'sunday',
  /// `1` permet au livreur de modifier ses jours de repos via mobile, `0` admin only.
  allow_rest_day_override: 1,

  // ── C. Créneaux ────────────────────────────────────────────────────────
  /// Plage horaire du shift du matin, format "HH:mm-HH:mm".
  shift_morning: '09:00-15:00',
  /// Plage horaire du shift du soir, format "HH:mm-HH:mm".
  shift_evening: '15:00-23:00',
  /// Nombre de slots de base le matin (sera multiplié par volume_multiplier).
  default_slots_morning: 3,
  /// Nombre de slots de base le soir.
  default_slots_evening: 3,
  /// `1` bloque les acceptations au-delà de max_slots, `0` autorise dépassement.
  enforce_slots: 0,

  // ── D. Volume ──────────────────────────────────────────────────────────
  /// Multiplicateur de volume en semaine (lun-ven).
  weekday_volume_multiplier: 1.0,
  /// Multiplicateur de volume le weekend (sam/dim) — typiquement plus élevé.
  weekend_volume_multiplier: 1.5,

  // ── E. Workflow envoi ──────────────────────────────────────────────────
  /// Combien d'heures les livreurs ont pour répondre avant l'auto-CONFIRMED.
  acceptance_deadline_hours: 48,
  /// Jour de la semaine d'envoi auto du planning (0=dimanche, 5=vendredi).
  auto_send_day_of_week: 5,
  /// Heure d'envoi auto du planning.
  auto_send_hour: 18,

  // ── F. Check-in matin ──────────────────────────────────────────────────
  /// Heure du push de check-in matinal "Tu es opérationnel aujourd'hui ?"
  daily_presence_check_hour: 8,
} as const;

export type WeekDay =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

const VALID_WEEKDAYS: ReadonlySet<WeekDay> = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

export interface IScheduleSettings {
  // A. Période & rotation
  planningPeriodWeeks: number;
  rotationCycleWeeks: number;

  // B. Repos
  weekdayRestDaysPerDeliverer: number;
  weekendRestAllowed: boolean;
  soloDelivererRestDay: WeekDay;
  allowRestDayOverride: boolean;

  // C. Créneaux
  shiftMorning: { start: string; end: string };
  shiftEvening: { start: string; end: string };
  defaultSlotsMorning: number;
  defaultSlotsEvening: number;
  enforceSlots: boolean;

  // D. Volume
  weekdayVolumeMultiplier: number;
  weekendVolumeMultiplier: number;

  // E. Workflow envoi
  acceptanceDeadlineHours: number;
  autoSendDayOfWeek: number; // 0-6 (0=dimanche)
  autoSendHour: number;      // 0-23

  // F. Check-in matin
  dailyPresenceCheckHour: number; // 0-23
}

/**
 * Wrapper sur SettingsService avec préfixe `schedule.*`, parsing typé et fallback defaults.
 *
 * Pas de cache — relu à chaque appel pour que les changements admin soient
 * effectifs immédiatement (quantités faibles, pas de souci perf).
 */
@Injectable()
export class ScheduleSettingsHelper {
  private readonly logger = new Logger(ScheduleSettingsHelper.name);

  constructor(private readonly settingsService: SettingsService) {}

  /** Charge toutes les clés d'un coup (optimal — 1 query DB). */
  async load(): Promise<IScheduleSettings> {
    const map = await this.settingsService.getMany([
      'schedule.planning_period_weeks',
      'schedule.rotation_cycle_weeks',
      'schedule.weekday_rest_days_per_deliverer',
      'schedule.weekend_rest_allowed',
      'schedule.solo_deliverer_rest_day',
      'schedule.allow_rest_day_override',
      'schedule.shift_morning',
      'schedule.shift_evening',
      'schedule.default_slots_morning',
      'schedule.default_slots_evening',
      'schedule.enforce_slots',
      'schedule.weekday_volume_multiplier',
      'schedule.weekend_volume_multiplier',
      'schedule.acceptance_deadline_hours',
      'schedule.auto_send_day_of_week',
      'schedule.auto_send_hour',
      'schedule.daily_presence_check_hour',
    ]);

    return {
      planningPeriodWeeks: this.toNumber(
        map['schedule.planning_period_weeks'],
        DEFAULTS.planning_period_weeks,
      ),
      rotationCycleWeeks: this.toNumber(
        map['schedule.rotation_cycle_weeks'],
        DEFAULTS.rotation_cycle_weeks,
      ),
      weekdayRestDaysPerDeliverer: this.toNumber(
        map['schedule.weekday_rest_days_per_deliverer'],
        DEFAULTS.weekday_rest_days_per_deliverer,
        { allowZero: true },
      ),
      weekendRestAllowed: this.toBoolean(
        map['schedule.weekend_rest_allowed'],
        DEFAULTS.weekend_rest_allowed,
      ),
      soloDelivererRestDay: this.toWeekDay(
        map['schedule.solo_deliverer_rest_day'],
        DEFAULTS.solo_deliverer_rest_day as WeekDay,
      ),
      allowRestDayOverride: this.toBoolean(
        map['schedule.allow_rest_day_override'],
        DEFAULTS.allow_rest_day_override,
      ),
      shiftMorning: this.toTimeRange(
        map['schedule.shift_morning'],
        DEFAULTS.shift_morning,
      ),
      shiftEvening: this.toTimeRange(
        map['schedule.shift_evening'],
        DEFAULTS.shift_evening,
      ),
      defaultSlotsMorning: this.toNumber(
        map['schedule.default_slots_morning'],
        DEFAULTS.default_slots_morning,
      ),
      defaultSlotsEvening: this.toNumber(
        map['schedule.default_slots_evening'],
        DEFAULTS.default_slots_evening,
      ),
      enforceSlots: this.toBoolean(
        map['schedule.enforce_slots'],
        DEFAULTS.enforce_slots,
      ),
      weekdayVolumeMultiplier: this.toNumber(
        map['schedule.weekday_volume_multiplier'],
        DEFAULTS.weekday_volume_multiplier,
      ),
      weekendVolumeMultiplier: this.toNumber(
        map['schedule.weekend_volume_multiplier'],
        DEFAULTS.weekend_volume_multiplier,
      ),
      acceptanceDeadlineHours: this.toNumber(
        map['schedule.acceptance_deadline_hours'],
        DEFAULTS.acceptance_deadline_hours,
      ),
      autoSendDayOfWeek: this.toIntInRange(
        map['schedule.auto_send_day_of_week'],
        DEFAULTS.auto_send_day_of_week,
        0,
        6,
      ),
      autoSendHour: this.toIntInRange(
        map['schedule.auto_send_hour'],
        DEFAULTS.auto_send_hour,
        0,
        23,
      ),
      dailyPresenceCheckHour: this.toIntInRange(
        map['schedule.daily_presence_check_hour'],
        DEFAULTS.daily_presence_check_hour,
        0,
        23,
      ),
    };
  }

  // ============================================================
  // PARSERS
  // ============================================================

  private toBoolean(raw: string | undefined, fallback: number): boolean {
    if (raw === undefined || raw === '') return fallback === 1;
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'on' || v === 'yes';
  }

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

  private toIntInRange(
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (raw === undefined || raw === '') return fallback;
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n < min || n > max) {
      this.logger.warn(
        `Valeur hors plage [${min},${max}] : "${raw}" → fallback ${fallback}`,
      );
      return fallback;
    }
    return n;
  }

  private toWeekDay(raw: string | undefined, fallback: WeekDay): WeekDay {
    if (!raw) return fallback;
    const v = raw.trim().toLowerCase();
    if (VALID_WEEKDAYS.has(v as WeekDay)) return v as WeekDay;
    this.logger.warn(`Jour invalide "${raw}" → fallback ${fallback}`);
    return fallback;
  }

  /**
   * Parse une plage horaire au format "HH:mm-HH:mm".
   * En cas de format invalide, retourne le default parsé.
   */
  private toTimeRange(
    raw: string | undefined,
    fallback: string,
  ): { start: string; end: string } {
    const source = raw && raw.trim() ? raw.trim() : fallback;
    const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(source);
    if (!match) {
      this.logger.warn(
        `Plage horaire invalide "${raw}" — attendu "HH:mm-HH:mm" → fallback ${fallback}`,
      );
      const fallbackMatch = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(fallback);
      return fallbackMatch
        ? { start: `${fallbackMatch[1]}:${fallbackMatch[2]}`, end: `${fallbackMatch[3]}:${fallbackMatch[4]}` }
        : { start: '00:00', end: '00:00' };
    }
    return {
      start: `${match[1]}:${match[2]}`,
      end: `${match[3]}:${match[4]}`,
    };
  }
}
