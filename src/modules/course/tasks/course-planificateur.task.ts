import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { CoursePlanificateurService } from '../services/course-planificateur.service';
import { EstimationPreparationService } from '../services/estimation-preparation.service';

/**
 * Tâches du planificateur v2.
 *
 *  - `passer` : un passage sur chaque restaurant actif, toutes les
 *    `course.planificateur_tache_s` secondes (10 par défaut, entre 5 et 300) :
 *    échéances des retenues et de la fenêtre après retrait, Turbo, offres en
 *    attente, et commandes prêtes arrivées sans événement (HubRise, échec du
 *    pont). La tâche tourne toutes les 5 s et saute son tour tant que la
 *    cadence réglée n'est pas écoulée.
 *  - `recalculerPreparations` : statistique de préparation de chaque
 *    restaurant (14 jours, par tranche horaire), toutes les heures, gardée
 *    dans Redis.
 */
@Injectable()
export class CoursePlanificateurTask {
  private readonly logger = new Logger(CoursePlanificateurTask.name);
  private dernierPassage = 0;
  private enCours = false;

  constructor(
    private readonly planificateur: CoursePlanificateurService,
    private readonly settings: CourseSettingsHelper,
    private readonly preparation: EstimationPreparationService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async passer(maintenant = new Date()) {
    if (this.enCours) return;
    try {
      const { planification } = await this.settings.lirePlanification();
      const intervalleMs = planification.reglages.intervalleTacheS * 1000;
      // Une seconde de tolérance : la tâche de 5 s ne glisse pas d'un tour.
      if (maintenant.getTime() - this.dernierPassage < intervalleMs - 1000) return;
      this.dernierPassage = maintenant.getTime();
      this.enCours = true;
      await this.planificateur.passerTout(maintenant);
    } catch (err) {
      this.logger.error(`Tâche du planificateur en échec : ${(err as Error)?.message ?? err}`);
    } finally {
      this.enCours = false;
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async recalculerPreparations() {
    try {
      const n = await this.preparation.recalculerTout();
      if (n > 0) this.logger.log(`Statistique de préparation recalculée pour ${n} restaurant(s).`);
    } catch (err) {
      this.logger.error(`Statistique de préparation non recalculée : ${(err as Error)?.message ?? err}`);
    }
  }
}
