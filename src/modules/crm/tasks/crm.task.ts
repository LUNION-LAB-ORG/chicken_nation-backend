import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CampaignStatus, EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CrmAlertService } from '../services/crm-alert.service';
import { CrmCampaignService } from '../services/crm-campaign.service';
import { CrmRattrapageService, TAILLE_REVUE } from '../services/crm-rattrapage.service';
import { CrmRepriseAcquisitionService } from '../services/crm-reprise-acquisition.service';
import { CrmRepriseService } from '../services/crm-reprise.service';

/**
 * Tâches planifiées du CRM. Toutes sont sûres en double backend : les
 * écritures sont des claims conditionnés par l'état attendu.
 */
@Injectable()
export class CrmTask implements OnApplicationBootstrap {
  private readonly logger = new Logger(CrmTask.name);
  private enCours = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rattrapage: CrmRattrapageService,
    private readonly reprise: CrmRepriseService,
    private readonly repriseAcquisition: CrmRepriseAcquisitionService,
    private readonly alertes: CrmAlertService,
    private readonly campagnes: CrmCampaignService,
  ) {}

  /**
   * Au démarrage, sans retarder l'ouverture de l'API : rattrapage, puis
   * détection des inactifs, puis l'historique de l'ancien écran Rétention est repris (une
   * seule fois en pratique : la reprise ne refait jamais ce qui existe).
   */
  onApplicationBootstrap() {
    setTimeout(() => {
      void this.uneFois('demarrage', async () => {
        // Ce qui s'est passé pendant l'arrêt du backend n'a émis aucun événement.
        await this.rattrapage.reconcilier();
        await this.detecter();
        await this.reprise.reprendreRetention();
        const reprise = await this.repriseAcquisition.reprendre();
        // Les fiches reprises sont jugées tout de suite, pas au passage suivant :
        // un client Glovo qui a déjà commandé sur l'appli ne doit pas rester
        // « à appeler » dans la file commune.
        if (reprise.fiches + reprise.captures > 0) {
          for (let passe = 0; passe < 10; passe++) {
            const r = await this.rattrapage.reconcilier();
            if (r.revus < TAILLE_REVUE) break;
          }
        }
      });
    }, 15_000);
  }

  /** Toutes les 10 minutes : la liste rattrape ce que les événements ont manqué. */
  @Cron('*/10 * * * *')
  async reconcilier() {
    await this.uneFois('reconciliation', async () => {
      // Tant que l'appli caisse garde ses anciennes routes, ce qu'elles ont
      // laissé sans fiche est repris ici.
      await this.repriseAcquisition.reprendre();
      const r = await this.rattrapage.reconcilier();
      if (Object.values(r).some((n) => n > 0)) {
        this.logger.log(
          `CRM : ${r.crees} inscrits entrés, ${r.lies} comptes associés, ${r.revus} revus, ${r.couponsUtilises} coupons rattachés, ` +
            `${r.couponsLiberes} libérés, ${r.ventes} ventes ajoutées au registre`,
        );
      }
    });
  }

  /** Chaque heure : les clients qui ont passé le délai sans commander deviennent inactifs. */
  @Cron('20 * * * *')
  async detecterInactifs() {
    await this.uneFois('inactifs', () => this.detecter());
  }

  private async detecter() {
    const r = await this.rattrapage.detecterInactifs();
    if (r.nouveaux + r.rechutes > 0) {
      this.logger.log(`CRM : ${r.nouveaux} nouveaux inactifs, ${r.rechutes} clients redevenus inactifs`);
    }
  }

  /** Toutes les heures : contacts affectés et toujours pas appelés. */
  @Cron('0 * * * *')
  async alerter() {
    await this.uneFois('alertes', async () => {
      const n = await this.alertes.alerterNonContactes();
      if (n > 0) this.logger.log(`Contacts : ${n} affectations en retard signalées`);
    });
  }

  /**
   * Toutes les heures : une campagne dont le dernier jour est passé se clôture
   * seule, pour que son rapport soit figé et ses contacts libérés.
   */
  @Cron('5 * * * *')
  async cloturer() {
    await this.uneFois('clotures', async () => {
      const aujourdhui = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const echues = await this.prisma.crmCampaign.findMany({
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
      this.logger.error(`Tâche ${nom} du CRM échouée : ${(e as Error).message}`);
    } finally {
      this.enCours.delete(nom);
    }
  }
}
