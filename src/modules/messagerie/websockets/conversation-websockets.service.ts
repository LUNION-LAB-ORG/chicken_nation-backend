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
}
