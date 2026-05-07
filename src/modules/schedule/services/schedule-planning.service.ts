import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DelivererStatus,
  EntityStatus,
  RestDaySource,
  SchedulePlan,
  SchedulePlanStatus,
  ShiftAssignmentStatus,
  ShiftType,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';

import {
  type IScheduleSettings,
  ScheduleSettingsHelper,
  type WeekDay,
} from '../helpers/schedule-settings.helper';

const WEEKDAY_NAMES: WeekDay[] = [
  'sunday',     // Date.getDay() = 0
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const WEEKEND = new Set<WeekDay>(['saturday', 'sunday']);

interface IGenerateInput {
  restaurantId: string;
  /** Date de début du plan (sera ramenée à 00:00 UTC). */
  periodStart: Date;
  /**
   * Date de fin du plan (incluse). Si non fournie, calculée comme
   * periodStart + planning_period_weeks - 1 jour.
   */
  periodEnd?: Date;
}

/**
 * Service de génération automatique des plans de planning (P7.2).
 *
 * Algorithme :
 *   1. Charger les settings et les livreurs ACTIVE du restaurant
 *   2. Pour chaque jour de la période, créer Shift(MORNING) + Shift(EVENING)
 *      avec `max_slots = default × volume_multiplier`
 *   3. Distribuer les jours de repos via rotation FIFO :
 *      - Solo → repos forcé sur `solo_deliverer_rest_day`
 *      - Multi → round-robin sur `weekday_rest_days_per_deliverer` jours/sem
 *   4. Pour chaque (livreur, shift) où le livreur n'est pas en repos :
 *      créer ShiftAssignment(ASSIGNED).
 *
 * Le plan est créé en `DRAFT` — l'admin doit l'envoyer (transition SEND).
 */
@Injectable()
export class SchedulePlanningService {
  private readonly logger = new Logger(SchedulePlanningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ScheduleSettingsHelper,
    // P-push livreur : push "Nouveau planning" quand le plan est envoyé
    private readonly pushService: DelivererPushService,
  ) {}

  /**
   * Génère un plan DRAFT pour un restaurant.
   * Renvoie le plan créé avec ses shifts + assignments.
   *
   * @throws BadRequestException si pas de livreur ACTIVE pour ce restaurant
   *   ou si la période est invalide
   */
  async generatePlan(input: IGenerateInput): Promise<SchedulePlan> {
    const settings = await this.settings.load();
    const periodStart = startOfDay(input.periodStart);
    const periodEnd = startOfDay(
      input.periodEnd ?? this.computePeriodEnd(periodStart, settings),
    );

    if (periodEnd < periodStart) {
      throw new BadRequestException('periodEnd doit être >= periodStart');
    }

    // 0. Vérification de chevauchement avec un plan ACTIVE existant.
    //
    // Un plan ACTIVE = DRAFT/SENT/CONFIRMED (pas ARCHIVED). Si un tel plan
    // existe déjà sur tout ou partie de la nouvelle période pour ce restaurant,
    // on rejette : sinon le livreur recevrait 2 ShiftAssignments pour la
    // même date+type (un par plan), ce qui crée une UI confuse + des
    // RestDays incohérents + un cron deadline qui traite les 2 plans en parallèle.
    //
    // Sémantique d'overlap : `[a_start, a_end]` chevauche `[b_start, b_end]`
    // ssi `a_start <= b_end AND a_end >= b_start`.
    const overlapping = await this.prisma.schedulePlan.findFirst({
      where: {
        restaurant_id: input.restaurantId,
        status: { in: [SchedulePlanStatus.DRAFT, SchedulePlanStatus.SENT, SchedulePlanStatus.CONFIRMED] },
        period_start: { lte: periodEnd },
        period_end: { gte: periodStart },
      },
      select: { id: true, period_start: true, period_end: true, status: true },
    });
    if (overlapping) {
      const ovStart = overlapping.period_start.toISOString().substring(0, 10);
      const ovEnd = overlapping.period_end.toISOString().substring(0, 10);
      throw new BadRequestException(
        `Chevauchement avec le plan ${overlapping.id.slice(0, 8)} ` +
          `(${ovStart} → ${ovEnd}, statut ${overlapping.status}). ` +
          `Archive ou supprime ce plan avant d'en générer un nouveau pour cette période.`,
      );
    }

    // 1. Fetch livreurs candidats
    const deliverers = await this.prisma.deliverer.findMany({
      where: {
        restaurant_id: input.restaurantId,
        status: DelivererStatus.ACTIVE,
        entity_status: EntityStatus.ACTIVE,
      },
      orderBy: { created_at: 'asc' }, // ordre stable = équité rotation
      select: { id: true },
    });

    if (deliverers.length === 0) {
      throw new BadRequestException(
        `Aucun livreur ACTIVE pour le restaurant ${input.restaurantId.slice(0, 8)}`,
      );
    }

    // 2. Calculer les jours du plan + jours de repos par livreur
    const days = this.enumerateDays(periodStart, periodEnd);
    const restDayMap = this.computeRestDayDistribution(
      deliverers.map((d) => d.id),
      days,
      settings,
    );

    // 3. Créer le plan + shifts + assignments en transaction.
    //
    // **Optimisation perf** : on batch toutes les operations pour rester
    // bien sous le timeout transaction (5s par défaut). Avec une période de
    // 2 semaines × 2 shifts/jour × 5 livreurs, l'ancien code faisait ~57
    // queries séquentielles → timeout systématique sur Neon (latence ~50ms).
    //
    // Nouveau plan : 4 queries totales (plan, shifts, assignments, restDays)
    // grâce à `createManyAndReturn` (Prisma 6+).
    //
    // Le timeout est aussi explicitement étendu à 30s en filet de sécurité
    // pour les très grandes équipes (50+ livreurs).
    const plan = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.schedulePlan.create({
          data: {
            restaurant_id: input.restaurantId,
            period_start: periodStart,
            period_end: periodEnd,
            status: SchedulePlanStatus.DRAFT,
          },
        });

        // Pré-générer les data des shifts en mémoire
        const shiftsToCreate: {
          plan_id: string;
          date: Date;
          type: ShiftType;
          start_time: string;
          end_time: string;
          max_slots: number;
        }[] = [];
        for (const day of days) {
          const dayName = WEEKDAY_NAMES[day.getDay()];
          const isWeekend = WEEKEND.has(dayName);
          const volumeMultiplier = isWeekend
            ? settings.weekendVolumeMultiplier
            : settings.weekdayVolumeMultiplier;

          for (const shiftType of [ShiftType.MORNING, ShiftType.EVENING] as const) {
            const range =
              shiftType === ShiftType.MORNING ? settings.shiftMorning : settings.shiftEvening;
            const baseSlots =
              shiftType === ShiftType.MORNING
                ? settings.defaultSlotsMorning
                : settings.defaultSlotsEvening;
            const maxSlots = Math.max(1, Math.round(baseSlots * volumeMultiplier));

            shiftsToCreate.push({
              plan_id: created.id,
              date: day,
              type: shiftType,
              start_time: range.start,
              end_time: range.end,
              max_slots: maxSlots,
            });
          }
        }

        // 1 batch insert pour TOUS les shifts (au lieu de N queries séquentielles)
        const createdShifts = await tx.shift.createManyAndReturn({
          data: shiftsToCreate,
          select: { id: true, date: true, type: true },
        });

        // Préparer les assignments en mémoire (pour livreurs hors-repos)
        const assignmentsToCreate: {
          shift_id: string;
          deliverer_id: string;
          status: ShiftAssignmentStatus;
        }[] = [];
        for (const shift of createdShifts) {
          const dayKey = this.dateKey(shift.date);
          for (const d of deliverers) {
            const restSet = restDayMap.get(d.id) ?? new Set<string>();
            if (restSet.has(dayKey)) continue; // jour de repos → pas d'affectation
            assignmentsToCreate.push({
              shift_id: shift.id,
              deliverer_id: d.id,
              status: ShiftAssignmentStatus.ASSIGNED,
            });
          }
        }

        // 1 batch insert pour TOUS les assignments
        if (assignmentsToCreate.length > 0) {
          await tx.shiftAssignment.createMany({
            data: assignmentsToCreate,
            skipDuplicates: true,
          });
        }

        // 4. Aussi enregistrer les RestDay AUTO pour chaque livreur
        // Évite de re-deviner la rotation lors des consultations futures.
        const allRestDays: { deliverer_id: string; date: Date; source: RestDaySource }[] = [];
        for (const [delivererId, dayKeys] of restDayMap.entries()) {
          for (const key of dayKeys) {
            allRestDays.push({
              deliverer_id: delivererId,
              date: this.parseKey(key),
              source: RestDaySource.AUTO,
            });
          }
        }
        if (allRestDays.length > 0) {
          await tx.restDay.createMany({
            data: allRestDays,
            skipDuplicates: true,
          });
        }

        return created;
      },
      {
        // Filet de sécurité — la batch optimization devrait rester bien en
        // dessous, mais Neon peut avoir des hoquets de latence.
        timeout: 30_000,
        maxWait: 10_000,
      },
    );

    this.logger.log(
      `Plan ${plan.id.slice(0, 8)} généré : ${days.length} jours × 2 shifts, ` +
        `${deliverers.length} livreur(s), restaurant ${input.restaurantId.slice(0, 8)}`,
    );

    return plan;
  }

  /**
   * Transition DRAFT → SENT : verrouille le plan, démarre la deadline d'acceptation.
   * À ce stade, les shifts sont visibles côté livreur mobile.
   *
   * @throws BadRequestException si le plan n'est pas en DRAFT
   * @throws NotFoundException si le plan n'existe pas
   */
  async sendPlan(planId: string): Promise<SchedulePlan> {
    const plan = await this.prisma.schedulePlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException(`Plan ${planId} introuvable`);
    if (plan.status !== SchedulePlanStatus.DRAFT) {
      throw new BadRequestException(
        `Seul un plan DRAFT peut être envoyé (statut actuel : ${plan.status})`,
      );
    }
    const updated = await this.prisma.schedulePlan.update({
      where: { id: planId },
      data: { status: SchedulePlanStatus.SENT, sent_at: new Date() },
    });

    // P-push livreur : alerter chaque livreur ayant des assignments dans ce plan.
    // On bouble en interne sur les delivererId distincts.
    const delivererIds = await this.prisma.shiftAssignment.findMany({
      where: { shift: { plan_id: planId } },
      select: { deliverer_id: true },
      distinct: ['deliverer_id'],
    });
    const periodStart = updated.period_start.toISOString().substring(0, 10);
    const periodEnd = updated.period_end.toISOString().substring(0, 10);
    for (const { deliverer_id } of delivererIds) {
      this.pushService.notifyPlanSent({
        delivererId: deliverer_id,
        periodStart,
        periodEnd,
        planId: updated.id,
      });
    }

    return updated;
  }

  /**
   * Marque un plan comme CONFIRMED (toutes les réponses collectées ou deadline
   * passée). Le snapshot `confirmed_count` est calculé ici.
   */
  async confirmPlan(planId: string): Promise<SchedulePlan> {
    const plan = await this.prisma.schedulePlan.findUnique({
      where: { id: planId },
      include: {
        shifts: { include: { assignments: true } },
      },
    });
    if (!plan) throw new NotFoundException(`Plan ${planId} introuvable`);
    if (plan.status !== SchedulePlanStatus.SENT) {
      throw new BadRequestException(
        `Seul un plan SENT peut être confirmé (statut actuel : ${plan.status})`,
      );
    }

    const allAssignments = plan.shifts.flatMap((s) => s.assignments);
    const confirmedCount = new Set(
      allAssignments
        .filter((a) => a.status === ShiftAssignmentStatus.CONFIRMED)
        .map((a) => a.deliverer_id),
    ).size;

    return this.prisma.schedulePlan.update({
      where: { id: planId },
      data: {
        status: SchedulePlanStatus.CONFIRMED,
        confirmed_at: new Date(),
        confirmed_count: confirmedCount,
      },
    });
  }

  /** Archive un plan terminé (libère l'espace de la matrice UI). */
  async archivePlan(planId: string): Promise<SchedulePlan> {
    return this.prisma.schedulePlan.update({
      where: { id: planId },
      data: { status: SchedulePlanStatus.ARCHIVED, archived_at: new Date() },
    });
  }

  // ============================================================
  // ALGORITHMES INTERNES
  // ============================================================

  /**
   * Distribue les jours de repos via une rotation déterministe :
   *   - 1 livreur seul → repos forcé sur `solo_deliverer_rest_day`
   *   - N livreurs    → round-robin par index (livreur i, semaine s) :
   *     `restDayIndex = (i + s × repos_par_semaine) mod nbWeekdays`
   *
   * Garantit l'équité sur `rotation_cycle_weeks` semaines : chaque livreur
   * passe par tous les jours possibles. Les weekends sont exclus sauf si
   * `weekend_rest_allowed = true`.
   */
  private computeRestDayDistribution(
    delivererIds: string[],
    days: Date[],
    settings: IScheduleSettings,
  ): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    delivererIds.forEach((id) => result.set(id, new Set<string>()));

    if (delivererIds.length === 0) return result;

    // Cas particulier : 1 seul livreur
    if (delivererIds.length === 1) {
      const restSet = result.get(delivererIds[0])!;
      for (const day of days) {
        const dayName = WEEKDAY_NAMES[day.getDay()];
        if (dayName === settings.soloDelivererRestDay) {
          restSet.add(this.dateKey(day));
        }
      }
      return result;
    }

    // Cas multi-livreurs : grouper les jours par semaine
    const weeks = this.groupByWeek(days, settings.weekendRestAllowed);
    weeks.forEach((weekDays, weekIndex) => {
      delivererIds.forEach((delivererId, deliverIndex) => {
        // Combien de jours de repos pour ce livreur cette semaine
        const restDaysCount = settings.weekdayRestDaysPerDeliverer;

        // Round-robin : décale chaque livreur d'une position par semaine
        const restSet = result.get(delivererId)!;
        for (let r = 0; r < restDaysCount && weekDays.length > 0; r++) {
          const offset = (deliverIndex + weekIndex + r * delivererIds.length) % weekDays.length;
          restSet.add(this.dateKey(weekDays[offset]));
        }
      });
    });

    return result;
  }

  private groupByWeek(days: Date[], includeWeekend: boolean): Date[][] {
    const result: Date[][] = [];
    let currentWeek: Date[] = [];
    for (const day of days) {
      const dayName = WEEKDAY_NAMES[day.getDay()];
      const isWeekend = WEEKEND.has(dayName);
      if (isWeekend && !includeWeekend) continue;

      // Nouveau lundi → nouvelle semaine
      if (currentWeek.length > 0 && day.getDay() === 1) {
        result.push(currentWeek);
        currentWeek = [];
      }
      currentWeek.push(day);
    }
    if (currentWeek.length > 0) result.push(currentWeek);
    return result;
  }

  private enumerateDays(start: Date, end: Date): Date[] {
    const days: Date[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      days.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }

  private computePeriodEnd(start: Date, settings: IScheduleSettings): Date {
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + settings.planningPeriodWeeks * 7 - 1);
    return end;
  }

  private dateKey(d: Date): string {
    return d.toISOString().substring(0, 10); // YYYY-MM-DD
  }

  private parseKey(key: string): Date {
    return startOfDay(new Date(`${key}T00:00:00.000Z`));
  }
}

// ============================================================
// HELPERS PURS
// ============================================================

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}
