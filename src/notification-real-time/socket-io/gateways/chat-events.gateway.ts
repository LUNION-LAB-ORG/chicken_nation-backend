import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { BaseWebSocketGateway } from './base-websocket.gateway';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import { IChatMessage } from '../interfaces/chat-events.interface';

@Injectable()
@WebSocketGateway({
  namespace: 'chat-socket-event',
  cors: {
    origin: '*',
  }
})
export class ChatEventsGateway extends BaseWebSocketGateway {
  constructor(protected readonly configService: ConfigService) {
    super(configService);
  }

  protected getNamespace(): string {
    return 'chat-socket-event';
  }

  @SubscribeMessage('message')
  async handleChatMessage(
    @MessageBody() data: IChatMessage,
    @ConnectedSocket() client: Socket
  ) {
    console.log(`Chat message de ${client.id}: ${data.message}`);

    // Enrichir les données avec des informations sur l'expéditeur
    const messageWithMeta = {
      ...data,
      timestamp: data.timestamp || Date.now(),
      clientId: client.id
    };

    // Diffuser le message à tous les clients
    this.emitToAll('chat-message', messageWithMeta);

    return {
      status: 'success',
      message: 'Message envoyé avec succès',
    };
  }
}