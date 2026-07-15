import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LoyaltyLevel } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { LoyaltyService } from '../services/loyalty.service';

/**
 * CRON — RESET ANNUEL du compteur de STATUT (status_points).
 *
 * Le NIVEAU de fidélité (STANDARD / VIP / VVIP) est adossé à `status_points`,
 * un compteur des points EARNED sur l'année glissante commerciale. Chaque
 * nouvelle année civile, on remet `status_points = 0` pour TOUS les clients puis
 * on recalcule leur niveau (par batch — ~12k clients).
 *
 * Double backend : le déclenchement est protégé par un claim ATOMIQUE
 * (compare-and-set) sur le Setting `loyalty.status_reset_year` → une seule
 * instance exécute le reset pour une année donnée. Poser
 * `DISABLE_LOYALTY_STATUS_RESET_CRON=true` sur les instances non-worker.
 *
 * Sécurité au 1er déploiement : si le Setting n'existe pas encore, on le SÈME à
 * l'année courante SANS lancer de reset (sinon on écraserait le status_points
 * fraîchement backfillé par la migration).
 */
@Injectable()
export class LoyaltyStatusResetTask {
  private readonly logger = new Logger(LoyaltyStatusResetTask.name);
  private running = false;

  private static readonly SETTING_KEY = 'loyalty.status_reset_year';
  private static readonly BATCH_SIZE = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly loyaltyService: LoyaltyService,
  ) {}

  // Tous les jours à minuit : le reset ne se déclenche réellement qu'au premier
  // tick de la nouvelle année (grâce au claim compare-and-set).
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async resetAnnualStatus() {
    if (process.env.DISABLE_LOYALTY_STATUS_RESET_CRON === 'true') return;
    if (this.running) return;
    this.running = true;

    try {
      const claimed = await this.claimYear();
      if (!claimed) return;

      this.logger.log(
        `Reset annuel du statut fidélité déclenché pour l'année ${new Date().getFullYear()}...`,
      );
      const affected = await this.runReset();
      this.logger.log(
        `Reset annuel terminé : ${affected} client(s) recalculé(s).`,
      );
    } catch (error) {
      this.logger.error(
        `Erreur lors du reset annuel du statut fidélité : ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Claim ATOMIQUE de l'année via le Setting `loyalty.status_reset_year`.
   * Retourne `true` uniquement pour l'instance qui a le droit d'exécuter le reset
   * de l'année courante ; `false` sinon (déjà fait, année inchangée, ou 1er seed).
   */
  private async claimYear(): Promise<boolean> {
    const year = new Date().getFullYear();
    const key = LoyaltyStatusResetTask.SETTING_KEY;

    const stored = await this.prisma.setting.findUnique({ where: { key } });

    // 1er run : aucune trace → on SÈME sans reset (préserve le backfill migration).
    // createMany + skipDuplicates = safe si une autre instance sème en même temps.
    if (!stored) {
      await this.prisma.setting.createMany({
        data: [
          {
            key,
            value: String(year),
            description:
              'Dernière année où le status_points de fidélité a été réinitialisé',
          },
        ],
        skipDuplicates: true,
      });
      return false;
    }

    const storedYear = parseInt(stored.value, 10);
    // Année pas encore franchie (ou valeur illisible) → rien à faire.
    if (!Number.isFinite(storedYear) || storedYear >= year) return false;

    // Compare-and-set : SEULE l'instance qui bascule `stored.value → year` gagne.
    const claim = await this.prisma.setting.updateMany({
      where: { key, value: stored.value },
      data: { value: String(year), updated_at: new Date() },
    });
    return claim.count > 0;
  }

  /**
   * Remet `status_points = 0` pour tous les clients, recalcule le niveau et trace
   * l'historique. Traité par BATCH pour rester léger sur ~12k clients.
   *
   * Note schéma : `LoyaltyLevelHistory.new_level` est NON-NULL. Quand le niveau
   * recalculé est `null` (status_points=0 < standard_threshold, cas nominal), on
   * ne peut pas représenter la transition en historique → on remet quand même le
   * niveau à `null` mais sans ligne d'historique (limitation assumée). Les
   * transitions vers un niveau non-null (config à seuil 0) sont, elles, tracées.
   */
  private async runReset(): Promise<number> {
    const config = await this.loyaltyService.getConfig();
    const newLevel = this.computeLevel(0, config);

    let processed = 0;
    let cursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Pagination par curseur stable (id) sur TOUS les clients. Remettre
      // status_points à 0 quand il l'est déjà est inoffensif ; on garde le
      // parcours simple et déterministe plutôt qu'un filtre fragile.
      const batch = await this.prisma.customer.findMany({
        select: { id: true, loyalty_level: true },
        orderBy: { id: 'asc' },
        take: LoyaltyStatusResetTask.BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;

      const ids = batch.map((c) => c.id);
      // Clients dont le niveau CHANGE réellement (pour l'historique).
      const changed = batch.filter((c) => c.loyalty_level !== newLevel);

      await this.prisma.$transaction(async (tx) => {
        await tx.customer.updateMany({
          where: { id: { in: ids } },
          data: {
            status_points: 0,
            loyalty_level: newLevel,
            last_level_update: new Date(),
          },
        });

        // Historique : uniquement quand le niveau cible est représentable (non-null).
        if (newLevel && changed.length > 0) {
          await tx.loyaltyLevelHistory.createMany({
            data: changed.map((c) => ({
              customer_id: c.id,
              previous_level: c.loyalty_level,
              new_level: newLevel,
              points_at_time: 0,
              reason: 'Reset annuel du statut',
            })),
          });
        }
      });

      processed += batch.length;
      if (batch.length < LoyaltyStatusResetTask.BATCH_SIZE) break;
    }

    return processed;
  }

  /** Niveau correspondant à un `status_points` donné (mêmes seuils que le service). */
  private computeLevel(
    statusPoints: number,
    config: { standard_threshold: number; premium_threshold: number; gold_threshold: number },
  ): LoyaltyLevel | null {
    if (statusPoints >= config.gold_threshold) return LoyaltyLevel.VVIP;
    if (statusPoints >= config.premium_threshold) return LoyaltyLevel.VIP;
    if (statusPoints >= config.standard_threshold) return LoyaltyLevel.STANDARD;
    return null;
  }
}
