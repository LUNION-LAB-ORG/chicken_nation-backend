import { AppGateway } from '../../../socket-io/gateways/app.gateway';
import { Injectable, Logger } from '@nestjs/common';
import { ResponseMessageDto } from '../dto/response-message.dto';
import { Conversation, Prisma } from '@prisma/client';

type ConversationGetPayload = Prisma.ConversationGetPayload<{
  include: {
    users: true;
  };
}>;

@Injectable()
export class MessageWebSocketService {
  private readonly logger = new Logger(MessageWebSocketService.name);
  constructor(private appGateway: AppGateway) { }

  emitNewMessage(
    usersId: string[],
    conversation: {
      restaurantId: string | null;
      customerId: string | null;
    },
    message: ResponseMessageDto,
  ) {
    // Émettre le message au client (customer)
    if (message.authorCustomer?.id) {
      this.appGateway.emitToUser(
        message.authorCustomer.id,
        'customer',
        'new:message',
        message,
      );
    }

    if (message.authorUser?.id) {
      this.appGateway.emitToUser(
        message.authorUser.id,
        'user',
        'new:message',
        message,
      );

      conversation.customerId &&
        this.appGateway.emitToUser(
          conversation.customerId,
          'customer',
          'new:message',
          message,
        );
    }

    // Émettre le message aux utilisateurs (users)
    usersId.forEach((userId) => {
      this.appGateway.emitToUser(userId, 'user', 'new:message', message);
    });

    conversation.restaurantId &&
      this.appGateway.emitToRestaurant(
        conversation.restaurantId,
        'new:message',
        message,
      );

    this.logger.debug('Emitted new message to users and customer:', {
      usersId,
      conversation,
      message,
    });
  }

  emitMessagesRead(conversation: ConversationGetPayload) {
    if (conversation.customerId) {
      this.appGateway.emitToUser(
        conversation.customerId,
        'customer',
        'messages:read',
        { conversationId: conversation.id },
      );
    }
    if (conversation.restaurantId) {
      this.appGateway.emitToRestaurant(conversation.restaurantId, 'messages:read', {
        conversationId: conversation.id,
      });
    }

    // Emit to all users in the conversation
    conversation.users.forEach((conversationUser) => {
      this.appGateway.emitToUser(
        conversationUser.userId,
        'user',
        'messages:read',
        { conversationId: conversation.id },
      );
    });
  }
}
