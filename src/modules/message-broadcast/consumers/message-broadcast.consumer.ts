import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from 'src/database/services/prisma.service';
import { DELAI_REPRISE_MS, MessageBroadcastService } from '../message-broadcast.service';

/**
 * Livraison d'une diffusion, lot par lot.
 *
 * ⚠️ Cette livraison n'emprunte PAS `MessagerieMessageService.createMessage`, et
 * c'est délibéré. Ce service notifie le personnel à chaque message : un
 * e-mail à toute l'équipe et une ligne de cloche par agent. Sur une diffusion de
 * mille clients, ce serait mille alertes pour un seul envoi voulu. On écrit donc
 * directement, en maîtrisant les effets de bord.
 */
@Processor('message-broadcast')
export class MessageBroadcastConsumer extends WorkerHost {
  private readonly logger = new Logger(MessageBroadcastConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: MessageBroadcastService,
  ) {
    super();
  }

  async process(job: Job<{ broadcastId: string; recipientIds: string[] }>) {
    const { broadcastId, recipientIds } = job.data;

    const diffusion = await this.prisma.messageBroadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, body: true, image_url: true },
    });
    if (!diffusion) {
      this.logger.warn(`Diffusion ${broadcastId} disparue, lot ignoré`);
      return;
    }

    for (const recipientId of recipientIds) {
      await this.livrerUn(diffusion.id, diffusion.body, diffusion.image_url, recipientId);
    }

    await this.service.cloturerSiTermine(broadcastId);
  }

  private async livrerUn(
    broadcastId: string,
    corps: string,
    image: string | null,
    recipientId: string,
  ) {
    /**
     * VERROU 1, la réservation. Un seul processus peut prendre ce destinataire.
     * La branche `sending` périmée récupère ceux qu'un processus tombé en cours
     * de lot aurait sinon laissés en attente pour toujours.
     */
    const reserve = await this.prisma.messageBroadcastRecipient.updateMany({
      where: {
        id: recipientId,
        OR: [
          { status: 'pending' },
          { status: 'sending', claimed_at: { lt: new Date(Date.now() - DELAI_REPRISE_MS) } },
          { status: 'failed' },
        ],
      },
      data: { status: 'sending', claimed_at: new Date() },
    });
    if (reserve.count === 0) return; // déjà traité, ou pris par quelqu'un d'autre

    const destinataire = await this.prisma.messageBroadcastRecipient.findUnique({
      where: { id: recipientId },
      select: { id: true, customer_id: true, broadcast_id: true },
    });
    if (!destinataire) return;

    try {
      const client = await this.prisma.customer.findUnique({
        where: { id: destinataire.customer_id },
        select: { id: true, first_name: true, entity_status: true },
      });
      if (!client || client.entity_status !== 'ACTIVE') {
        throw new Error('Client inactif ou supprimé');
      }

      // Le canal officiel du client, retrouvé ou créé. Un seul par client :
      // les diffusions successives s'empilent dans le même fil, elles ne créent
      // pas un fil par campagne.
      let conversation = await this.prisma.conversation.findFirst({
        where: { customerId: client.id, isBroadcast: true },
        select: { id: true },
      });
      if (!conversation) {
        try {
          conversation = await this.prisma.conversation.create({
            data: {
              customerId: client.id,
              isBroadcast: true,
              subject: 'Chicken Nation',
            },
            select: { id: true },
          });
        } catch (e) {
          // Course entre deux diffusions simultanées pour le même client :
          // l'index unique partiel a tranché, on relit le canal du gagnant.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            conversation = await this.prisma.conversation.findFirst({
              where: { customerId: client.id, isBroadcast: true },
              select: { id: true },
            });
            if (!conversation) throw e;
          } else {
            throw e;
          }
        }
      }

      const texte = this.remplacerVariables(corps, client.first_name);

      /**
       * VERROU 2, l'index unique partiel sur (conversationId, broadcastId).
       * La fenêtre entre l'écriture du message et l'inscription de son
       * identifiant sur la ligne du destinataire n'est protégée par rien
       * d'autre : sans cet index, une reprise au mauvais moment livrerait deux
       * fois le même message. On rattrape la violation plutôt que de la subir.
       */
      let messageId: string;
      try {
        const message = await this.prisma.message.create({
          data: {
            conversationId: conversation.id,
            body: texte,
            broadcastId: destinataire.broadcast_id,
            isRead: false,
            // Même forme que `message.service` : l'application sait déjà
            // afficher `meta.imageUrl`, rien à livrer de ce côté.
            meta: { imageUrl: image ?? null, orderId: null },
          },
          select: { id: true },
        });
        messageId = message.id;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const existant = await this.prisma.message.findFirst({
            where: { conversationId: conversation.id, broadcastId: destinataire.broadcast_id },
            select: { id: true },
          });
          if (!existant) throw e;
          messageId = existant.id;
        } else {
          throw e;
        }
      }

      /**
       * ⚠️ `updatedAt` de la conversation n'est PAS touché, contrairement à un
       * message ordinaire. C'est ce qui garde la diffusion hors de la boîte de
       * réception : la conversation n'y remontera qu'au premier message du
       * client, écrit par le chemin normal.
       */
      await this.prisma.messageBroadcastRecipient.update({
        where: { id: destinataire.id },
        data: {
          status: 'sent',
          sent_at: new Date(),
          conversation_id: conversation.id,
          message_id: messageId,
          error: null,
        },
      });
    } catch (e: any) {
      await this.prisma.messageBroadcastRecipient.update({
        where: { id: destinataire.id },
        data: { status: 'failed', error: String(e?.message ?? e).slice(0, 500) },
      });
      this.logger.warn(
        `Diffusion ${broadcastId} : échec pour le client ${destinataire.customer_id} — ${e?.message}`,
      );
    }
  }

  /** `{{first_name}}` seulement. Une variable inconnue est laissée telle quelle. */
  private remplacerVariables(texte: string, prenom?: string | null): string {
    return texte.replace(/\{\{\s*first_name\s*\}\}/g, (prenom ?? '').trim());
  }
}
