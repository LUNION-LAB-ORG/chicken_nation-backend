import { AppGateway } from 'src/socket-io/gateways/app.gateway';
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

    // 3. Notifier le restaurant (pour le backoffice)
    if (conversation.restaurantId) {
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

  emitMessagesRead(conversation: ConversationGetPayload) {
    const payload = { conversationId: conversation.id };

    if (conversation.customerId) {
      this.appGateway.emitToUser(
        conversation.customerId,
        'customer',
        'messages:read',
        payload,
      );
    }

    if (conversation.restaurantId) {
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
