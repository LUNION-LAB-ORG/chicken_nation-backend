import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CourseStatut,
  SchedulePlan,
  SchedulePlanStatus,
  ShiftAssignmentStatus,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

interface IListPlansFilters {
  restaurantId?: string;
  status?: SchedulePlanStatus;
}

/**
 * Service de lecture du module schedule.
 *
 * Sépare les requêtes de liste/détail des actions (generate/send/confirm) pour
 * une meilleure clarté des responsabilités.
 */
@Injectable()
export class ScheduleQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Liste paginée des plans avec filtres optionnels (admin). */
  async listPlans(filters: IListPlansFilters = {}, limit = 50): Promise<SchedulePlan[]> {
    return this.prisma.schedulePlan.findMany({
      where: {
        restaurant_id: filters.restaurantId,
        status: filters.status,
      },
      orderBy: { period_start: 'desc' },
      take: limit,
    });
  }

  /** Détail d'un plan avec ses shifts + assignments + livreurs. */
  async getPlanDetail(planId: string) {
    const plan = await this.prisma.schedulePlan.findUnique({
      where: { id: planId },
      include: {
        shifts: {
          orderBy: [{ date: 'asc' }, { type: 'asc' }],
          include: {
            assignments: {
              include: {
                deliverer: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    phone: true,
                    image: true,
                    type_vehicule: true,
                  },
                },
              },
            },
          },
        },
        restaurant: {
          select: { id: true, name: true, address: true },
        },
      },
    });
    if (!plan) throw new NotFoundException(`Plan ${planId} introuvable`);
    return plan;
  }

  /**
   * Vue planning pour UN livreur — agrège ses shifts confirmables/confirmés
   * et ses jours de repos sur tous les plans actifs (SENT/CONFIRMED).
   *
   * Conçu pour l'écran calendrier mobile du livreur :
   *   - Une ligne par jour (matin/soir badges)
   *   - Surlignement spécial des jours de repos
   *   - Tap sur un jour → détail + actions accept/refuse
   */
  async getDelivererSchedule(
    delivererId: string,
    fromDate: Date,
    toDate: Date,
    /**
     * Si `true`, inclut aussi pour chaque date de la période :
     *   - la réponse au check-in matinal (DailyPresenceCheck)
     *   - le nombre de courses COMPLETED par le livreur ce jour-là
     * Coûte 2 queries DB supplémentaires — utile pour l'historique mais
     * inutile pour le planning courant (qui n'a pas besoin de l'activité passée).
     */
    includePresenceData = false,
  ) {
    // Promises typées séparément (évite le cast hétérogène d'un tableau Promise<unknown>[])
    const [assignments, restDays, presenceChecks, completedCourses] = await Promise.all([
      this.prisma.shiftAssignment.findMany({
        where: {
          deliverer_id: delivererId,
          shift: { date: { gte: fromDate, lte: toDate } },
          shift_id: { not: undefined },
        },
        include: {
          shift: {
            include: {
              plan: {
                select: { id: true, status: true, period_start: true, period_end: true },
              },
            },
          },
        },
        orderBy: [{ shift: { date: 'asc' } }, { shift: { type: 'asc' } }],
      }),
      this.prisma.restDay.findMany({
        where: {
          deliverer_id: delivererId,
          date: { gte: fromDate, lte: toDate },
        },
        orderBy: { date: 'asc' },
      }),
      // Check-ins matinaux — fetché uniquement si demandé
      includePresenceData
        ? this.prisma.dailyPresenceCheck.findMany({
            where: {
              deliverer_id: delivererId,
              date: { gte: fromDate, lte: toDate },
            },
            select: { date: true, response: true, responded_at: true },
          })
        : Promise.resolve([] as { date: Date; response: string; responded_at: Date | null }[]),
      // Courses COMPLETED — fetché uniquement si demandé (group par jour côté JS)
      includePresenceData
        ? this.prisma.course.findMany({
            where: {
              deliverer_id: delivererId,
              statut: CourseStatut.COMPLETED,
              completed_at: { gte: fromDate, lte: this.endOfDay(toDate) },
            },
            select: { completed_at: true },
          })
        : Promise.resolve([] as { completed_at: Date | null }[]),
    ]);

    // Map "YYYY-MM-DD" → check / count, calculé une fois pour le mapping.
    const presenceByDate = new Map<string, { response: string; respondedAt: string | null }>();
    for (const c of presenceChecks) {
      presenceByDate.set(c.date.toISOString().substring(0, 10), {
        response: c.response,
        respondedAt: c.responded_at?.toISOString() ?? null,
      });
    }

    const courseCountByDate = new Map<string, number>();
    for (const c of completedCourses) {
      if (!c.completed_at) continue;
      const key = c.completed_at.toISOString().substring(0, 10);
      courseCountByDate.set(key, (courseCountByDate.get(key) ?? 0) + 1);
    }

    return {
      delivererId,
      fromDate: fromDate.toISOString().substring(0, 10),
      toDate: toDate.toISOString().substring(0, 10),
      assignments: assignments.map((a) => ({
        id: a.id,
        status: a.status,
        confirmedAt: a.confirmed_at?.toISOString() ?? null,
        refusedAt: a.refused_at?.toISOString() ?? null,
        refusalReason: a.refusal_reason,
        shift: {
          id: a.shift.id,
          date: a.shift.date.toISOString().substring(0, 10),
          type: a.shift.type,
          startTime: a.shift.start_time,
          endTime: a.shift.end_time,
          maxSlots: a.shift.max_slots,
          plan: a.shift.plan,
        },
      })),
      restDays: restDays.map((r) => ({
        id: r.id,
        date: r.date.toISOString().substring(0, 10),
        source: r.source,
        reason: r.reason,
      })),
      // Présent uniquement si `includePresenceData=true` — array de date+données
      // par jour pour permettre au mobile de croiser avec les assignments.
      presenceByDate: includePresenceData
        ? Array.from(presenceByDate.entries()).map(([date, info]) => ({
            date,
            response: info.response,
            respondedAt: info.respondedAt,
            completedCoursesCount: courseCountByDate.get(date) ?? 0,
          }))
        : undefined,
    };
  }

  /** Helper : end of UTC day pour les filtres `lte`. */
  private endOfDay(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(23, 59, 59, 999);
    return out;
  }

  /** Compte les confirmations d'un plan en temps réel (sans toucher au snapshot). */
  async countConfirmations(planId: string): Promise<{ confirmed: number; refused: number; pending: number }> {
    const stats = await this.prisma.shiftAssignment.groupBy({
      by: ['status'],
      where: { shift: { plan_id: planId } },
      _count: { _all: true },
    });
    const map = new Map(stats.map((s) => [s.status, s._count._all]));
    return {
      confirmed: map.get(ShiftAssignmentStatus.CONFIRMED) ?? 0,
      refused: map.get(ShiftAssignmentStatus.REFUSED) ?? 0,
      pending: map.get(ShiftAssignmentStatus.ASSIGNED) ?? 0,
    };
  }
}
