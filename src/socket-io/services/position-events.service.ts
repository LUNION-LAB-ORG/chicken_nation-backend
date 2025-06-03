import { Injectable } from '@nestjs/common';
import { Socket } from 'socket.io';
import { IEventHandler } from '../interfaces/event-handler.interface';
import { IPosition } from '../interfaces/position-events.interface';

@Injectable()
export class PositionEventsService implements IEventHandler<IPosition> {
    private positionsByClientId: Map<string, IPosition> = new Map();

    async handleEvent(data: IPosition, client: Socket): Promise<any> {
        // Sauvegarde la position
        this.savePosition(client.id, data);

        console.log(`client ${client.id} a envoyé position: ${JSON.stringify(data)}`);

        return {
            status: 'success',
            message: 'Position envoyée avec succès',
        };
    }

    savePosition(clientId: string, position: IPosition): void {
        this.positionsByClientId.set(clientId, position);
    }

    getPosition(clientId: string): IPosition | undefined {
        return this.positionsByClientId.get(clientId);
    }

    getAllPositions(): Map<string, IPosition> {
        return this.positionsByClientId;
    }

    clearPosition(clientId: string): void {
        this.positionsByClientId.delete(clientId);
    }
}
