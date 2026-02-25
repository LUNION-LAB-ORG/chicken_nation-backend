import { Injectable } from '@nestjs/common';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { Order, OrderStatus } from '@prisma/client';
import { OrderChannels } from '../enums/order-channels';



@Injectable()
export class OrderWebSocketService {
    constructor(private appGateway: AppGateway) { }

    emitOrderCreated(order: Order) {
        // Notifier le client qui a passé la commande
        this.appGateway.emitToUser(order.customer_id, 'customer', OrderChannels.ORDER_CREATED, {
            order,
            message: 'Votre commande a été créée avec succès'
        });

        // Notifier le backoffice
        this.appGateway.emitToBackoffice(OrderChannels.ORDER_CREATED, {
            order,
            message: 'Nouvelle commande reçue'
        });

        // Notifier le restaurant
        this.appGateway.emitToRestaurant(order.restaurant_id, OrderChannels.ORDER_CREATED, {
            order,
            message: 'Nouvelle commande pour votre restaurant'
        });
    }

    emitStatusUpdate(order: Order, previousStatus: OrderStatus) {
        const statusMessages = {
            PENDING: 'Commande en attente',
            ACCEPTED: 'Présence confirmée - Lancer la cuisson !',
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

        this.appGateway.emitToUser(order.customer_id, 'customer', OrderChannels.ORDER_STATUS_UPDATED, statusData);
        this.appGateway.emitToBackoffice(OrderChannels.ORDER_STATUS_UPDATED, statusData);
        this.appGateway.emitToRestaurant(order.restaurant_id, OrderChannels.ORDER_STATUS_UPDATED, statusData);
    }

    emitOrderUpdated(order: Order) {
        const data = { order, message: 'Commande mise à jour' };

        this.appGateway.emitToUser(order.customer_id, 'customer', OrderChannels.ORDER_UPDATED, data);
        this.appGateway.emitToBackoffice(OrderChannels.ORDER_UPDATED, data);
        this.appGateway.emitToRestaurant(order.restaurant_id, OrderChannels.ORDER_UPDATED, data);
    }

    emitOrderDeleted(order: Order) {
        const data = { orderId: order.id, message: 'Commande supprimée' };

        this.appGateway.emitToUser(order.customer_id, 'customer', OrderChannels.ORDER_DELETED, data);
        this.appGateway.emitToBackoffice(OrderChannels.ORDER_DELETED, data);
        this.appGateway.emitToRestaurant(order.restaurant_id, OrderChannels.ORDER_DELETED, data);
    }
}
