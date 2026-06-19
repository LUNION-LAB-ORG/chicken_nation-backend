import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StatisticsClientsService } from '../services/statistics-clients.service';
import { ClientsStatsQueryDto } from '../dto/clients-stats.dto';

/**
 * Préchauffage du cache des statistiques clients.
 *
 * La page « Statistiques > Clients » est lourde (agrégations sur la table Order).
 * Sans préchauffage, le 1er accès après expiration du cache (TTL 5 min) paie le
 * coût complet des agrégations. Ce cron recalcule en tâche de fond la vue par
 * DÉFAUT (globale, période « mois » — identique à DEFAULT_STATS_FILTERS côté
 * front) → les utilisateurs tombent toujours sur un cache chaud.
 *
 * Cadence 4 min (< TTL 5 min) pour rafraîchir AVANT expiration : jamais de trou.
 *
 * Gating double-backend : désactivable via DISABLE_STATS_WARM_CRON=true sur le
 * backend secondaire (le préchauffage est idempotent, mais inutile en double).
 */
@Injectable()
export class StatisticsWarmupTask {
  private readonly logger = new Logger(StatisticsWarmupTask.name);

  constructor(private readonly clientsService: StatisticsClientsService) {}

  @Cron('*/4 * * * *')
  async warmClientsDashboard() {
    if (process.env.DISABLE_STATS_WARM_CRON === 'true') return;

    const defaultQuery = { period: 'month' } as ClientsStatsQueryDto;
    try {
      const start = Date.now();
      await this.clientsService.getClientsDashboard(defaultQuery, true);
      this.logger.log(
        `Cache dashboard clients préchauffé (période=month) en ${Date.now() - start}ms`,
      );
    } catch (e) {
      this.logger.warn(
        `Préchauffage dashboard clients échoué: ${(e as Error)?.message}`,
      );
    }
  }
}
