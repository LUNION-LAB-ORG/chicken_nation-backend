import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { PushCampaignService } from '../push-campaign.service';

/**
 * CRON, relecture différée des reçus Expo.
 *
 * ⚠️ C'est la pièce qui manquait pour que le compteur « Livrés » existe.
 * L'ancien code demandait les reçus dans la milliseconde suivant l'envoi, alors
 * qu'Expo les prépare avec un retard pouvant aller jusqu'à une trentaine de
 * minutes : l'appel ne pouvait structurellement rien trouver.
 *
 * Fenêtre de travail : un ticket n'est relu qu'après QUINZE MINUTES, et plus du
 * tout au delà de VINGT-QUATRE HEURES, durée au bout de laquelle Expo cesse de
 * publier ses reçus. Un ticket sorti de la fenêtre sans réponse est classé
 * `unknown`, jamais `failed` : une absence d'information n'est pas un échec, et
 * la compter comme telle produirait des chiffres faux et alarmants.
 */
@Injectable()
export class PushReceiptTask {
  private readonly logger = new Logger(PushReceiptTask.name);

  /** Empêche deux ticks de se chevaucher dans le même process. */
  private enCours = false;

  /** Plafond par passage, pour ne pas monopoliser la base ni l'API Expo. */
  private static readonly PAR_PASSAGE = 2000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPushService: ExpoPushService,
    private readonly pushCampaignService: PushCampaignService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async relireLesRecus() {
    if (this.enCours) return;
    this.enCours = true;
    try {
      const maintenant = new Date();
      const mur = new Date(maintenant.getTime() - 15 * 60 * 1000);
      const peremption = new Date(maintenant.getTime() - 24 * 60 * 60 * 1000);

      // 1. Ce qui a dépassé la fenêtre ne sera jamais connu. On le dit.
      const perimes = await this.prisma.pushCampaignTicket.updateMany({
        where: { status: 'accepted', created_at: { lt: peremption } },
        data: { status: 'unknown', checked_at: maintenant },
      });
      if (perimes.count > 0) {
        this.logger.log(
          `${perimes.count} accusé(s) sans reçu au delà de 24 h, classés inconnus`,
        );
      }

      // 2. Le lot relisible.
      const aRelire = await this.prisma.pushCampaignTicket.findMany({
        where: {
          status: 'accepted',
          created_at: { lte: mur, gte: peremption },
        },
        select: {
          id: true,
          receipt_id: true,
          expo_push_token: true,
          campaign_id: true,
        },
        orderBy: { created_at: 'asc' },
        take: PushReceiptTask.PAR_PASSAGE,
      });
      if (aRelire.length === 0) return;

      /**
       * ⚠️ Volontairement SANS état de réservation intermédiaire.
       *
       * Un statut « en cours de vérification » exigerait un mécanisme de
       * récupération, sans quoi un redémarrage au mauvais moment y laisserait
       * des lignes bloquées pour toujours. Il n'est pas nécessaire ici : le
       * compteur est RECOMPTE et non incrémenté, donc deux passages simultanés
       * aboutissent au même chiffre. Le seul coût d'un chevauchement est un
       * aller-retour Expo en double, ce qui est très préférable à des lignes
       * définitivement coincées.
       */
      const verdicts = await this.expoPushService.verifierRecus(
        aRelire.map((t) => ({ id: t.receipt_id, token: t.expo_push_token })),
      );

      const remis = new Set(verdicts.livres);
      const refuses = new Set(verdicts.echecs);
      const campagnes = new Set<string>();

      for (const ticket of aRelire) {
        let statut: string | null = null;
        if (remis.has(ticket.receipt_id)) statut = 'delivered';
        else if (refuses.has(ticket.receipt_id)) statut = 'failed';
        // Reçu pas encore publié : on le laisse en `accepted`, il sera relu au
        // prochain passage tant qu'il reste dans la fenêtre.
        if (!statut) continue;

        await this.prisma.pushCampaignTicket.updateMany({
          where: { id: ticket.id, status: 'accepted' },
          data: {
            status: statut,
            checked_at: maintenant,
            ...(statut === 'delivered' ? { delivered_at: maintenant } : {}),
          },
        });
        campagnes.add(ticket.campaign_id);
      }

      for (const campagne of campagnes) {
        await this.pushCampaignService.recompterRemises(campagne);
      }

      this.logger.log(
        `Reçus relus : ${verdicts.livres.length} remis, ${verdicts.echecs.length} refusés, ${verdicts.inconnus.length} encore inconnus, sur ${campagnes.size} campagne(s)`,
      );
    } catch (error) {
      this.logger.error(`Relecture des reçus impossible : ${error?.message ?? error}`);
    } finally {
      this.enCours = false;
    }
  }
}
