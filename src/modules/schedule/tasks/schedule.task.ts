import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  DelivererStatus,
  EntityStatus,
  PresenceCheckResponse,
  SchedulePlanStatus,
  ShiftAssignmentStatus,
  ShiftType,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';

import { ScheduleEvent } from '../events/schedule.event';
import { ScheduleSettingsHelper } from '../helpers/schedule-settings.helper';
import { SchedulePlanningService } from '../services/schedule-planning.service';

/**
 * Tâches cron du module schedule (P7.4).
 *
 *   - `autoSendWeeklyPlans` (every hour) : déclenche la génération + envoi auto
 *     du planning de la prochaine période quand on est au jour/heure définis.
 *   - `dailyPresenceCheckPush` (every hour) : crée + diffuse le check-in du jour.
 *   - `closeOverduePlans` (every 30 min) : passe les plans SENT en CONFIRMED
 *     une fois la deadline d'acceptation dépassée.
 *   - `markNoResponseCheckIns` (every hour) : auto-CONFIRMED PRESENT pour les
 *     check-ins sans réponse passé un certain délai (politique Q6=A).
 */
@Injectable()
export class ScheduleTask {
  private readonly logger = new Logger(ScheduleTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ScheduleSettingsHelper,
    private readonly planningService: SchedulePlanningService,
    private readonly scheduleEvent: ScheduleEvent,
    // P-push livreur : push check-in 8h chaque matin
    private readonly pushService: DelivererPushService,
  ) {}

  /**
   * Vérifie chaque heure si on est dans la fenêtre d'envoi auto :
   * `auto_send_day_of_week` à `auto_send_hour`. Si oui, génère + envoie
   * un plan pour la prochaine période pour chaque restaurant ACTIVE.
   *
   * Idempotent : si un plan DRAFT/SENT existe déjà pour la prochaine
   * période, on skip (pas de doublon).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async autoSendWeeklyPlans() {
    try {
      const settings = await this.settings.load();
      const now = new Date();
      const dayOfWeek = now.getDay();
      const hour = now.getHours();

      if (dayOfWeek !== settings.autoSendDayOfWeek || hour !== settings.autoSendHour) {
        return; // pas le bon créneau
      }

      const restaurants = await this.prisma.restaurant.findMany({
        where: { entity_status: EntityStatus.ACTIVE },
        select: { id: true, name: true },
      });

      const periodStart = startOfDay(addDays(now, 7)); // commence dans 7 jours

      for (const r of restaurants) {
        try {
          // Skip si un plan existe déjà pour cette date de début
          const existing = await this.prisma.schedulePlan.findFirst({
            where: {
              restaurant_id: r.id,
              period_start: periodStart,
              status: { in: [SchedulePlanStatus.DRAFT, SchedulePlanStatus.SENT] },
            },
            select: { id: true },
          });
          if (existing) {
            this.logger.debug(
              `autoSendWeeklyPlans skip ${r.name} : plan déjà en cours pour ${periodStart.toISOString().substring(0, 10)}`,
            );
            continue;
          }

          const plan = await this.planningService.generatePlan({
            restaurantId: r.id,
            periodStart,
          });
          await this.planningService.sendPlan(plan.id);

          // Émettre WS pour notifier les livreurs
          const delivererIds = await this.fetchPlanDelivererIds(plan.id);
          await this.scheduleEvent.planSent({
            planId: plan.id,
            restaurantId: r.id,
            periodStart: plan.period_start.toISOString().substring(0, 10),
            periodEnd: plan.period_end.toISOString().substring(0, 10),
            delivererIds,
          });

          this.logger.log(
            `autoSendWeeklyPlans : plan ${plan.id.slice(0, 8)} envoyé pour ${r.name}`,
          );
        } catch (err) {
          this.logger.error(
            `autoSendWeeklyPlans échec pour ${r.name}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Erreur cron autoSendWeeklyPlans: ${(err as Error).message}`);
    }
  }

  /**
   * Crée le check-in matinal pour chaque livreur ACTIVE et déclenche le push.
   * Tourne chaque heure : ne fait rien sauf à `daily_presence_check_hour`.
   *
   * Idempotent : skip les check-ins déjà créés pour aujourd'hui.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async dailyPresenceCheckPush() {
    try {
      const settings = await this.settings.load();
      const now = new Date();
      if (now.getHours() !== settings.dailyPresenceCheckHour) return;

      const today = startOfDay(now);

      const deliverers = await this.prisma.deliverer.findMany({
        where: {
          status: DelivererStatus.ACTIVE,
          is_operational: true,
          entity_status: EntityStatus.ACTIVE,
        },
        select: { id: true },
      });

      for (const d of deliverers) {
        try {
          // Trouver le shift principal du jour pour ce livreur (pour info push)
          const shiftType = await this.findTodayShiftType(d.id, today);

          // Upsert silencieux du check-in
          await this.prisma.dailyPresenceCheck.upsert({
            where: { deliverer_id_date: { deliverer_id: d.id, date: today } },
            update: {}, // on ne touche pas à une réponse déjà donnée
            create: {
              deliverer_id: d.id,
              date: today,
              response: PresenceCheckResponse.NO_RESPONSE,
              shift_type: shiftType,
            },
          });

          await this.scheduleEvent.presenceCheckRequest({
            delivererId: d.id,
            date: today.toISOString().substring(0, 10),
            shiftType,
          });

          // P-push livreur : push notif "Tu es opérationnel aujourd'hui ?"
          // Important pour réveiller le livreur — sans push, l'app doit être
          // ouverte pour qu'il voie la modale check-in.
          this.pushService.notifyPresenceCheck({ delivererId: d.id });
        } catch (err) {
          this.logger.warn(
            `dailyPresenceCheckPush échec pour ${d.id.slice(0, 8)}: ${(err as Error).message}`,
          );
        }
      }

      this.logger.log(`dailyPresenceCheckPush : ${deliverers.length} livreur(s) notifié(s)`);
    } catch (err) {
      this.logger.error(`Erreur cron dailyPresenceCheckPush: ${(err as Error).message}`);
    }
  }

  /**
   * Auto-CONFIRMED des check-ins matinaux NO_RESPONSE après 4h sans réponse.
   * Politique Q6=A : "pas de réponse" = "présent" par défaut.
   *
   * **Fix overflow** : on compare des timestamps (et non `getHours()`) pour
   * gérer naturellement le cas où check_hour est tard dans la journée
   * (ex : 22h → cutoff 02h le lendemain).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async markNoResponseCheckIns() {
    try {
      const settings = await this.settings.load();
      const now = new Date();
      const today = startOfDay(now);

      // Moment du check-in d'aujourd'hui (heure locale serveur).
      const todayCheckMoment = new Date(today);
      todayCheckMoment.setHours(settings.dailyPresenceCheckHour, 0, 0, 0);
      // 4h après → cutoff. Géré naturellement par addition de millis (overflow ok).
      const cutoffMoment = new Date(
        todayCheckMoment.getTime() + 4 * 60 * 60 * 1000,
      );

      if (now < cutoffMoment) {
        return; // pas encore 4h après le check-in du jour
      }

      const result = await this.prisma.dailyPresenceCheck.updateMany({
        where: {
          date: today,
          response: PresenceCheckResponse.NO_RESPONSE,
        },
        data: {
          response: PresenceCheckResponse.PRESENT,
          // responded_at reste null pour distinguer auto-confirmé d'une réponse explicite
        },
      });

      if (result.count > 0) {
        this.logger.log(
          `markNoResponseCheckIns : ${result.count} check-in(s) auto-CONFIRMED PRESENT`,
        );
      }
    } catch (err) {
      this.logger.error(`Erreur cron markNoResponseCheckIns: ${(err as Error).message}`);
    }
  }

  /**
   * Auto-CONFIRMED des assignments ASSIGNED après la deadline d'acceptation
   * d'un plan SENT, puis transition CONFIRMED du plan.
   *
   * Tourne toutes les 30 min — fenêtre de tolérance pour ne pas rater le moment
   * exact où la deadline tombe.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async closeOverduePlans() {
    try {
      const settings = await this.settings.load();
      const cutoff = new Date(
        Date.now() - settings.acceptanceDeadlineHours * 60 * 60 * 1000,
      );

      const overdue = await this.prisma.schedulePlan.findMany({
        where: {
          status: SchedulePlanStatus.SENT,
          sent_at: { lte: cutoff },
        },
        select: { id: true, restaurant_id: true },
      });

      for (const plan of overdue) {
        try {
          // Auto-CONFIRMED des ASSIGNED restants
          const updated = await this.prisma.shiftAssignment.updateMany({
            where: {
              shift: { plan_id: plan.id },
              status: ShiftAssignmentStatus.ASSIGNED,
            },
            data: {
              status: ShiftAssignmentStatus.CONFIRMED,
              confirmed_at: new Date(),
            },
          });

          // Transition plan CONFIRMED
          await this.planningService.confirmPlan(plan.id);

          this.logger.log(
            `closeOverduePlans : plan ${plan.id.slice(0, 8)} confirmé (${updated.count} assignment(s) auto-CONFIRMED)`,
          );
        } catch (err) {
          this.logger.error(
            `closeOverduePlans échec pour plan ${plan.id.slice(0, 8)}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Erreur cron closeOverduePlans: ${(err as Error).message}`);
    }
  }

  /**
   * Auto-archivage des plans dont la période est terminée (`period_end < today`).
   *
   * Tourne 1× par jour à 3h du matin (heure creuse — pas de livraison en cours).
   * Idempotent : `archivePlan` retourne le plan si déjà ARCHIVED, donc rien
   * de cassé si le cron tourne 2 fois.
   *
   * Sans ce cron, les plans CONFIRMED s'accumulent dans la liste backoffice
   * sans jamais passer en ARCHIVED → bruit visuel + risque de chevauchement
   * détecté par `generatePlan` (qui rejette si plan ACTIVE existe).
   */
  @Cron('0 3 * * *')
  async archiveOldPlans() {
    try {
      const today = startOfDay(new Date());

      const expired = await this.prisma.schedulePlan.findMany({
        where: {
          status: SchedulePlanStatus.CONFIRMED,
          period_end: { lt: today },
        },
        select: { id: true },
      });

      for (const plan of expired) {
        try {
          await this.planningService.archivePlan(plan.id);
        } catch (err) {
          this.logger.error(
            `archiveOldPlans échec pour plan ${plan.id.slice(0, 8)}: ${(err as Error).message}`,
          );
        }
      }

      if (expired.length > 0) {
        this.logger.log(`archiveOldPlans : ${expired.length} plan(s) archivé(s)`);
      }
    } catch (err) {
      this.logger.error(`Erreur cron archiveOldPlans: ${(err as Error).message}`);
    }
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private async fetchPlanDelivererIds(planId: string): Promise<string[]> {
    const assignments = await this.prisma.shiftAssignment.findMany({
      where: { shift: { plan_id: planId } },
      select: { deliverer_id: true },
      distinct: ['deliverer_id'],
    });
    return assignments.map((a) => a.deliverer_id);
  }

  private async findTodayShiftType(
    delivererId: string,
    today: Date,
  ): Promise<ShiftType | null> {
    const assignment = await this.prisma.shiftAssignment.findFirst({
      where: {
        deliverer_id: delivererId,
        shift: { date: today },
      },
      include: { shift: { select: { type: true } } },
      orderBy: { shift: { type: 'asc' } },
    });
    return assignment?.shift.type ?? null;
  }
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}
