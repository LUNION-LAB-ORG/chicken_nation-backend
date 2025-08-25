import { Injectable } from '@nestjs/common';
import { ResponseConversationsDto } from '../dto/response-conversations.dto';
import { AppGateway } from '../../../socket-io/gateways/app.gateway';

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

    if (conversation.restaurantId) {
      this.appGateway.emitToRestaurant(
        conversation.restaurantId,
        'new:customer_conversation',
        conversation,
      );
    }

    // TODO: Ajouter l'envoi au call_center quand on aura la gestion des call_center

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
