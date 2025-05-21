import { WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { IWebSocketGateway } from '../interfaces/websocket-gateway.interface';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';

@Injectable()
export abstract class BaseWebSocketGateway implements IWebSocketGateway {
    @WebSocketServer()
    protected server: Server;

    constructor(protected readonly configService: ConfigService) { }

    // Méthodes communes à tous les gateways
    handleConnection(client: Socket) {
        console.log(`Client connecté sur ${this.getNamespace()}: ${client.id}`);
        this.onClientConnect(client);
    }

    handleDisconnection(client: Socket) {
        console.log(`Client déconnecté de ${this.getNamespace()}: ${client.id}`);
        this.onClientDisconnect(client);
    }

    // Méthodes abstraites que les implémentations devront définir
    protected abstract getNamespace(): string;

    // Méthodes avec implémentation par défaut qui peuvent être surchargées
    protected onClientConnect(client: Socket): void {
        // Comportement par défaut - peut être surchargé par les classes dérivées
    }

    protected onClientDisconnect(client: Socket): void {
        // Comportement par défaut - peut être surchargé par les classes dérivées
    }

    // Méthode utilitaire pour émettre des événements
    protected emitToAll(event: string, data: any): void {
        this.server.emit(event, data);
    }

    protected emitToClient(clientId: string, event: string, data: any): void {
        this.server.to(clientId).emit(event, data);
    }
}