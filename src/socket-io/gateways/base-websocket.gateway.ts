import { WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { IWebSocketGateway } from '../interfaces/websocket-gateway.interface';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export abstract class BaseWebSocketGateway implements IWebSocketGateway {
    @WebSocketServer()
    protected server: Server;
    private readonly logger = new Logger(BaseWebSocketGateway.name);

    constructor(protected readonly configService: ConfigService) { }

    // lorsqu'un client se connecte (par defaut sur tous les gateways)
    handleConnection(client: Socket) {
        this.logger.log(`Client connecté sur ${this.getNamespace()}: ${client.id}`);
        this.onClientConnect(client);
    }

    // lorsqu'un client se deconnecte (par defaut sur tous les gateways)
    handleDisconnection(client: Socket) {
        this.logger.log(`Client déconnecté de ${this.getNamespace()}: ${client.id}`);
        this.onClientDisconnect(client);
    }

    // Méthode abstraite que les implémentations devront définir
    protected abstract getNamespace(): string;

    // Méthode avec implémentation par défaut qui peuvent être surchargées
    protected onClientConnect(client: Socket): void {
    }

    // Méthode avec implémentation par défaut qui peuvent être surchargées
    protected onClientDisconnect(client: Socket): void {
    }

    // Méthode pour émettre des événements à tous les clients
    protected emitToAll(event: string, data: any): void {
        this.server.emit(event, data);
    }

    // Méthode pour émettre des événements à un client spécifique
    protected emitToClient(clientId: string, event: string, data: any): void {
        this.server.to(clientId).emit(event, data);
    }
}