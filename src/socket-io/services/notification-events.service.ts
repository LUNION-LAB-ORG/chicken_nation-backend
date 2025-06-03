import { Injectable } from "@nestjs/common";
import { IEventHandler } from "../interfaces/event-handler.interface";
import { Socket } from "socket.io";
import { INotification } from "../interfaces/notification-events.interface";

@Injectable()
export class NotificationService implements IEventHandler<INotification> {
  async handleEvent(data: INotification, client: Socket): Promise<any> {
    // Logique de traitement des notifications
    return { status: 'success' };
  }
}