import { Injectable } from "@nestjs/common";
import { AppGateway } from "src/socket-io/gateways/app.gateway";

@Injectable()
export class NotificationWebSocketService {
  constructor(private appGateway: AppGateway) {}

  // Envoyer une notification temps réel
  emitNotification(notification: any) {
    const { recipient_id, recipient_type, type, title, message, data } = notification;

    const notificationData = {
      id: notification.id,
      type,
      title,
      message,
      data,
      createdAt: notification.created_at,
      isRead: notification.is_read || false
    };

    // Émettre selon le type de destinataire
    if (recipient_type === 'CUSTOMER') {
      this.appGateway.emitToUser(recipient_id, 'customer', 'notification:new', notificationData);
    } else if (recipient_type === 'USER') {
      this.appGateway.emitToUser(recipient_id, 'user', 'notification:new', notificationData);
    } else if (recipient_type === 'RESTAURANT') {
      this.appGateway.emitToRestaurant(recipient_id, 'notification:new', notificationData);
    } else if (recipient_type === 'BACKOFFICE') {
      this.appGateway.emitToBackoffice('notification:new', notificationData);
    }
  }

  emitNotificationRead(notificationId: string, userId: string, userType: 'customer' | 'user') {
    this.appGateway.emitToUser(userId, userType, 'notification:read', {
      notificationId,
      message: 'Notification marquée comme lue'
    });
  }

  emitBulkNotificationRead(userId: string, userType: 'customer' | 'user', count: number) {
    this.appGateway.emitToUser(userId, userType, 'notification:bulk_read', {
      count,
      message: `${count} notifications marquées comme lues`
    });
  }
}
