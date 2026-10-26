import { Injectable, NotFoundException } from '@nestjs/common';
import { CourseStatut, Prisma, UserRole } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { ComptePersonnel } from 'src/modules/users/helpers/personnel-scope.helper';

import { QueryCourseStatsDto } from '../dto/query-course-stats.dto';
import { QueryCoursesDto } from '../dto/query-courses.dto';
import {
  restaurantDuRetrait,
  retenirCourseARemettre,
  whereCourseARemettreParId,
  whereCoursesARemettre,
} from '../helpers/code-retrait.rules';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { COURSE_ADMIN_INCLUDE, COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { journeeDeService } from '../helpers/journee-service.rules';
import { planificateurDuRestaurant } from '../helpers/planification.rules';
import {
  MESSAGE_COURSE_INTROUVABLE,
  assertCourseDuRestaurant,
  refusCourseHorsRemise,
} from '../helpers/recuperation.rules';

/**
 * Détail d'une course au backoffice : le code client de chaque livraison
 * (`delivery_pin`) n'est lu que pour l'ADMIN (support : client qui a perdu
 * son code). Le suivi des livraisons (LIVRAISON_OPS) lit le reste sans lui
 * (conception du 24/10, 11.7), le call center aussi (26/10) : il lit le code
 * de retrait du client dans le tiroir de la commande (`code_client`).
 */
export function includeCoursePour(compte: { role?: UserRole | null } | null | undefined) {
  return compte?.role === UserRole.ADMIN ? COURSE_ADMIN_INCLUDE : COURSE_FULL_INCLUDE;
}

/**
 * Service : lectures Course (queries read-only).
 * Séparé pour éviter d'alourdir les services d'action.
 */
@Injectable()
export class CourseQueryService {
  constructor(
    private readonly prisma: PrismaService,
    // Restaurant repassé à l'ancienne méthode : un sac oublié n'est pas retrouvé par le code (comme avant).
    private readonly settings?: CourseSettingsHelper,
  ) {}

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
   * Course à remettre pour un code de retrait (3 chiffres) : aperçu de la
   * caisse ET validation du retrait passent par ici, ils voient donc la même
   * course.
   *
   * Cherchée dans le restaurant du compte connecté (ou celui demandé par un
   * compte du siège, ou tous), parmi les courses créées pendant la journée de
   * service en cours (code-retrait.rules.ts). Lève 404 si aucune, 409 si
   * plusieurs, 403 si un compte de restaurant demande un autre restaurant.
   */
  async findByActivePickupCode(
    pickupCode: string,
    user: ComptePersonnel | undefined,
    restaurantIdDemande?: string,
    maintenant: Date = new Date(),
  ) {
    const restaurantId = restaurantDuRetrait(user, restaurantIdDemande);
    const trouvees = await this.prisma.course.findMany({
      where: whereCoursesARemettre(pickupCode, restaurantId, journeeDeService(maintenant)),
      include: COURSE_FULL_INCLUDE,
      orderBy: [{ assigned_at: 'desc' }, { created_at: 'desc' }],
      // Au-delà d'une, on refuse : inutile de tout charger.
      take: 5,
    });
    return retenirCourseARemettre(await this.sansSacOublieEnV1(trouvees), restaurantId);
  }

  /**
   * Course à remettre désignée par son identifiant (groupe de la course à
   * l'écran Commandes, conception du 24/10, 11.1) : même règle « à remettre »
   * que la recherche par code (journée de service, sac oublié écarté en v1).
   *
   * 404 « Course introuvable. » (inconnue ou d'un autre jour), 403 si un compte
   * de restaurant désigne la course d'un autre restaurant, 409 si elle n'est
   * plus à remettre ou n'a encore personne à qui remettre.
   */
  async findARemettreParId(
    courseId: string,
    user: ComptePersonnel | undefined,
    maintenant: Date = new Date(),
  ) {
    const lue = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, restaurant_id: true, statut: true, deliverer_id: true, turbo_escalated_at: true, created_at: true },
    });
    if (!lue) throw new NotFoundException(MESSAGE_COURSE_INTROUVABLE);
    assertCourseDuRestaurant(user, lue.restaurant_id);

    const journee = journeeDeService(maintenant);
    const course = await this.prisma.course.findFirst({
      where: whereCourseARemettreParId(courseId, journee),
      include: COURSE_FULL_INCLUDE,
    });
    const [aRemettre] = course ? await this.sansSacOublieEnV1([course]) : [];
    if (!aRemettre) throw refusCourseHorsRemise(course ?? lue, journee);
    return aRemettre;
  }

  /**
   * Sac oublié (course partie, commande d'origine encore prête) : retrouvé
   * par le code seulement pour un restaurant en v2. L'ancienne méthode garde
   * exactement son comportement : le code ne retrouve pas une course partie.
   */
  private async sansSacOublieEnV1<T extends { statut: CourseStatut; parti_at: Date | null; restaurant_id: string }>(
    courses: T[],
  ): Promise<T[]> {
    if (!this.settings || !courses.some((c) => c.statut === CourseStatut.IN_DELIVERY && c.parti_at)) return courses;
    const lu = (await this.settings.lirePlanification()).planificateur;
    return courses.filter(
      (c) => !(c.statut === CourseStatut.IN_DELIVERY && c.parti_at && planificateurDuRestaurant(lu, c.restaurant_id) === 'v1'),
    );
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

  /**
   * Liste du backoffice (ADMIN, LIVRAISON_OPS, CALL_CENTER) : toutes courses avec filtres
   * complets. `compte` : le code client des livraisons n'est lu que pour l'ADMIN.
   */
  async findAllAdmin(filters: QueryCoursesDto, compte?: { role?: UserRole | null } | null) {
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
        // ADMIN seulement : code de récupération client (delivery_pin).
        include: includeCoursePour(compte),
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

  /**
   * Détail d'une Course (avec toutes Delivery + Order + restaurant + livreur).
   * `compte` : le code client des livraisons n'est lu que pour l'ADMIN.
   */
  async findOne(courseId: string, compte?: { role?: UserRole | null } | null) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: {
        // ADMIN seulement : code de récupération client (delivery_pin).
        ...includeCoursePour(compte),
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
