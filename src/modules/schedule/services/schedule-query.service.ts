import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CourseStatut,
  EntityStatus,
  SchedulePlan,
  SchedulePlanStatus,
  ShiftAssignmentStatus,
  User,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { resolveRestaurantScope } from 'src/modules/order/helpers/restaurant-scope.helper';

import { lireMembresDuPlanning } from '../helpers/membres-planning';
import {
  debutDuJour,
  MESSAGE_PLANNING_INTROUVABLE,
  planningsDuRestaurant,
  verifierPlanningDuRestaurant,
} from '../helpers/planning.rules';
import { ScheduleSettingsHelper } from '../helpers/schedule-settings.helper';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ScheduleSettingsHelper,
  ) {}

  /**
   * Liste des plans avec filtres optionnels. Avec un compte connecté, un
   * compte de restaurant ne voit que les plannings du sien, quel que soit le
   * `restaurantId` reçu.
   */
  async listPlans(filters: IListPlansFilters = {}, limit = 50, user?: User): Promise<SchedulePlan[]> {
    const restaurantId = user ? resolveRestaurantScope(user, filters.restaurantId) : filters.restaurantId;
    return this.prisma.schedulePlan.findMany({
      where: {
        restaurant_id: restaurantId,
        status: filters.status,
      },
      orderBy: { period_start: 'desc' },
      take: limit,
    });
  }

  /**
   * Cloisonnement d'une route `:id` : le planning existe (sinon 404) et, pour
   * un compte de restaurant, c'est celui de son restaurant (sinon 403).
   */
  async lirePlanAccessible(planId: string, user: User | undefined): Promise<{ id: string; restaurant_id: string }> {
    const plan = await this.prisma.schedulePlan.findUnique({
      where: { id: planId },
      select: { id: true, restaurant_id: true },
    });
    if (!plan) throw new NotFoundException(MESSAGE_PLANNING_INTROUVABLE);
    verifierPlanningDuRestaurant(user, plan.restaurant_id);
    return plan;
  }

  /**
   * Détail d'un plan avec ses shifts + assignments + livreurs.
   *
   * Complété le 24/10 (les champs d'avant restent) :
   * - `livreurs` : tous les livreurs du planning, même ceux qui n'ont que des
   *   repos, triés par prénom ;
   * - `repos` : leurs jours de repos dans la période, avec leur origine ;
   * - `regles.jours_sans_repos` : les jours où le repos est interdit.
   */
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
    if (!plan) throw new NotFoundException(MESSAGE_PLANNING_INTROUVABLE);

    const membres = await lireMembresDuPlanning(this.prisma, plan);
    const [livreurs, repos, settings] = await Promise.all([
      this.prisma.deliverer.findMany({
        where: { id: { in: membres } },
        select: { id: true, first_name: true, last_name: true, image: true },
      }),
      this.prisma.restDay.findMany({
        where: {
          deliverer_id: { in: membres },
          date: { gte: plan.period_start, lte: plan.period_end },
        },
        select: { deliverer_id: true, date: true, source: true },
        orderBy: [{ date: 'asc' }],
      }),
      this.settings.load(),
    ]);

    const parPrenom = (a: { first_name: string | null; last_name: string | null }, b: typeof a) =>
      (a.first_name ?? '').localeCompare(b.first_name ?? '', 'fr') ||
      (a.last_name ?? '').localeCompare(b.last_name ?? '', 'fr');

    return {
      ...plan,
      livreurs: [...livreurs].sort(parPrenom),
      repos,
      regles: { jours_sans_repos: settings.noRestDays },
    };
  }

  /**
   * Aperçu des plannings par restaurant (tableau du siège, 24/10) : planning
   * en cours avec ses réponses, planning suivant, livreurs prévus aujourd'hui.
   * Un compte de restaurant ne reçoit que la ligne du sien.
   */
  async apercu(user: User | undefined, restaurantId?: string, maintenant = new Date()) {
    const perimetre = resolveRestaurantScope(user, restaurantId);
    const aujourdhui = debutDuJour(maintenant);

    const restaurants = await this.prisma.restaurant.findMany({
      where: { entity_status: EntityStatus.ACTIVE, ...(perimetre ? { id: perimetre } : {}) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (restaurants.length === 0) return [];

    const plannings = await this.prisma.schedulePlan.findMany({
      where: {
        restaurant_id: { in: restaurants.map((r) => r.id) },
        status: { not: SchedulePlanStatus.ARCHIVED },
        period_end: { gte: aujourdhui },
      },
      select: { id: true, restaurant_id: true, status: true, period_start: true, period_end: true },
    });

    const parRestaurant = restaurants.map((r) => ({
      restaurant: r,
      ...planningsDuRestaurant(
        plannings.filter((p) => p.restaurant_id === r.id),
        aujourdhui,
      ),
    }));

    const enCoursIds = parRestaurant.flatMap((l) => (l.en_cours ? [l.en_cours.id] : []));
    const [reponses, prevus] = await Promise.all([
      Promise.all(enCoursIds.map((id) => this.countConfirmations(id))),
      enCoursIds.length > 0
        ? this.prisma.shiftAssignment.findMany({
            where: {
              shift: { plan_id: { in: enCoursIds }, date: aujourdhui },
              status: { not: ShiftAssignmentStatus.REFUSED },
            },
            select: { deliverer_id: true, shift: { select: { plan_id: true } } },
          })
        : Promise.resolve([] as { deliverer_id: string; shift: { plan_id: string } }[]),
    ]);
    const reponsesParPlanning = new Map(enCoursIds.map((id, i) => [id, reponses[i]]));

    return parRestaurant.map(({ restaurant, en_cours, suivant }) => {
      const stats = en_cours ? reponsesParPlanning.get(en_cours.id) : undefined;
      return {
        restaurant: { id: restaurant.id, nom: restaurant.name },
        en_cours: en_cours
          ? {
              id: en_cours.id,
              statut: en_cours.status,
              debut: en_cours.period_start,
              fin: en_cours.period_end,
              reponses: {
                confirmees: stats?.confirmed ?? 0,
                en_attente: stats?.pending ?? 0,
                refusees: stats?.refused ?? 0,
              },
            }
          : null,
        suivant: suivant
          ? { id: suivant.id, statut: suivant.status, debut: suivant.period_start, fin: suivant.period_end }
          : null,
        prevus_aujourdhui: en_cours
          ? new Set(prevus.filter((a) => a.shift.plan_id === en_cours.id).map((a) => a.deliverer_id)).size
          : 0,
      };
    });
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
          shift: {
            date: { gte: fromDate, lte: toDate },
            // Seuls les plans envoyés ou confirmés sont visibles par le livreur.
            // Les DRAFT restent invisibles tant que l'admin n'a pas publié.
            plan: { status: { in: [SchedulePlanStatus.SENT, SchedulePlanStatus.CONFIRMED] } },
          },
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
