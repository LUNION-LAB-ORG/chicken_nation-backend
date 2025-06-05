
import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';
import { ConnectedUser } from '../interfaces/app.gateway.interface';

@WebSocketGateway({
    cors: { origin: '*' },
    namespace: '/app' // Namespace global pour toute l'app
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private connectedUsers = new Map<string, ConnectedUser>();

    constructor(
        private prisma: PrismaService,
        private jwtService: JsonWebTokenService,
    ) { }

    async handleConnection(client: Socket) {
        try {
            // Récupérer le token depuis les headers
            const token = client.handshake.query.token as string || '';

            // Récupérer le type d'utilisateur depuis les query params
            const userType = client.handshake.query.type as "user" | "customer"

            if (!token || !userType) {
                console.log('Token ou type d\'utilisateur manquant');
                client.disconnect();
                return;
            }

            // Vérifier et décoder le token
            const decoded = await this.jwtService.verifyToken(token, userType);

            // Identifier le type d'utilisateur et récupérer ses informations
            const userInfo = await this.identifyUser(decoded, userType);

            if (!userInfo) {
                console.log('Utilisateur non trouvé');
                client.disconnect();
                return;
            }

            // Stocker la connexion
            this.connectedUsers.set(client.id, {
                ...userInfo,
                socketId: client.id
            });
            // Rejoindre les rooms
            await this.joinRooms(client, userInfo);
            console.log(`${userInfo.type} ${userInfo.id} connecté`);

        } catch (error) {
            console.error('Erreur de connexion:', error);
            client.disconnect();
        }
    }

    handleDisconnect(client: Socket) {
        const user = this.connectedUsers.get(client.id);
        if (user) {
            console.log(`${user.type} ${user.id} déconnecté`);
            this.connectedUsers.delete(client.id);
        }
    }

    private async identifyUser(decoded: { sub: string }, type: "user" | "customer"): Promise<ConnectedUser | null> {
        if (!decoded.sub) return null;

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

        return null;
    }

    private async joinRooms(client: Socket, userInfo: ConnectedUser) {
        // Rooms par type d'utilisateur
        await client.join(`${userInfo.type}s`);

        // Rooms pour tous les restaurants
        await client.join('restaurants');


        if (userInfo.type === 'customer') {
            // Room spécifique au customer
            await client.join(`customer_${userInfo.id}`);
        } else if (userInfo.type === 'user') {
            // Room spécifique à l'utilisateur
            await client.join(`user_${userInfo.id}`);

            if (userInfo.userType === 'BACKOFFICE') {
                // Backoffice peut voir toutes les données
                await client.join('backoffice_all');
            } else if (userInfo.userType === 'RESTAURANT' && userInfo.restaurantId) {
                // Restaurant ne voit que ses données
                await client.join(`restaurant_${userInfo.restaurantId}`);
            }
        }
    }

    // ================================
    // MÉTHODES D'ÉMISSION GÉNÉRIQUES
    // ================================

    // Émettre à un utilisateur spécifique
    emitToUser<T>(userId: string, userType: 'customer' | 'user', event: string, data: T) {
        const room = userType === 'customer' ? `customer_${userId}` : `user_${userId}`;
        this.server.to(room).emit(event, data);
    }

    // Émettre à tous les backoffice
    emitToBackoffice<T>(event: string, data: T) {
        this.server.to('backoffice_all').emit(event, data);
    }

    // Émettre à un restaurant spécifique
    emitToRestaurant<T>(restaurantId: string, event: string, data: T) {
        this.server.to(`restaurant_${restaurantId}`).emit(event, data);
    }

    // Émettre à tous les utilisateurs d'un type
    emitToUserType<T>(userType: 'customers' | 'users', event: string, data: T) {
        this.server.to(userType).emit(event, data);
    }

    // Broadcast à tous les connectés
    broadcast<T>(event: string, data: T) {
        this.server.emit(event, data);
    }

    @SubscribeMessage('ping')
    handlePing(@ConnectedSocket() client: Socket) {
        const user = this.connectedUsers.get(client.id);
        if (!user) return;
        this.emitToUser(user.id, user.type, 'pong', `pong from ${user.type} ${user.id}`);
    }

    // Getter pour les statistiques
    getConnectedUsers() {
        return this.connectedUsers;
    }

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
}
