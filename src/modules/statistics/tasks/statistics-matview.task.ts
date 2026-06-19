import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';

/**
 * Rafraîchit les vues matérialisées des statistiques.
 *
 * Une vue matérialisée stocke un résultat pré-calculé : les lectures sont
 * instantanées mais les données sont FIGÉES jusqu'au prochain REFRESH. Ce cron
 * les recalcule en tâche de fond toutes les 15 min (fraîcheur suffisante pour
 * des stats).
 *
 * `CONCURRENTLY` : le refresh ne bloque PAS les lectures pendant le recalcul
 * (exige l'index UNIQUE défini dans la migration de la vue). Si la vue n'est pas
 * encore peuplée (cas anormal), CONCURRENTLY échoue → on retombe sur un refresh
 * classique.
 *
 * Gating double-backend : désactivable via DISABLE_STATS_MATVIEW_CRON=true sur le
 * backend secondaire (le refresh est idempotent, mais inutile en double).
 */
@Injectable()
export class StatisticsMatviewTask {
  private readonly logger = new Logger(StatisticsMatviewTask.name);

  private readonly views = ['mv_customer_revenue_daily'];

  constructor(private readonly prisma: PrismaService) {}

  @Cron('*/15 * * * *')
  async refreshViews() {
    if (process.env.DISABLE_STATS_MATVIEW_CRON === 'true') return;

    for (const view of this.views) {
      try {
        const start = Date.now();
        try {
          await this.prisma.$executeRawUnsafe(
            `REFRESH MATERIALIZED VIEW CONCURRENTLY "${view}"`,
          );
        } catch {
          // 1er refresh / vue non peuplée → repli sur un refresh bloquant.
          await this.prisma.$executeRawUnsafe(
            `REFRESH MATERIALIZED VIEW "${view}"`,
          );
        }
        this.logger.log(`Vue ${view} rafraîchie en ${Date.now() - start}ms`);
      } catch (e) {
        this.logger.warn(`Refresh ${view} échoué: ${(e as Error)?.message}`);
      }
    }
  }
}
