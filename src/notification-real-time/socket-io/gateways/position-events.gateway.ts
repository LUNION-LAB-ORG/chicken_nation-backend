import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { IPosition } from '../interfaces/position-events.interface';
import { BaseWebSocketGateway } from './base-websocket.gateway';
import { PositionEventsService } from '../services/position-events.service';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';

@Injectable()
@WebSocketGateway({
  namespace: 'position-socket-event',
  cors: {
    origin: '*',
  },
})
export class PositionEventsGateway extends BaseWebSocketGateway {
  constructor(
    protected readonly configService: ConfigService,
    private readonly positionService: PositionEventsService
  ) {
    super(configService);
  }

  protected getNamespace(): string {
    return 'position-socket-event';
  }

  @SubscribeMessage('position')
  async handlePositionEvent(
    @MessageBody() data: IPosition,
    @ConnectedSocket() client: Socket
  ) {
    const result = await this.positionService.handleEvent(data, client);

    // Émettre la position mise à jour à tous les clients
    this.emitToAll('position-serveur', { client: client.id, data });

    return result;
  }

  // Surcharge de la méthode de la classe de base
  protected onClientDisconnect(client: Socket): void {
    // Nettoyer les données du client déconnecté
    this.positionService.clearPosition(client.id);
  }
}