import { Injectable } from "@nestjs/common";
import { AppGateway } from "src/socket-io/gateways/app.gateway";
import { Notification } from "@prisma/client";
import { NotificationRecipient } from "../interfaces/notifications.interface";

@Injectable()
export class NotificationsWebSocketService {
    constructor(private appGateway: AppGateway) { }

    // Envoyer une notification temps réel
    emitNotification(notification: Notification, recipient: NotificationRecipient, group: boolean = false) {

        const { id: recipient_id, restaurant_id, type: recipient_type } = recipient;

        // Émettre selon le type de destinataire
        if (recipient_type === 'customer') {
            if (group) {
                this.appGateway.emitToUserType('customers', 'notification:new', notification);
            } else {
                this.appGateway.emitToUser(recipient_id, 'customer', 'notification:new', notification);
            }
        } else if (recipient_type === 'restaurant_user') {
            if (restaurant_id && group) {
                this.appGateway.emitToRestaurant(restaurant_id, 'notification:new', notification);
            } else {
                this.appGateway.emitToUser(recipient_id, "user", 'notification:new', notification);
            }
        } else if (recipient_type === 'backoffice_user') {
            if (group) {
                this.appGateway.emitToBackoffice('notification:new', notification);
            } else {
                this.appGateway.emitToUser(recipient_id, "user", 'notification:new', notification);
            }
        }
    }

    // Envoyer une notification temps réel à un type d'utilisateur
    emitToUserType(notification: Notification, userType: 'customers' | 'users') {
        this.appGateway.emitToUserType(userType, 'notification:new', notification);
    }

    // Envoyer une broadcast à tous les connectés
    broadcast(event: string, notification: Notification) {
        this.appGateway.broadcast(event, notification);
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
