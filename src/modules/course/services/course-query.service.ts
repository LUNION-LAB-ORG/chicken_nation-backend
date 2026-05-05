import { Injectable, NotFoundException } from '@nestjs/common';
import { CourseStatut, EntityStatus, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { QueryCourseStatsDto } from '../dto/query-course-stats.dto';
import { QueryCoursesDto } from '../dto/query-courses.dto';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';

/**
 * Service : lectures Course (queries read-only).
 * Séparé pour éviter d'alourdir les services d'action.
 */
@Injectable()
export class CourseQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Course active du livreur connecté (ACCEPTED / AT_RESTAURANT / IN_DELIVERY) */
  async getCurrentForDeliverer(delivererId: string) {
    const active: CourseStatut[] = [
      CourseStatut.ACCEPTED,
      CourseStatut.AT_RESTAURANT,
      CourseStatut.IN_DELIVERY,
    ];
    return this.prisma.course.findFirst({
      where: { deliverer_id: delivererId, statut: { in: active } },
      include: COURSE_FULL_INCLUDE,
      orderBy: { assigned_at: 'desc' },
    });
  }

  /**
   * Recherche une course active par son code de retrait (3 chiffres).
   * `pickup_code` n'est PAS unique — s'il y a collision (statistiquement rare, 1/1000),
   * on retourne la plus récente active.
   */
  async findByActivePickupCode(pickupCode: string) {
    const active: CourseStatut[] = [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT];
    return this.prisma.course.findFirst({
      where: { pickup_code: pickupCode, statut: { in: active } },
      include: COURSE_FULL_INCLUDE,
      orderBy: { assigned_at: 'desc' },
    });
  }

  /** Historique livreur : COMPLETED + CANCELLED + EXPIRED */
  async getHistoryForDeliverer(delivererId: string, filters: QueryCoursesDto) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.CourseWhereInput = {
      deliverer_id: delivererId,
      ...(filters.statut
        ? { statut: filters.statut }
        : {
            statut: {
              in: [CourseStatut.COMPLETED, CourseStatut.CANCELLED, CourseStatut.EXPIRED],
            },
          }),
      ...(filters.startDate || filters.endDate
        ? {
            created_at: {
              ...(filters.startDate && { gte: new Date(filters.startDate) }),
              ...(filters.endDate && { lte: new Date(filters.endDate) }),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.course.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: COURSE_FULL_INCLUDE,
      }),
      this.prisma.course.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Liste admin (backoffice) : toutes courses avec filtres complets */
  async findAllAdmin(filters: QueryCoursesDto) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.CourseWhereInput = {
      ...(filters.statut && { statut: filters.statut }),
      ...(filters.restaurant_id && { restaurant_id: filters.restaurant_id }),
      ...(filters.deliverer_id && { deliverer_id: filters.deliverer_id }),
      ...(filters.search && {
        OR: [
          { reference: { contains: filters.search, mode: 'insensitive' } },
          { pickup_code: filters.search },
        ],
      }),
      ...(filters.startDate || filters.endDate
        ? {
            created_at: {
              ...(filters.startDate && { gte: new Date(filters.startDate) }),
              ...(filters.endDate && { lte: new Date(filters.endDate) }),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.course.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: COURSE_FULL_INCLUDE,
      }),
      this.prisma.course.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Stats agrégées pour la page Courses backoffice (KPI cards + charts).
   * Retourne en 1 call :
   *   - totaux par statut (ACTIVE / COMPLETED / CANCELLED / EXPIRED)
   *   - taux de succès (COMPLETED / courses terminales)
   *   - revenu livraison cumulé (sum total_delivery_fee des COMPLETED)
   *   - breakdown par jour (7 derniers jours ou période donnée)
   *   - distribution des statuts finaux (pour pie chart)
   *   - durée moyenne en minutes (assigned_at → completed_at)
   */
  async getStats(filters: QueryCourseStatsDto) {
    const endDate = filters.endDate ? new Date(filters.endDate) : new Date();
    const startDate = filters.startDate
      ? new Date(filters.startDate)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const baseWhere: Prisma.CourseWhereInput = {
      created_at: { gte: startDate, lte: endDate },
      ...(filters.restaurant_id && { restaurant_id: filters.restaurant_id }),
    };

    // Comptages par statut (parallélisés)
    const [
      total,
      active,
      completed,
      cancelled,
      expired,
      pendingAssignment,
      courses,
    ] = await Promise.all([
      this.prisma.course.count({ where: baseWhere }),
      this.prisma.course.count({
        where: {
          ...baseWhere,
          statut: { in: [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY] },
        },
      }),
      this.prisma.course.count({ where: { ...baseWhere, statut: CourseStatut.COMPLETED } }),
      this.prisma.course.count({ where: { ...baseWhere, statut: CourseStatut.CANCELLED } }),
      this.prisma.course.count({ where: { ...baseWhere, statut: CourseStatut.EXPIRED } }),
      this.prisma.course.count({ where: { ...baseWhere, statut: CourseStatut.PENDING_ASSIGNMENT } }),
      this.prisma.course.findMany({
        where: {
          ...baseWhere,
          statut: CourseStatut.COMPLETED,
        },
        select: {
          total_delivery_fee: true,
          assigned_at: true,
          completed_at: true,
          created_at: true,
        },
      }),
    ]);

    // Revenu cumulé
    const totalRevenue = courses.reduce((sum, c) => sum + c.total_delivery_fee, 0);

    // Durée moyenne (min) — assigned_at → completed_at pour les COMPLETED
    const durations = courses
      .filter((c) => c.assigned_at && c.completed_at)
      .map((c) => (c.completed_at!.getTime() - c.assigned_at!.getTime()) / 60_000);
    const avgDurationMin =
      durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;

    // Taux de succès parmi les terminales
    const terminalTotal = completed + cancelled + expired;
    const successRate = terminalTotal > 0 ? (completed / terminalTotal) * 100 : 0;

    // Breakdown journalier (7 derniers jours de la période)
    const dailyBreakdown = await this.buildDailyBreakdown(startDate, endDate, filters.restaurant_id);

    return {
      period: { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
      totals: {
        total,
        active,
        completed,
        cancelled,
        expired,
        pendingAssignment,
      },
      successRate: Math.round(successRate * 10) / 10,
      totalRevenue,
      avgDurationMin: Math.round(avgDurationMin),
      distribution: [
        { statut: 'COMPLETED', count: completed },
        { statut: 'CANCELLED', count: cancelled },
        { statut: 'EXPIRED', count: expired },
      ],
      dailyBreakdown,
    };
  }

  /** Groupe par jour les courses créées sur la période (retourne jusqu'à 30 entries). */
  private async buildDailyBreakdown(
    startDate: Date,
    endDate: Date,
    restaurantId?: string,
  ): Promise<{ date: string; total: number; completed: number; cancelled: number }[]> {
    const days = Math.min(30, Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)));
    const startFloor = new Date(endDate);
    startFloor.setHours(0, 0, 0, 0);
    startFloor.setDate(startFloor.getDate() - (days - 1));

    const courses = await this.prisma.course.findMany({
      where: {
        created_at: { gte: startFloor, lte: endDate },
        ...(restaurantId && { restaurant_id: restaurantId }),
      },
      select: { created_at: true, statut: true },
    });

    // Init buckets
    const buckets = new Map<string, { total: number; completed: number; cancelled: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(startFloor);
      d.setDate(d.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), { total: 0, completed: 0, cancelled: 0 });
    }

    for (const c of courses) {
      const key = c.created_at.toISOString().slice(0, 10);
      const b = buckets.get(key);
      if (!b) continue;
      b.total++;
      if (c.statut === CourseStatut.COMPLETED) b.completed++;
      if (c.statut === CourseStatut.CANCELLED || c.statut === CourseStatut.EXPIRED) b.cancelled++;
    }

    return Array.from(buckets.entries()).map(([date, v]) => ({ date, ...v }));
  }

  /** Détail d'une Course (avec toutes Delivery + Order + restaurant + livreur) */
  async findOne(courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: {
        ...COURSE_FULL_INCLUDE,
        offer_attempts: {
          orderBy: { offered_at: 'desc' },
          include: {
            deliverer: {
              select: { id: true, reference: true, first_name: true, last_name: true, phone: true },
            },
          },
        },
      },
    });
    if (!course) throw new NotFoundException('Course non trouvée');
    return course;
  }
}
