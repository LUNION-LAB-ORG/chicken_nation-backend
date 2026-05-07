import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CourseStatut } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { CourseActionService } from '../services/course-action.service';
import { CourseOfferService } from '../services/course-offer.service';

/**
 * Tâches cron du module course.
 *
 * - `expireOffers` (10s) : expire les offers PENDING dont `expires_at` est dépassé
 * - `autoCancelStuckCourses` (5min) : annule les courses bloquées :
 *     - `ACCEPTED` depuis > `auto_cancel_after_min` min → livreur n'est jamais arrivé au resto
 *     - `AT_RESTAURANT` depuis > `auto_cancel_after_min` min → caissière n'a jamais validé le pickup
 *   Protège contre les "courses zombies" qui immobilisent un livreur.
 */
@Injectable()
export class CourseTask {
  private readonly logger = new Logger(CourseTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseOfferService: CourseOfferService,
    private readonly courseActionService: CourseActionService,
    private readonly settings: CourseSettingsHelper,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async expireOffers() {
    try {
      const count = await this.courseOfferService.expirePendingOffers();
      if (count > 0) {
        this.logger.debug(`Cron : ${count} offer(s) expirée(s)`);
      }
    } catch (err) {
      this.logger.error(`Erreur cron expireOffers: ${(err as Error).message}`);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async autoCancelStuckCourses() {
    try {
      const { autoCancelAcceptedAfterMin, autoCancelAtRestaurantAfterMin } = await this.settings.load();
      const acceptedThreshold = new Date(Date.now() - autoCancelAcceptedAfterMin * 60 * 1000);
      const atRestaurantThreshold = new Date(Date.now() - autoCancelAtRestaurantAfterMin * 60 * 1000);

      const stuck = await this.prisma.course.findMany({
        where: {
          OR: [
            // ACCEPTED depuis trop longtemps → livreur n'est jamais arrivé
            { statut: CourseStatut.ACCEPTED, assigned_at: { lt: acceptedThreshold } },
            // AT_RESTAURANT depuis trop longtemps → caissière n'a jamais validé le pickup
            {
              statut: CourseStatut.AT_RESTAURANT,
              at_restaurant_at: { lt: atRestaurantThreshold },
            },
          ],
        },
        select: { id: true, reference: true, statut: true },
      });

      for (const course of stuck) {
        try {
          const reasonByStatut: Record<string, string> = {
            ACCEPTED: `Livreur non arrivé au restaurant depuis ${autoCancelAcceptedAfterMin} min`,
            AT_RESTAURANT: `Caissière n'a pas validé la récupération depuis ${autoCancelAtRestaurantAfterMin} min`,
          };
          await this.courseActionService.cancelCourse(course.id, 'system', {
            reason: `Annulation automatique : ${reasonByStatut[course.statut] ?? 'bloquée trop longtemps'}`,
          });
          this.logger.warn(
            `Course ${course.reference} auto-annulée (bloquée en ${course.statut})`,
          );
        } catch (err) {
          this.logger.error(`Échec auto-cancel ${course.reference}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Erreur cron autoCancelStuckCourses: ${(err as Error).message}`);
    }
  }
}
