import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { CourseEvent } from '../events/course.event';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { planificateurDuRestaurant } from '../helpers/planification.rules';
import { CourseGroupingService } from '../services/course-grouping.service';
import { LotsV2Service } from '../services/lots-v2.service';

/**
 * Tâches cron du regroupement intelligent (Phase P3 + P6e).
 *
 *  - `flushMatureBatches` (10 s) : flush les batches mûrs (min_wait passé +
 *    expirés ou saturés) → crée les Courses
 *  - `rebalanceActiveCourses` (30 s default) : tente de fusionner / transférer
 *    des deliveries entre courses non encore récupérées du même restaurant
 *
 * Planificateur v2 (`course.planificateur`, v2 par défaut) : les lots de la
 * flotte interne des restaurants en v2 sont vidés aussitôt (le planificateur
 * reprend leurs commandes) et le rééquilibrage ne les touche plus (le
 * planificateur fusionne lui-même, par direction). Les lots Turbo d'origine
 * et les restaurants en v1 gardent exactement l'ancien fonctionnement.
 */
@Injectable()
export class CourseBatchTask {
  private readonly logger = new Logger(CourseBatchTask.name);

  constructor(
    private readonly groupingService: CourseGroupingService,
    private readonly settings: CourseSettingsHelper,
    private readonly lotsV2: LotsV2Service,
    private readonly courseEvent: CourseEvent,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async flushMatureBatches() {
    try {
      const planificateur = await this.settings.planificateurLu();
      const rendus = await this.lotsV2.libererLotsV2(planificateur);
      for (const restaurantId of rendus) {
        this.courseEvent.demanderPlanification({ restaurant_id: restaurantId, raison: 'LOT_VIDE' });
      }
      const count = await this.groupingService.flushMatureBatches();
      if (count > 0) {
        this.logger.log(`${count} batch(es) flushé(s) → Course(s) créée(s)`);
      }
    } catch (err) {
      this.logger.error('Erreur flush batches', err);
    }
  }

  /**
   * Re-balance toutes les 30 s les courses ajustables — peut fusionner / transférer
   * des deliveries pour optimiser après-coup. Activable / désactivable via le
   * setting `course.rebalance_enabled` (1/0). Jamais sur un restaurant en v2.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async rebalanceActiveCourses() {
    try {
      const planificateur = await this.settings.planificateurLu();
      await this.groupingService.rebalanceActiveCourses(
        (restaurantId) => planificateurDuRestaurant(planificateur, restaurantId) === 'v2',
      );
    } catch (err) {
      this.logger.error('Erreur re-balance', err);
    }
  }
}
