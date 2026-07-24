import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditService } from './audit.service';

/**
 * Purge quotidienne des logs d'audit au-delà de la rétention.
 *
 * Rétention réglable via env `AUDIT_RETENTION_DAYS` (défaut 90 j ; 0 = jamais).
 * Le double-backend (cf. course des crons) est sans risque ici : la suppression
 * `where created_at < cutoff` est idempotente. Le 2e backend peut désactiver le
 * cron via `DISABLE_AUDIT_CRON=true` pour éviter le travail en double.
 */
@Injectable()
export class AuditCleanupTask {
  private readonly logger = new Logger(AuditCleanupTask.name);

  constructor(private readonly auditService: AuditService) {}

  private get retentionDays(): number {
    const raw = process.env.AUDIT_RETENTION_DAYS;
    if (raw === undefined || raw.trim() === '') return 90;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 90;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handlePrune() {
    if (process.env.DISABLE_AUDIT_CRON === 'true') return;
    const days = this.retentionDays;
    if (days <= 0) return;
    try {
      const deleted = await this.auditService.prune(days);
      if (deleted > 0) {
        this.logger.log(`Audit : ${deleted} log(s) purgé(s) (> ${days} j).`);
      }
    } catch (e) {
      this.logger.warn(`Purge audit échouée : ${(e as Error)?.message}`);
    }
  }
}
