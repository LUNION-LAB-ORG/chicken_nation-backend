import { Injectable } from '@nestjs/common';
import { Socket } from 'socket.io';
import { Order } from '@prisma/client';
import { IEventHandler } from 'src/socket-io/interfaces/event-handler.interface';

@Injectable()
export class OrderGatewayService implements IEventHandler<Order> {
    private ordersByClientId: Map<string, Order> = new Map();

    async handleEvent(data: Order, client: Socket): Promise<any> {
        // Sauvegarde la commande
        this.saveOrder(client.id, data);

        console.log(`client ${client.id} a envoyé commande: ${JSON.stringify(data)}`);

        return {
            status: 'success',
            message: 'Commande envoyée avec succès',
        };
    }

    saveOrder(clientId: string, order: Order): void {
        this.ordersByClientId.set(clientId, order);
    }

    getOrder(clientId: string): Order | undefined {
        return this.ordersByClientId.get(clientId);
    }

    getAllOrders(): Map<string, Order> {
        return this.ordersByClientId;
    }

    clearOrder(clientId: string): void {
        this.ordersByClientId.delete(clientId);
    }
}
