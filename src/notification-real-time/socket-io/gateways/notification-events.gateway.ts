import { Injectable } from "@nestjs/common";
import { ConnectedSocket, WebSocketGateway } from "@nestjs/websockets";
import { BaseWebSocketGateway } from "./base-websocket.gateway";
import { ConfigService } from "@nestjs/config";
import { NotificationService } from "../services/notification-events.service";
import { INotification } from "../interfaces/notification-events.interface";
import { Socket } from "socket.io";
import { MessageBody, SubscribeMessage } from "@nestjs/websockets";

@Injectable()
@WebSocketGateway({
    namespace: 'notifications',
    cors: { origin: '*' }
})
export class NotificationGateway extends BaseWebSocketGateway {
    constructor(
        protected readonly configService: ConfigService,
        private readonly notificationService: NotificationService
    ) {
        super(configService);
    }

    protected getNamespace(): string {
        return 'notifications';
    }

    @SubscribeMessage('notify')
    async handleNotification(
        @MessageBody() data: INotification,
        @ConnectedSocket() client: Socket
    ) {
        return this.notificationService.handleEvent(data, client);
    }
}