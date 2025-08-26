import { AppGateway } from '../../../socket-io/gateways/app.gateway';
import { Injectable } from '@nestjs/common';
import { ResponseMessageDto } from '../dto/response-message.dto';

@Injectable()
export class MessageWebSocketService {
  constructor(private appGateway: AppGateway) {}

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

    console.log('Emitted new message to users and customer:', {
      usersId,
      conversation,
      message,
    });
  }
}
