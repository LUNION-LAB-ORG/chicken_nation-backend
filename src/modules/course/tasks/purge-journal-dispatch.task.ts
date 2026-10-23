import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from 'src/database/services/prisma.service';

/** Conservation par défaut du journal de la diffusion (conception 3.13). */
export const CONSERVATION_JOURNAL_DISPATCH_JOURS = 90;

/**
 * Jours de conservation lus dans `DISPATCH_JOURNAL_RETENTION_DAYS` : défaut
 * 90, 0 = jamais de purge ; une valeur illisible garde le défaut.
 */
export function joursDeConservation(brut: string | undefined): number {
  if (brut === undefined || brut.trim() === '') return CONSERVATION_JOURNAL_DISPATCH_JOURS;
  const n = Number(brut.trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : CONSERVATION_JOURNAL_DISPATCH_JOURS;
}

/**
 * PURGE QUOTIDIENNE DU JOURNAL DE LA DIFFUSION (`DispatchEvenement`) au-delà
 * de la conservation prévue (90 jours). Sans elle, la table et ses cinq index
 * grossissaient sans limite (environ six lignes par commande livrée sous le
 * planificateur v2).
 *
 * Comme la purge des journaux d'audit : sans risque à deux serveurs (la
 * suppression `created_at < limite` est idempotente) ; le second peut la
 * couper par `DISABLE_DISPATCH_JOURNAL_PURGE=true`.
 */
@Injectable()
export class PurgeJournalDispatchTask {
  private readonly logger = new Logger(PurgeJournalDispatchTask.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purger(maintenant: Date = new Date()): Promise<number> {
    if (process.env.DISABLE_DISPATCH_JOURNAL_PURGE === 'true') return 0;
    const jours = joursDeConservation(process.env.DISPATCH_JOURNAL_RETENTION_DAYS);
    if (jours <= 0) return 0;
    try {
      const limite = new Date(maintenant.getTime() - jours * 24 * 60 * 60 * 1000);
      const { count } = await this.prisma.dispatchEvenement.deleteMany({ where: { created_at: { lt: limite } } });
      if (count > 0) this.logger.log(`Journal de la diffusion : ${count} ligne(s) purgée(s) (plus de ${jours} j).`);
      return count;
    } catch (err) {
      this.logger.warn(`Purge du journal de la diffusion échouée : ${(err as Error)?.message ?? err}`);
      return 0;
    }
  }
}
