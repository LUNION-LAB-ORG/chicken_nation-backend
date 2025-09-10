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

    if (conversation.restaurant?.id) {
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
