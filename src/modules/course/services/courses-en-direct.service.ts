import { Injectable } from '@nestjs/common';
import { CourseOfferStatus, CourseStatut, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import {
  CoursesEnDirect,
  TERMINEES_MONTREES_MAX,
  construireCoursesEnDirect,
} from '../helpers/courses-en-direct.rules';
import { journeeDeService } from '../helpers/journee-service.rules';
import { STATUTS_COURSE_NON_TERMINEE } from '../helpers/tableau-livraison.rules';

const SELECT_COURSE_EN_DIRECT = {
  id: true,
  reference: true,
  pickup_code: true,
  statut: true,
  restaurant: { select: { id: true, name: true } },
  deliverer: { select: { id: true, first_name: true, last_name: true, phone: true } },
  turbo_escalated_at: true,
  created_at: true,
  assigned_at: true,
  at_restaurant_at: true,
  picked_up_at: true,
  parti_at: true,
  motif_depart: true,
  completed_at: true,
  estimated_duration_min: true,
  delay_alerted_at: true,
  retenue_jusqua: true,
  total_delivery_fee: true,
  deliveries: {
    select: {
      statut: true,
      order: { select: { reference: true, status: true, entity_status: true } },
    },
    orderBy: { sequence_order: 'asc' },
  },
  offer_attempts: {
    where: { status: CourseOfferStatus.PENDING },
    select: { deliverer: { select: { first_name: true } } },
    orderBy: { offered_at: 'desc' },
    take: 1,
  },
} satisfies Prisma.CourseSelect;

/**
 * Courses « En direct » (kanban de l'écran Courses, demande du 10/11) :
 * lectures de la journée de service, calcul dans `courses-en-direct.rules.ts`.
 *
 *  - pas terminées, créées depuis 5 h ce matin (les plus anciennes sont au
 *    tableau de la livraison, « Les fermer ») ;
 *  - « Aucun livreur trouvé » du jour (gardées si une commande attend encore) ;
 *  - terminées du jour : les 30 plus récentes, et leur nombre.
 */
@Injectable()
export class CoursesEnDirectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reglages: CourseSettingsHelper,
  ) {}

  async lire(restaurantId: string | undefined, maintenant: Date = new Date()): Promise<CoursesEnDirect> {
    const journee = journeeDeService(maintenant);
    const duRestaurant = restaurantId ? { restaurant_id: restaurantId } : {};
    const terminees: Prisma.CourseWhereInput = {
      ...duRestaurant,
      statut: CourseStatut.COMPLETED,
      completed_at: { gte: journee.debut },
    };
    const [reglages, enCours, dernieres, termineesTotal] = await Promise.all([
      this.reglages.load(),
      this.prisma.course.findMany({
        where: {
          ...duRestaurant,
          created_at: { gte: journee.debut },
          statut: { in: [...STATUTS_COURSE_NON_TERMINEE, CourseStatut.EXPIRED] },
        },
        select: SELECT_COURSE_EN_DIRECT,
      }),
      this.prisma.course.findMany({
        where: terminees,
        select: SELECT_COURSE_EN_DIRECT,
        orderBy: { completed_at: 'desc' },
        take: TERMINEES_MONTREES_MAX,
      }),
      this.prisma.course.count({ where: terminees }),
    ]);
    return construireCoursesEnDirect({
      maintenant,
      facteurRetard: reglages.delayAlertFactor,
      courses: [...enCours, ...dernieres],
      termineesTotal,
    });
  }
}
