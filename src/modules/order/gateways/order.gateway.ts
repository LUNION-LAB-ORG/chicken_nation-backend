import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    OnGatewayConnection,
    OnGatewayDisconnect,
    ConnectedSocket,
    MessageBody
} from '@nestjs/websockets';
import { EntityStatus, Order, OrderStatus } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { PrismaService } from 'src/database/services/prisma.service';
import { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';

interface ConnectedUser {
    id: string;
    type: 'customer' | 'user';
    userType?: 'BACKOFFICE' | 'RESTAURANT';
    restaurantId?: string;
    socketId: string;
}

@WebSocketGateway({
    cors: {
        origin: '*',
    },
    namespace: '/orders'
})
export class OrderGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    // Map pour stocker les connexions actives
    private connectedUsers = new Map<string, ConnectedUser>();

    constructor(
        private prisma: PrismaService,
        private jwtService: JsonWebTokenService,
    ) { }

    async handleConnection(client: Socket) {
        try {
            // Récupérer le token depuis les query params ou headers
            const token = client.handshake.query.token as string ||
                client.handshake.headers.authorization?.replace('Bearer ', '');

            // Récupérer le type d'utilisateur depuis les query params ou headers
            const userType = client.handshake.query.type as "user" | "customer" ||
                client.handshake.headers.type;

            if (!token) {
                client.disconnect();
                return;
            }

            // Vérifier et décoder le token
            const decoded = await this.jwtService.verifyToken(token, userType);

            // Identifier le type d'utilisateur et récupérer ses informations
            const userInfo = await this.identifyUser(decoded, userType);

            if (!userInfo) {
                client.disconnect();
                return;
            }

            // Stocker la connexion
            this.connectedUsers.set(client.id, {
                ...userInfo,
                socketId: client.id
            });

            // Joindre les rooms appropriées
            await this.joinRooms(client, userInfo);

            console.log(`${userInfo.type} ${userInfo.id} connected`);
            return `${userInfo.type} ${userInfo.id} connected`;
        } catch (error) {
            console.error('Connection error:', error);
            client.disconnect();
        }
    }

    handleDisconnect(client: Socket) {
        const user = this.connectedUsers.get(client.id);
        if (user) {
            console.log(`${user.type} ${user.id} disconnected`);
            this.connectedUsers.delete(client.id);
        }
    }

    private async identifyUser(decoded: { sub: string }, type: "user" | "customer"): Promise<ConnectedUser | null> {
        // Si c'est un customer
        if (decoded.sub) {
            if (type === "customer") {
                const customer = await this.prisma.customer.findUnique({
                    where: { id: decoded.sub, entity_status: EntityStatus.ACTIVE }
                });

                if (customer) {
                    return {
                        id: customer.id,
                        type: 'customer',
                        socketId: ''
                    };
                }
            }
            else if (type === "user") {
                const user = await this.prisma.user.findUnique({
                    where: { id: decoded.sub, entity_status: EntityStatus.ACTIVE },
                    include: { restaurant: true }
                });

                if (user) {
                    return {
                        id: user.id,
                        type: 'user',
                        userType: user.type,
                        restaurantId: user.restaurant_id ?? undefined,
                        socketId: ''
                    };
                }
            }
        }

        return null;
    }

    // private async joinRooms(client: Socket, userInfo: ConnectedUser) {
    //     // Room générale pour le type d'utilisateur
    //     await client.join(`${userInfo.type}s`);

    //     if (userInfo.type === 'customer') {
    //         return {
    //             id: userInfo.id,
    //             type: 'user',
    //             userType: userInfo.userType,
    //             restaurantId: userInfo.restaurantId ?? undefined,
    //             socketId: ''
    //         };
    //     }
    // }

    private async joinRooms(client: Socket, userInfo: ConnectedUser) {
        // Room générale pour le type d'utilisateur
        await client.join(`${userInfo.type}s`);

        if (userInfo.type === 'customer') {
            // Room spécifique au customer
            await client.join(`customer_${userInfo.id}`);
        } else if (userInfo.type === 'user') {
            if (userInfo.userType === 'BACKOFFICE') {
                // Backoffice peut voir toutes les commandes
                await client.join('backoffice_all');
            } else if (userInfo.userType === 'RESTAURANT' && userInfo.restaurantId) {
                // Restaurant ne voit que ses commandes
                await client.join(`restaurant_${userInfo.restaurantId}`);
            }
        }
    }

    // ================================
    // MÉTHODES D'ÉMISSION D'ÉVÉNEMENTS
    // ================================

    emitOrderCreated(order: any) {
        // Notifier le customer qui a passé la commande
        this.server.to(`customer_${order.customer_id}`).emit('order:created', {
            order,
            message: 'Votre commande a été créée avec succès'
        });

        // Notifier le backoffice
        this.server.to('backoffice_all').emit('order:created', {
            order,
            message: 'Nouvelle commande reçue'
        });

        // Notifier le restaurant concerné
        this.server.to(`restaurant_${order.restaurant_id}`).emit('order:created', {
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
            message: statusMessages[previousStatus] || 'Statut mis à jour',
            previousStatus: previousStatus // Si vous trackez l'ancien statut
        };

        // Notifier le customer
        this.server.to(`customer_${order.customer_id}`).emit('order:status_updated', statusData);

        // Notifier le backoffice
        this.server.to('backoffice_all').emit('order:status_updated', statusData);

        // Notifier le restaurant
        this.server.to(`restaurant_${order.restaurant_id}`).emit('order:status_updated', statusData);
    }

    emitOrderUpdated(order: any) {
        // Notifier le customer
        this.server.to(`customer_${order.customer_id}`).emit('order:updated', {
            order,
            message: 'Votre commande a été mise à jour'
        });

        // Notifier le backoffice
        this.server.to('backoffice_all').emit('order:updated', {
            order,
            message: 'Commande mise à jour'
        });

        // Notifier le restaurant
        this.server.to(`restaurant_${order.restaurant_id}`).emit('order:updated', {
            order,
            message: 'Commande mise à jour'
        });
    }

    emitOrderDeleted(order: any) {
        // Notifier le customer
        this.server.to(`customer_${order.customer_id}`).emit('order:deleted', {
            orderId: order.id,
            message: 'Votre commande a été supprimée'
        });

        // Notifier le backoffice
        this.server.to('backoffice_all').emit('order:deleted', {
            orderId: order.id,
            message: 'Commande supprimée'
        });

        // Notifier le restaurant
        this.server.to(`restaurant_${order.restaurant_id}`).emit('order:deleted', {
            orderId: order.id,
            message: 'Commande supprimée'
        });
    }

    // Méthode pour obtenir les statistiques de connexion
    getConnectionStats() {
        const stats = {
            total: this.connectedUsers.size,
            customers: 0,
            backoffice: 0,
            restaurants: new Map<string, number>()
        };

        this.connectedUsers.forEach(user => {
            if (user.type === 'customer') {
                stats.customers++;
            } else if (user.userType === 'BACKOFFICE') {
                stats.backoffice++;
            } else if (user.userType === 'RESTAURANT' && user.restaurantId) {
                const current = stats.restaurants.get(user.restaurantId) || 0;
                stats.restaurants.set(user.restaurantId, current + 1);
            }
        });

        return stats;
    }

    // Message de test pour vérifier la connexion
    @SubscribeMessage('ping')
    handlePing(@ConnectedSocket() client: Socket): string {
        const user = this.connectedUsers.get(client.id);
        return `pong from ${user?.type} ${user?.id}`;
    }
}
