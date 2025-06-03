import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import { BaseWebSocketGateway } from 'src/socket-io/gateways/base-websocket.gateway';
import { OrderHandleGatewayService } from '../services/order-handle-gateway.service';
import { Order } from '@prisma/client';

@Injectable()
@WebSocketGateway({
    namespace: 'orders-event',
    cors: {
        origin: '*',
    },
})
export class OrderGateway extends BaseWebSocketGateway {
    constructor(
        protected readonly configService: ConfigService,
        private readonly orderHandleGatewayService: OrderHandleGatewayService
    ) {
        super(configService);
    }

    protected getNamespace(): string {
        return 'orders-event';
    }

    @SubscribeMessage('orders')
    async handleOrderEvent(
        @MessageBody() data: Order,
        @ConnectedSocket() client: Socket
    ) {
        const result = await this.orderHandleGatewayService.handleEvent(data, client);

        // Émettre la position mise à jour à tous les clients
        this.emitToAll('orders-serveur', { client: client.id, data });

        return result;
    }

    // Surcharge de la méthode de la classe de base
    protected onClientDisconnect(client: Socket): void {
        // Nettoyer les données du client déconnecté
        this.orderHandleGatewayService.clearOrder(client.id);
    }
}