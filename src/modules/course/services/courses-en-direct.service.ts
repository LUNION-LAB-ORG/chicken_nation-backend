import { Injectable } from '@nestjs/common';
import { CourseOfferStatus, CourseStatut, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { CoursesEnDirect, construireCoursesEnDirect } from '../helpers/courses-en-direct.rules';
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
  estimated_duration_min: true,
  delay_alerted_at: true,
  retenue_jusqua: true,
  total_delivery_fee: true,
  deliveries: {
    select: {
      statut: true,
      // Détail déplié sur la carte (11/11) : montant et client.
      order: {
        select: {
          id: true,
          reference: true,
          status: true,
          entity_status: true,
          amount: true,
          fullname: true,
          customer: { select: { first_name: true, last_name: true } },
        },
      },
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
 * Pas terminées, créées depuis 5 h ce matin (les plus anciennes sont au
 * tableau de la livraison, « Les fermer ») ; « Aucun livreur trouvé » du jour
 * gardées si une commande attend encore. Les terminées : l'historique.
 */
@Injectable()
export class CoursesEnDirectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reglages: CourseSettingsHelper,
  ) {}

  async lire(restaurantId: string | undefined, maintenant: Date = new Date()): Promise<CoursesEnDirect> {
    const journee = journeeDeService(maintenant);
    const [reglages, enCours] = await Promise.all([
      this.reglages.load(),
      this.prisma.course.findMany({
        where: {
          ...(restaurantId ? { restaurant_id: restaurantId } : {}),
          created_at: { gte: journee.debut },
          statut: { in: [...STATUTS_COURSE_NON_TERMINEE, CourseStatut.EXPIRED] },
        },
        select: SELECT_COURSE_EN_DIRECT,
      }),
    ]);
    return construireCoursesEnDirect({ maintenant, facteurRetard: reglages.delayAlertFactor, courses: enCours });
  }
}
