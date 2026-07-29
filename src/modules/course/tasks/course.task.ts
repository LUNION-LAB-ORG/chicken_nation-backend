import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CourseStatut } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';

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
    // Alerte staff sur les livraisons qui dérapent.
    private readonly notificationsSender: NotificationsSenderService,
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

  /**
   * Relance l'OFFRE en cours auprès du livreur (30 s et 60 s après l'envoi).
   * Une seule notification lui laisse une seule chance de la voir : distrait à
   * cet instant, il perd une course qu'il aurait acceptée.
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async remindPendingOffers() {
    try {
      const count = await this.courseOfferService.remindPendingOffers();
      if (count > 0) {
        this.logger.debug(`Cron : ${count} relance(s) d'offre envoyée(s)`);
      }
    } catch (err) {
      this.logger.error(`Erreur cron remindPendingOffers: ${(err as Error).message}`);
    }
  }

  /**
   * Relance les courses restées SANS livreur (aucun candidat au moment de la
   * création). Re-cherche un livreur, alerte le staff après le délai configuré,
   * et n'expire qu'au-delà du plafond d'attente. Sans ce cron, une commande
   * prête pouvait rester invisible indéfiniment.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async retryUnassignedCourses() {
    try {
      const count = await this.courseOfferService.retryUnassignedCourses();
      if (count > 0) {
        this.logger.debug(`Cron : ${count} course(s) sans livreur relancée(s)`);
      }
    } catch (err) {
      this.logger.error(`Erreur cron retryUnassignedCourses: ${(err as Error).message}`);
    }
  }

  /**
   * Détecte les tournées qui DÉPASSENT nettement leur durée estimée.
   * Sans cela, un retard n'est visible que lorsque le client réclame.
   * Alerte émise UNE SEULE FOIS par course (claim atomique, 2 backends).
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async detecterRetards() {
    try {
      const { delayAlertFactor } = await this.settings.load();
      const now = new Date();

      const enCours = await this.prisma.course.findMany({
        where: {
          statut: CourseStatut.IN_DELIVERY,
          delay_alerted_at: null,
          picked_up_at: { not: null },
          estimated_duration_min: { not: null },
        },
        select: {
          id: true,
          reference: true,
          restaurant_id: true,
          picked_up_at: true,
          estimated_duration_min: true,
        },
        take: 100,
      });

      for (const c of enCours) {
        const ecouleMin = (now.getTime() - c.picked_up_at!.getTime()) / 60000;
        const seuil = c.estimated_duration_min! * delayAlertFactor;
        if (ecouleMin < seuil) continue;

        // Claim atomique : une seule alerte, même avec deux backends.
        const claim = await this.prisma.course.updateMany({
          where: { id: c.id, delay_alerted_at: null },
          data: { delay_alerted_at: now },
        });
        if (claim.count !== 1) continue;

        this.logger.warn(
          `Course ${c.reference} en retard : ${Math.round(ecouleMin)} min pour ${c.estimated_duration_min} min estimées.`,
        );
        void this.notificationsSender
          .sendCourseDelayBell({
            reference: c.reference,
            restaurantId: c.restaurant_id,
            estimeMin: c.estimated_duration_min!,
            ecouleMin: Math.round(ecouleMin),
          })
          .catch(() => undefined);
      }
    } catch (err) {
      this.logger.error(`Erreur cron detecterRetards: ${(err as Error).message}`);
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
