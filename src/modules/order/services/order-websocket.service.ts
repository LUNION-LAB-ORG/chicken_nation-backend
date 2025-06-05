import { Injectable } from '@nestjs/common';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { Order, OrderStatus } from '@prisma/client';

@Injectable()
export class OrderWebSocketService {
    constructor(private appGateway: AppGateway) { }

    emitOrderCreated(order: Order) {
        // Notifier le client qui a passé la commande
        this.appGateway.emitToUser(order.customer_id, 'customer', 'order:created', {
            order,
            message: 'Votre commande a été créée avec succès'
        });

        // Notifier le backoffice
        this.appGateway.emitToBackoffice('order:created', {
            order,
            message: 'Nouvelle commande reçue'
        });

        // Notifier le restaurant
        this.appGateway.emitToRestaurant(order.restaurant_id, 'order:created', {
            order,
            message: 'Nouvelle commande pour votre restaurant'
        });
    }

    emitStatusUpdate(order: Order, previousStatus: OrderStatus) {
        const statusMessages = {
            PENDING: 'Commande en attente',
            ACCEPTED: 'Commande acceptée',
            IN_PROGRESS: 'Commande en préparation',
            READY: 'Commande prête',
            PICKED_UP: 'Commande en livraison',
            COLLECTED: 'Commande collectée',
            COMPLETED: 'Commande terminée',
            CANCELLED: 'Commande annulée'
        };

        const statusData = {
            order,
            message: statusMessages[order.status] || 'Statut mis à jour',
            previousStatus: previousStatus
        };

        this.appGateway.emitToUser(order.customer_id, 'customer', 'order:status_updated', statusData);
        this.appGateway.emitToBackoffice('order:status_updated', statusData);
        this.appGateway.emitToRestaurant(order.restaurant_id, 'order:status_updated', statusData);
    }

    emitOrderUpdated(order: Order) {
        const data = { order, message: 'Commande mise à jour' };

        this.appGateway.emitToUser(order.customer_id, 'customer', 'order:updated', data);
        this.appGateway.emitToBackoffice('order:updated', data);
        this.appGateway.emitToRestaurant(order.restaurant_id, 'order:updated', data);
    }

    emitOrderDeleted(order: Order) {
        const data = { orderId: order.id, message: 'Commande supprimée' };

        this.appGateway.emitToUser(order.customer_id, 'customer', 'order:deleted', data);
        this.appGateway.emitToBackoffice('order:deleted', data);
        this.appGateway.emitToRestaurant(order.restaurant_id, 'order:deleted', data);
    }
}
