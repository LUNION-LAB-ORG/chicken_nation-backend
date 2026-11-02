import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CampaignStatus, EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CrmAlertService } from '../services/crm-alert.service';
import { CrmCampaignService } from '../services/crm-campaign.service';
import { CrmRattrapageService, TAILLE_REVUE } from '../services/crm-rattrapage.service';
import { CrmRepriseAcquisitionService } from '../services/crm-reprise-acquisition.service';
import { CrmRepriseService } from '../services/crm-reprise.service';
import { CrmDormantsService } from '../services/crm-dormants.service';

/**
 * Tâches planifiées du CRM. Toutes sont sûres en double backend : les
 * écritures sont des claims conditionnés par l'état attendu.
 */
@Injectable()
export class CrmTask implements OnApplicationBootstrap {
  private readonly logger = new Logger(CrmTask.name);
  private enCours = new Set<string>();

  constructor(
    private readonly dormants: CrmDormantsService,
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

    /*
      ORDRE IMPOSÉ, les trois requêtes regardent la même dernière commande :
       1. les inactifs, déjà faits au-dessus ;
       2. les clients de l'annuaire qui viennent de franchir le délai, sinon ils
          resteraient « actifs » pour toujours et n'entreraient jamais en
          reconquête ;
       3. seulement ensuite, les fiches des clients encore actifs.
      Inverser 2 et 3 créerait une fiche « client actif » juste avant de la
      basculer, ou pire, laisserait passer un tour.
    */
    const bascules = await this.rattrapage.basculerClientsDevenusInactifs();
    if (bascules > 0) {
      this.logger.log(`CRM : ${bascules} client(s) de l'annuaire devenu(s) inactif(s)`);
    }

    const annuaire = await this.rattrapage.creerFichesClientsActifs();
    if (annuaire > 0) {
      this.logger.log(`CRM : ${annuaire} client(s) actif(s) ajouté(s) à l'annuaire`);
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
      // Planifiées dont la date de fin est passée sans lancement : closes, sans contact à rendre.
      const nonLancees = await this.campagnes.cloreNonLancees();
      if (nonLancees > 0) this.logger.log(`${nonLancees} campagne(s) planifiée(s) close(s) sans avoir été lancée(s)`);
    });
  }

  /**
   * Toutes les heures : une campagne planifiée dont la date de début est
   * arrivée se lance seule, par le même lancement que le bouton.
   */
  @Cron('15 * * * *')
  async lancerPlanifiees() {
    await this.uneFois('lancements', async () => {
      const r = await this.campagnes.lancerPlanifiees();
      if (r.lancees + r.refusees + r.pannes > 0) {
        this.logger.log(`Lancements automatiques : ${r.lancees} lancée(s), ${r.refusees} refusée(s), ${r.pannes} en panne`);
      }
    });
  }

  /** Toutes les heures : les fiches ouvertes d'un agent désactivé ne restent pas bloquées chez lui. */
  @Cron('25 * * * *')
  async libererAgentsPartis() {
    await this.uneFois('agents_partis', async () => {
      const r = await this.campagnes.libererAgentsPartis();
      if (r.liberes > 0) this.logger.log(`Agents partis : ${r.liberes} fiche(s) libérée(s), ${r.campagnes} campagne(s) concernée(s)`);
    });
  }

  /** Toutes les heures : une campagne suspendue depuis trop longtemps alerte la direction. */
  @Cron('45 * * * *')
  async alerterSuspensions() {
    await this.uneFois('suspensions', async () => {
      const n = await this.alertes.alerterSuspensions();
      if (n > 0) this.logger.log(`${n} campagne(s) suspendue(s) signalée(s) à la direction`);
    });
  }

  /**
   * Chaque jour à 05 h 50 : les inscrits et les inactifs à reprendre (libérés,
   * nouveaux inactifs, nouveaux inscrits) rejoignent la campagne en cours de
   * leur public, en répartition automatique.
   */
  @Cron('50 5 * * *')
  async rejoindreCampagnes() {
    await this.uneFois('ajout_du_jour', async () => {
      await this.campagnes.rejoindreCampagnes();
    });
  }

  /**
   * Réveil des contacts endormis, une fois par heure.
   *
   * À l'heure plutôt qu'au jour : un délai réglé à 1 jour doit se voir le
   * lendemain matin, pas à l'heure arbitraire d'un passage quotidien.
   */
  @Cron('35 * * * *')
  async reveillerDormants() {
    await this.uneFois('dormants', async () => {
      await this.dormants.reveiller();
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
