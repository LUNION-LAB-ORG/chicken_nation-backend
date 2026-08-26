import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { DELAI_REPRISE_MS, MessageBroadcastService } from '../message-broadcast.service';

/**
 * Départ des diffusions planifiées.
 *
 * Sans cette tâche, `scheduled_at` serait un champ décoratif : l'écran
 * annoncerait un envoi pour demain et rien ne partirait jamais. Un réglage qui
 * ne fait rien est pire que pas de réglage du tout.
 */
@Injectable()
export class MessageBroadcastScheduledTask {
  private readonly logger = new Logger(MessageBroadcastScheduledTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: MessageBroadcastService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async partir() {
    const dues = await this.prisma.messageBroadcast.findMany({
      where: { status: 'scheduled', scheduled_at: { lte: new Date() } },
      select: { id: true, name: true },
      take: 10,
    });
    if (dues.length === 0) return;

    for (const diffusion of dues) {
      /**
       * ⚠️ CLAIM ATOMIQUE, et non un simple `update`.
       *
       * Deux instances du backend ont déjà tourné en parallèle sur ce projet.
       * Sans ce `updateMany` conditionné sur le statut, les deux prendraient la
       * même diffusion à la même minute et chaque client recevrait deux fois le
       * message. Celle qui obtient `count === 1` a gagné, l'autre passe son
       * chemin.
       */
      const gagne = await this.prisma.messageBroadcast.updateMany({
        where: { id: diffusion.id, status: 'scheduled' },
        data: { status: 'sending', started_at: new Date(), enqueue_seq: { increment: 1 } },
      });
      if (gagne.count === 0) continue;

      try {
        // `envoyer` refuserait, la diffusion n'étant plus `scheduled` : on
        // enfile directement, le claim ayant déjà été fait ci-dessus.
        await this.service.reprendre(diffusion.id);
        this.logger.log(`Diffusion planifiée partie : ${diffusion.name} (${diffusion.id})`);
      } catch (e: any) {
        this.logger.error(
          `Diffusion planifiée ${diffusion.id} non partie : ${e?.message}`,
        );
      }
    }
  }

  /**
   * Reprise automatique des diffusions restées en route.
   *
   * Le délai de reprise des destinataires réservés ne s'évalue qu'au moment
   * d'une mise en file, laquelle ne partait que d'un clic humain. Une diffusion
   * interrompue par un redémarrage, ou dont la file Redis a été perdue, restait
   * donc en « Envoi en cours » indéfiniment, et personne ne recevait rien de
   * plus. La base, elle, sait toujours qui n'a pas reçu.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async relancerLesBloquees() {
    const seuil = new Date(Date.now() - DELAI_REPRISE_MS);
    const bloquees = await this.prisma.messageBroadcast.findMany({
      where: {
        status: 'sending',
        started_at: { lt: seuil },
        recipients: {
          some: {
            OR: [
              { status: 'pending' },
              { status: 'sending', claimed_at: { lt: seuil } },
            ],
          },
        },
      },
      select: { id: true, name: true },
      take: 5,
    });

    for (const diffusion of bloquees) {
      try {
        await this.service.reprendre(diffusion.id);
        this.logger.warn(
          `Diffusion ${diffusion.name} (${diffusion.id}) reprise automatiquement`,
        );
      } catch (e: any) {
        this.logger.error(`Reprise automatique impossible pour ${diffusion.id} : ${e?.message}`);
      }
    }
  }
}
