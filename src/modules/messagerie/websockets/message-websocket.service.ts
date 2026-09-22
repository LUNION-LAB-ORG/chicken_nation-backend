import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { agregerReactions } from 'src/common/constantes/emojis-reaction';
import { Injectable, Logger } from '@nestjs/common';
import { ResponseMessageDto } from '../dto/response-message.dto';
import { Prisma } from '@prisma/client';

type ConversationGetPayload = Prisma.ConversationGetPayload<{
  include: {
    users: true;
  };
}>;

@Injectable()
export class MessageWebSocketService {
  private readonly logger = new Logger(MessageWebSocketService.name);
  constructor(private appGateway: AppGateway) {}

  emitNewMessage(
    usersId: string[],
    conversation: {
      restaurantId: string | null;
      customerId: string | null;
    },
    message: ResponseMessageDto,
  ) {
    const authorUserId = message.authorUser?.id;
    const authorCustomerId = message.authorCustomer?.id;

    // 1. Envoyer au customer de la conversation (s'il n'est pas l'auteur)
    if (conversation.customerId && conversation.customerId !== authorCustomerId) {
      this.appGateway.emitToUser(
        conversation.customerId,
        'customer',
        'new:message',
        message,
      );
    }

    // 2. Envoyer à chaque staff participant (sauf l'auteur)
    const notifiedUsers = new Set<string>();
    usersId.forEach((userId) => {
      if (userId !== authorUserId && !notifiedUsers.has(userId)) {
        notifiedUsers.add(userId);
        this.appGateway.emitToUser(userId, 'user', 'new:message', message);
      }
    });

    /**
     * 3. Notifier le restaurant — UNIQUEMENT pour les conversations CLIENT.
     *
     * ⚠️ La salle `restaurant_<id>` n'est pas réservée au personnel du
     * backoffice : les LIVREURS affectés au restaurant la rejoignent aussi
     * (app.gateway.ts, à la connexion). Diffuser ici un message INTERNE, c'est
     * envoyer en clair à tous les livreurs connectés ce que deux agents
     * s'écrivent. Les participants sont déjà servis un par un à l'étape 2 :
     * cette diffusion ne sert qu'à rafraîchir la boîte de réception du
     * personnel sur les échanges avec un client. On la borne donc à ce cas.
     */
    if (conversation.restaurantId && conversation.customerId) {
      this.appGateway.emitToRestaurant(
        conversation.restaurantId,
        'new:message',
        message,
      );
    }

    this.logger.debug(
      `Emitted new message to ${notifiedUsers.size} users${conversation.customerId && conversation.customerId !== authorCustomerId ? ' + customer' : ''}${conversation.restaurantId ? ' + restaurant' : ''}`,
    );
  }

  /**
   * ⚠️ La charge utile dit désormais QUI a lu.
   *
   * Elle ne portait que l'identifiant de conversation, et l'évènement part aux
   * DEUX camps. Le destinataire ne pouvait donc pas savoir si la lecture venait
   * de l'autre partie ou de lui même : un client qui ouvrait sa conversation
   * déclenchait l'évènement, le recevait, et allumait la double coche sur ses
   * propres messages alors que personne du service client ne les avait lus.
   */
  /**
   * Les réactions d'un message ont changé.
   *
   * ⚠️ Chaque destinataire reçoit SA charge utile. `mine` dépend de qui
   * regarde : un agrégat unique afficherait « j'ai réagi » chez tout le monde
   * dès qu'une seule personne l'a fait. On calcule donc l'agrégat par personne.
   *
   * ⚠️ AUCUNE diffusion vers la salle du restaurant. Elle contient les
   * livreurs, et une réaction sur un échange interne n'a rien à y faire. Les
   * participants sont servis un par un, ils ne perdent rien.
   */
  emitReactionsChanged(
    conversation: { id: string; customerId: string | null },
    usersId: string[],
    messageId: string,
    reactions: { emoji: string; userId?: string | null; customerId?: string | null }[],
  ) {
    const charge = (pourQui: string | null) => ({
      conversationId: conversation.id,
      messageId,
      reactions: agregerReactions(reactions, pourQui),
    });

    if (conversation.customerId) {
      this.appGateway.emitToUser(
        conversation.customerId,
        'customer',
        'message:reactions',
        charge(conversation.customerId),
      );
    }

    const vus = new Set<string>();
    usersId.forEach((userId) => {
      if (!userId || vus.has(userId)) return;
      vus.add(userId);
      this.appGateway.emitToUser(userId, 'user', 'message:reactions', charge(userId));
    });

    this.logger.debug(
      `Réactions de ${messageId} diffusées à ${vus.size} agent(s)${conversation.customerId ? ' + client' : ''}`,
    );
  }

  /**
   * Un message a été RETIRÉ.
   *
   * On renvoie le message déjà nettoyé par le serveur, corps remplacé et pièce
   * jointe retirée : aucun client ne doit avoir à décider quoi masquer, et
   * celui qui l'aurait encore en cache le remplace tel quel.
   *
   * ⚠️ Pas de diffusion vers la salle du restaurant, qui contient les
   * livreurs. Les participants et le client sont servis nominativement.
   */
  emitMessageSupprime(
    conversation: { id: string; customerId: string | null },
    usersId: string[],
    message: ResponseMessageDto,
  ) {
    const charge = { conversationId: conversation.id, message };

    if (conversation.customerId) {
      this.appGateway.emitToUser(conversation.customerId, 'customer', 'message:supprime', charge);
    }

    const vus = new Set<string>();
    usersId.forEach((userId) => {
      if (!userId || vus.has(userId)) return;
      vus.add(userId);
      this.appGateway.emitToUser(userId, 'user', 'message:supprime', charge);
    });
  }

  emitMessagesRead(
    conversation: ConversationGetPayload,
    parQui: 'user' | 'customer' = 'user',
  ) {
    const payload = { conversationId: conversation.id, by: parQui };

    if (conversation.customerId) {
      this.appGateway.emitToUser(
        conversation.customerId,
        'customer',
        'messages:read',
        payload,
      );
    }

    // Même borne qu'à l'émission d'un message : la salle du restaurant contient
    // aussi les livreurs, elle ne doit rien apprendre d'une conversation interne.
    if (conversation.restaurantId && conversation.customerId) {
      this.appGateway.emitToRestaurant(
        conversation.restaurantId,
        'messages:read',
        payload,
      );
    }

    // Notifier chaque staff participant
    conversation.users.forEach((conversationUser) => {
      this.appGateway.emitToUser(
        conversationUser.userId,
        'user',
        'messages:read',
        payload,
      );
    });
  }
}
