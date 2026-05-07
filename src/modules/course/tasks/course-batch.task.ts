import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { CourseGroupingService } from '../services/course-grouping.service';

/**
 * Tâches cron du regroupement intelligent (Phase P3 + P6e).
 *
 *  - `flushMatureBatches` (10 s) : flush les batches mûrs (min_wait passé +
 *    expirés ou saturés) → crée les Courses
 *  - `rebalanceActiveCourses` (30 s default) : tente de fusionner / transférer
 *    des deliveries entre courses non encore récupérées du même restaurant
 */
@Injectable()
export class CourseBatchTask {
  private readonly logger = new Logger(CourseBatchTask.name);

  constructor(private readonly groupingService: CourseGroupingService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async flushMatureBatches() {
    try {
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
   * setting `course.rebalance_enabled` (1/0).
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async rebalanceActiveCourses() {
    try {
      await this.groupingService.rebalanceActiveCourses();
    } catch (err) {
      this.logger.error('Erreur re-balance', err);
    }
  }
}
