import { Socket } from 'socket.io';

export interface IWebSocketGateway {
    handleConnection(client: Socket): void;
    handleDisconnection(client: Socket): void;
}
