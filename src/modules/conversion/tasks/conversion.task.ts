import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CampaignStatus, EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ConversionAlertService } from '../services/conversion-alert.service';
import { ConversionCampaignService } from '../services/conversion-campaign.service';
import { ConversionSyncService } from '../services/conversion-sync.service';

/**
 * Tâches planifiées du module Prospects. Toutes sont sûres en double backend :
 * les écritures sont des claims conditionnés par l'état attendu.
 */
@Injectable()
export class ConversionTask {
  private readonly logger = new Logger(ConversionTask.name);
  private enCours = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: ConversionSyncService,
    private readonly alertes: ConversionAlertService,
    private readonly campagnes: ConversionCampaignService,
  ) {}

  /** Toutes les 10 minutes : la liste rattrape ce que les événements ont manqué. */
  @Cron('*/10 * * * *')
  async reconcilier() {
    await this.uneFois('reconciliation', async () => {
      const r = await this.sync.reconcilier();
      if (Object.values(r).some((n) => n > 0)) {
        this.logger.log(
          `Prospects : ${r.crees} entrés, ${r.revus} revus, ${r.couponsUtilises} coupons rattachés, ${r.couponsLiberes} libérés`,
        );
      }
    });
  }

  /** Toutes les heures : prospects affectés et toujours pas appelés. */
  @Cron('0 * * * *')
  async alerter() {
    await this.uneFois('alertes', async () => {
      const n = await this.alertes.alerterNonContactes();
      if (n > 0) this.logger.log(`Prospects : ${n} affectations en retard signalées`);
    });
  }

  /**
   * Toutes les heures : une campagne dont le dernier jour est passé se clôture
   * seule, pour que son rapport soit figé et ses prospects libérés.
   */
  @Cron('5 * * * *')
  async cloturer() {
    await this.uneFois('clotures', async () => {
      const aujourdhui = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const echues = await this.prisma.conversionCampaign.findMany({
        where: {
          entity_status: { not: EntityStatus.DELETED },
          status: { in: [CampaignStatus.ACTIVE, CampaignStatus.SUSPENDED] },
          end_date: { lt: aujourdhui },
        },
        select: { id: true, name: true },
      });
      for (const c of echues) {
        try {
          const { rapport } = await this.campagnes.terminer(null, c.id);
          const indicateurs = (rapport as { indicateurs?: { conversions: number; cibles: number } }).indicateurs;
          if (indicateurs) await this.alertes.notifierFinCampagne(c.id, indicateurs);
          this.logger.log(`Campagne « ${c.name} » close à sa date de fin`);
        } catch (e) {
          this.logger.warn(`Clôture de la campagne ${c.id} impossible : ${(e as Error).message}`);
        }
      }
    });
  }

  private async uneFois(nom: string, travail: () => Promise<void>) {
    if (this.enCours.has(nom)) return;
    this.enCours.add(nom);
    try {
      await travail();
    } catch (e) {
      this.logger.error(`Tâche ${nom} du module Prospects échouée : ${(e as Error).message}`);
    } finally {
      this.enCours.delete(nom);
    }
  }
}
