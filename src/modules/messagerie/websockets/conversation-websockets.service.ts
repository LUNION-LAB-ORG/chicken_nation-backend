import { Injectable } from '@nestjs/common';
import { ResponseConversationsDto } from '../dto/response-conversations.dto';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

@Injectable()
export class ConversationWebsocketsService {
  constructor(private appGateway: AppGateway) {}

  emitConversationCreated(conversation: ResponseConversationsDto) {
    if (conversation.customerId) {
      this.appGateway.emitToUser(
        conversation.customerId,
        'customer',
        'new:conversation',
        conversation,
      );
    }

    /**
     * ⚠️ Réservé aux conversations CLIENT, comme le dit le nom de l'évènement.
     *
     * La salle `restaurant_<id>` est rejointe par les LIVREURS autant que par
     * le personnel : y publier une conversation interne leur livrerait le
     * groupe et son premier message. Les participants sont notifiés un par un
     * juste en dessous, ils ne perdent rien.
     */
    if (conversation.restaurant?.id && conversation.customerId) {
      this.appGateway.emitToRestaurant(
        conversation.restaurant.id,
        'new:customer_conversation',
        conversation,
      );
    }

    conversation.users.forEach((user) => {
      this.appGateway.emitToUser(
        user.id,
        'user',
        'new:conversation',
        conversation,
      );
    });
  }

  /**
   * La composition d'un GROUPE a changé.
   *
   * `destinataires` inclut volontairement les partants : c'est le seul moment
   * où on peut encore les prévenir, et leur écran doit retirer la conversation
   * de la liste. Pour eux l'évènement vaut « tu n'y es plus », pour les autres
   * « la liste des membres a bougé » ; le client distingue les deux en
   * cherchant son propre identifiant dans `conversation.users`.
   */
  /**
   * Prévenir quelqu'un qu'il ne fait plus partie d'un groupe.
   *
   * Charge utile RÉDUITE À L'IDENTIFIANT, délibérément : lui renvoyer la
   * conversation complète lui livrerait les cinquante derniers messages du
   * groupe dont on vient de le sortir. Son écran n'a besoin que de savoir
   * lequel retirer de sa liste.
   */
  emitRetireDuGroupe(userId: string, conversationId: string) {
    this.appGateway.emitToUser(userId, 'user', 'conversation:retire', {
      conversationId,
    });
  }

  emitParticipantsChanged(
    destinataires: string[],
    conversation: ResponseConversationsDto,
  ) {
    const vus = new Set<string>();
    destinataires.forEach((userId) => {
      if (!userId || vus.has(userId)) return;
      vus.add(userId);
      this.appGateway.emitToUser(userId, 'user', 'conversation:participants', conversation);
    });
  }
}
