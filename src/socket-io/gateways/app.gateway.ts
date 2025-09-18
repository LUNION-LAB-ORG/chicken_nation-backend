import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';
import { EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';
import { ConnectedUser } from '../interfaces/app.gateway.interface';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/app', // Namespace global pour toute l'app
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AppGateway.name);
  @WebSocketServer()
  server: Server;

  private connectedUsers = new Map<string, ConnectedUser>();

  // Map pour tracker qui est en train d'écrire dans quelle conversation
  private typingUsers = new Map<string, Set<string>>(); // conversationId -> Set<userId>
  private typingTimeouts = new Map<string, NodeJS.Timeout>(); // userId -> timeout

  constructor(
    private prisma: PrismaService,
    private jwtService: JsonWebTokenService,
  ) { }

  async handleConnection(client: Socket) {
    try {
      // Récupérer le token depuis les headers
      const token = (client.handshake.query.token as string) || '';

      // Récupérer le type d'utilisateur depuis les query params
      const userType = client.handshake.query.type as 'user' | 'customer';

      if (!token || !userType) {
        this.logger.warn('Connexion refusée: token ou type manquant');
        client.disconnect();
        return;
      }

      // Vérifier et décoder le token
      const decoded = await this.jwtService.verifyToken(token, userType);

      // Identifier le type d'utilisateur et récupérer ses informations
      const userInfo = await this.identifyUser(decoded, userType);

      if (!userInfo) {
        this.logger.warn('Connexion refusée: utilisateur non trouvé ou inactif');
        client.disconnect();
        return;
      }

      // Stocker la connexion
      this.connectedUsers.set(client.id, {
        ...userInfo,
        socketId: client.id,
      });
      // Rejoindre les rooms
      await this.joinRooms(client, userInfo);
      this.logger.log(`Connexion: ${userInfo.type} ${userInfo.id} connecté`);
    } catch (error) {
      this.logger.error('Erreur de connexion:', error);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const user = this.connectedUsers.get(client.id);
    if (user) {
      this.logger.log(`Déconnexion: ${user.type} ${user.id} déconnecté`);
      this.connectedUsers.delete(client.id);

      // Supprimer les typing indicators
      this.cleanupUserTypingOnDisconnect(user.id);
    }
  }

  /**
   * Vérifie si un utilisateur est en ligne (par son id)
   * @param userId ID de l'utilisateur
   * @returns true si l'utilisateur est en ligne, false sinon
   */
  isUserOnline(userId: string): boolean {
    for (const user of this.connectedUsers.values()) {
      if (user.id === userId) {
        return true;
      }
    }
    return false;
  }

  private async identifyUser(
    decoded: { sub: string },
    type: 'user' | 'customer',
  ): Promise<ConnectedUser | null> {
    if (!decoded.sub) return null;

    if (type === 'customer') {
      const customer = await this.prisma.customer.findUnique({
        where: { id: decoded.sub, entity_status: EntityStatus.ACTIVE },
      });

      if (customer) {
        return {
          id: customer.id,
          type: 'customer',
          socketId: '',
        };
      }
    } else if (type === 'user') {
      const user = await this.prisma.user.findUnique({
        where: { id: decoded.sub, entity_status: EntityStatus.ACTIVE },
        include: { restaurant: true },
      });

      if (user) {
        return {
          id: user.id,
          type: 'user',
          userType: user.type,
          restaurantId: user.restaurant_id ?? undefined,
          socketId: '',
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
  emitToUser<T>(
    userId: string,
    userType: 'customer' | 'user',
    event: string,
    data: T,
  ) {
    const room =
      userType === 'customer' ? `customer_${userId}` : `user_${userId}`;
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

  // Emettre dans un ticket
  emitToTicket<T>(ticketId: string, event: string, data: T) {
    this.server.to(`ticket_${ticketId}`).emit(event, data);
  }

  // Broadcast à tous les connectés
  broadcast<T>(event: string, data: T) {
    this.server.emit(event, data);
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    const user = this.connectedUsers.get(client.id);
    if (!user) return;
    this.emitToUser(
      user.id,
      user.type,
      'pong',
      `pong from ${user.type} ${user.id}`,
    );
  }

  @SubscribeMessage('user_typing_start')
  handleUserTypingStart(
    @MessageBody() data: { conversationId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const user = this.connectedUsers.get(client.id);
    if (!user) return;

    this.notifyUserTyping(data.conversationId, user.id, user.type, true);
  }

  @SubscribeMessage('user_typing_stop')
  handleUserTypingStop(
    @MessageBody() data: { conversationId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const user = this.connectedUsers.get(client.id);
    if (!user) return;

    this.notifyUserTyping(data.conversationId, user.id, user.type, false);
  }

  /**
   * Gère les indicateurs "X est en train d'écrire..."
   */
  notifyUserTyping(
    conversationId: string,
    userId: string,
    userType: 'user' | 'customer',
    isTyping: boolean,
    userName?: string,
  ) {
    try {
      const typingKey = `${userId}_${conversationId}`;

      if (isTyping) {
        // Ajouter l'utilisateur à la liste des "en train d'écrire"
        if (!this.typingUsers.has(conversationId)) {
          this.typingUsers.set(conversationId, new Set());
        }
        this.typingUsers.get(conversationId)!.add(userId);

        // Effacer le timeout précédent s'il existe
        if (this.typingTimeouts.has(typingKey)) {
          clearTimeout(this.typingTimeouts.get(typingKey)!);
        }

        // Auto-stop après 3 secondes d'inactivité
        const timeout = setTimeout(() => {
          this.notifyUserTyping(
            conversationId,
            userId,
            userType,
            false,
            userName,
          );
        }, 3000);

        this.typingTimeouts.set(typingKey, timeout);
      } else {
        // Retirer l'utilisateur de la liste
        if (this.typingUsers.has(conversationId)) {
          this.typingUsers.get(conversationId)!.delete(userId);

          // Supprimer la conversation si plus personne n'écrit
          if (this.typingUsers.get(conversationId)!.size === 0) {
            this.typingUsers.delete(conversationId);
          }
        }

        // Effacer le timeout
        if (this.typingTimeouts.has(typingKey)) {
          clearTimeout(this.typingTimeouts.get(typingKey)!);
          this.typingTimeouts.delete(typingKey);
        }
      }

      // Préparer la liste des utilisateurs en train d'écrire
      const typingUsersList = this.typingUsers.get(conversationId) || new Set();

      // Émettre à tous les participants SAUF à celui qui écrit
      this.server
        .to(`conversation_${conversationId}`)
        .except(
          // Trouver le socketId de l'utilisateur qui écrit
          Array.from(this.connectedUsers.entries())
            .filter(([, connectedUser]) => connectedUser.id === userId)
            .map(([socketId]) => socketId),
        )
        .emit('typing_indicator', {
          conversationId,
          typingUsers: Array.from(typingUsersList).filter(
            (id) => id !== userId,
          ),
          isTyping: typingUsersList.size > 0,
          userName: userName || `${userType} ${userId}`,
        });

      this.logger.log(`Typing indicator: ${userId} ${isTyping ? 'started' : 'stopped'} typing in ${conversationId}`);
        
    } catch (error) {
      this.logger.error('Error handling typing indicator:', error);
    }
  }

  /**
   * Nettoie les indicateurs de frappe quand un utilisateur se déconnecte
   * @param userId
   */
  private cleanupUserTypingOnDisconnect(userId: string) {
    // Parcourir toutes les conversations où cet utilisateur était en train d'écrire
    this.typingUsers.forEach((typingUsersSet, conversationId) => {
      if (typingUsersSet.has(userId)) {
        this.notifyUserTyping(conversationId, userId, 'user', false);
      }
    });

    // Nettoyer les timeouts de cet utilisateur
    Array.from(this.typingTimeouts.keys())
      .filter((key) => key.startsWith(`${userId}_`))
      .forEach((key) => {
        clearTimeout(this.typingTimeouts.get(key)!);
        this.typingTimeouts.delete(key);
      });
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
      restaurants: new Map<string, number>(),
    };

    this.connectedUsers.forEach((user) => {
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
