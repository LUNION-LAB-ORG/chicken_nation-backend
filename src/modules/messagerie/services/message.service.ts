import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Customer, User } from '@prisma/client';
import type { Request } from 'express';
import { QueryResponseDto } from '../../../common/dto/query-response.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateMessageDto } from '../dto/createMessageDto';
import { QueryMessagesDto } from '../dto/query-messages.dto';
import { ResponseMessageDto } from '../dto/response-message.dto';
import { getAuthType } from '../utils/getTypeUser';
import {
  TAILLE_MAX_AUDIO,
  TAILLE_MAX_IMAGE,
  verifierTaille,
} from '../utils/pieces-jointes';
import { MessageWebSocketService } from '../websockets/message-websocket.service';
import { ConversationsService } from './conversations.service';
import { S3Service } from '../../../s3/s3.service';
import { ExpoPushService } from '../../../expo-push/expo-push.service';
import { NotificationsSenderService } from '../../notifications/services/notifications-sender.service';

@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);
  private readonly isDev = process.env.NODE_ENV !== 'production';

  /**
   * Fenêtre anti-doublon pour les messages texte identiques consécutifs (ms).
   * Filet de sécurité serveur contre les double-taps et les anciennes versions de
   * l'app mobile qui pouvaient renvoyer le même message en boucle.
   */
  private static readonly DUPLICATE_WINDOW_MS = 10_000;

  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly prismaService: PrismaService,
    private readonly messageWebSocketService: MessageWebSocketService,
    private readonly s3service: S3Service,
    private readonly expoPushService: ExpoPushService,
    private readonly notificationsSenderService: NotificationsSenderService,
  ) { }

  /**
   * Note vocale envoyée vers un dossier DEDIE.
   *
   * Séparé des images à dessein : les durées de conservation, les tailles et
   * les règles de cache n'ont aucune raison d'être les mêmes, et un dossier
   * commun rendrait tout tri ultérieur impossible.
   */
  private async uploadAudio(audio?: Express.Multer.File) {
    if (!audio) return null;
    return await this.s3service.uploadFile({
      buffer: audio.buffer,
      path: 'chicken-nation/messagerie-audio',
      originalname: audio.originalname,
      mimetype: audio.mimetype,
    });
  }

  private async uploadImage(image?: Express.Multer.File) {
    if (!image) return null;
    return await this.s3service.uploadFile({
      buffer: image.buffer,
      path: 'chicken-nation/messagerie',
      originalname: image.originalname,
      mimetype: image.mimetype,
    });
  }

  async getMessages(
    req: Request,
    conversationId: string,
    filter: QueryMessagesDto,
  ): Promise<QueryResponseDto<ResponseMessageDto>> {
    this.logger.log(`Récupération des messages de la conversation ${conversationId} (page=${filter.page ?? 1}, limit=${filter.limit ?? 10})`);
    const { limit = 10, page = 1 } = filter;
    const skip = (page - 1) * limit;

    // Validate the conversationId
    const conversation = await this.conversationsService.getConversationById(
      req,
      conversationId,
    );

    if (this.isDev) {
      this.logger.debug(`Conversation trouvée: ${JSON.stringify(conversation)}`);
    }

    // If the conversation does not exist, throw an error
    if (!conversation) {
      this.logger.warn(`Conversation ${conversationId} introuvable`);
      throw new NotFoundException('Conversation not found');
    }

    const whereClause: any = {
      conversationId: conversation.id,
    };

    // Fetch messages for the conversation with pagination
    const [messages, total] = await Promise.all([
      this.prismaService.message.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: {
          createdAt: 'desc',
        },
        include: {
          authorUser: true, // Include user details if needed
          authorCustomer: true, // Include customer details if needed
          conversation: {
            select: {
              customerId: true,
              restaurantId: true,
            }
          }
        },
      }),
      this.prismaService.message.count({
        where: whereClause,
      }),
    ]);

    if (this.isDev) {
      this.logger.debug(`Messages bruts: ${JSON.stringify(messages)}`);
    }

    if (messages.length === 0) {
      this.logger.warn(`Aucun message trouvé pour la conversation ${conversationId}`);
    }

    this.logger.log(`Messages récupérés: ${messages.length}/${total}`);

    // Map the messages to the ResponseMessageDto format
    const mappedMessages = messages.map((message) =>
      this.mapMessagesField(message),
    );

    if (this.isDev) {
      this.logger.debug(`Messages mappés: ${JSON.stringify(mappedMessages)}`);
    }

    /**
     * ⚠️ L'ouverture d'une conversation par le CLIENT vaut lecture.
     *
     * L'application installée ne prévient jamais le serveur qu'un message est
     * lu : elle n'écrit que dans le stockage local du téléphone, et la route
     * prévue pour cela n'est appelée par personne. Conséquence visible par tous
     * les clients : leur badge de messages non lus ne retombait à zéro que si
     * un agent du backoffice ouvrait la conversation par hasard.
     *
     * Le seul signal dont on dispose sans livrer une nouvelle version est
     * celui-ci : le téléphone réclame les messages, donc l'écran est ouvert.
     *
     * Vocabulaire honnête : cela signifie « le client a ouvert la
     * conversation », pas « il a lu ce message précis ».
     *
     * Ecriture NON BLOQUANTE et erreur avalée : une lecture ne doit jamais
     * échouer parce qu'un marquage a échoué.
     */
    if (req.user && getAuthType(req.user) === 'customer') {
      void this.markMessagesAsRead(
        conversation.id,
        'CUSTOMER',
        (req.user as Customer).id,
      ).catch((e) =>
        this.logger.warn(
          `Marquage de lecture ignoré pour la conversation ${conversation.id} : ${e?.message}`,
        ),
      );
    }

    // Return the paginated response
    return {
      data: mappedMessages,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async createMessage(
    req: Request,
    conversationId: string,
    createMessageDto: CreateMessageDto,
    image?: Express.Multer.File,
    audio?: Express.Multer.File,
  ): Promise<ResponseMessageDto> {

    this.logger.debug(`createMessageDto: ${JSON.stringify(createMessageDto)}, conversation ${conversationId}`);

    // Validate the message content : texte OU image (les messages "image seule"
    // sont autorisés ; body est alors stocké vide).
    const {
      imageUrl = '',
      orderId = null,
      audioUrl = '',
      audioDurationMs = null,
    } = createMessageDto;
    const body = createMessageDto.body?.trim() ?? '';
    // ⚠️ Une note vocale se suffit à elle même : sans ce cas, un vocal sans
    // texte serait refusé.
    if (!body && !image && !imageUrl && !audio && !audioUrl) {
      throw new HttpException(
        'Message body, image or audio is required',
        HttpStatus.BAD_REQUEST
      );
    }

    verifierTaille(image, TAILLE_MAX_IMAGE, 'Image');
    verifierTaille(audio, TAILLE_MAX_AUDIO, 'Message vocal');

    if (this.isDev) {
      this.logger.debug(`Message body validé: ${body}`);
    }

    const auth = req.user!;

    const authType = getAuthType(auth);

    // Validate the conversationId
    const conversation = await this.conversationsService.getConversationById(
      req,
      conversationId,
    );

    // If the conversation does not exist, throw an error
    if (!conversation) {
      throw new HttpException('Conversation not found', HttpStatus.NOT_FOUND);
    }

    // 🛡️ Garde anti-doublon (filet de sécurité serveur, indépendant de la version app)
    // Si un message TEXTE identique du même auteur a déjà été créé dans la même
    // conversation il y a moins de DUPLICATE_WINDOW_MS, on ne recrée rien : on renvoie
    // le message existant SANS re-broadcaster ni re-notifier. On ne dédoublonne que le
    // texte pur (pas d'image, pas de commande liée) pour ne jamais perdre un envoi légitime.
    const authorId =
      authType === 'user' ? (auth as User).id : (auth as Customer).id;

    // ⚠️ L'AUDIO désactive aussi la déduplication, au même titre que l'image.
    // Il avait été oublié à l'ouverture de la vanne des notes vocales : deux
    // notes vocales portant le même texte, envoyées à moins de dix secondes
    // d'intervalle, voyaient la seconde avalée en silence.
    if (!image && !imageUrl && !orderId && !audio && !audioUrl) {
      const recentDuplicate = await this.prismaService.message.findFirst({
        where: {
          conversationId: conversation.id,
          body,
          ...(authType === 'user'
            ? { authorUserId: authorId }
            : { authorCustomerId: authorId }),
          createdAt: {
            gte: new Date(Date.now() - MessageService.DUPLICATE_WINDOW_MS),
          },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          authorUser: true,
          authorCustomer: true,
          conversation: {
            select: { id: true, customerId: true, restaurantId: true },
          },
        },
      });

      if (recentDuplicate) {
        this.logger.warn(
          `Doublon ignoré (conversation ${conversation.id}, auteur ${authorId}): message texte identique créé il y a moins de ${MessageService.DUPLICATE_WINDOW_MS}ms`,
        );
        return this.mapMessagesField(recentDuplicate);
      }
    }

    // Upload image to S3 if provided
    const uploadResult = await this.uploadImage(image);
    const finalImageUrl = uploadResult?.key ?? imageUrl;
    const uploadAudioResult = await this.uploadAudio(audio);
    const finalAudioUrl = uploadAudioResult?.key ?? audioUrl;

    /**
     * ⚠️ Un envoi de pièce jointe qui échoue doit ECHOUER, visiblement.
     *
     * `S3Service.uploadFile` avale ses exceptions et rend `null`. Sans ce
     * contrôle, une panne de stockage produisait un message au corps vide et
     * sans pièce jointe, créé en base, renvoyé en 200, notifié au client, et
     * affiché comme une bulle vide : l'agent croyait avoir envoyé sa photo ou
     * sa note vocale, le client ne recevait rien d'exploitable, et rien nulle
     * part ne signalait le problème.
     *
     * Mieux vaut un envoi en erreur, que l'agent peut refaire, qu'un message
     * vide livré et notifié.
     */
    if (image && !uploadResult?.key) {
      throw new HttpException(
        "L'image n'a pas pu être envoyée vers le stockage. Réessayez.",
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (audio && !uploadAudioResult?.key) {
      throw new HttpException(
        "La note vocale n'a pas pu être envoyée vers le stockage. Réessayez.",
        HttpStatus.BAD_GATEWAY,
      );
    }

    // verifier que la commande appartient bien au client de la conversation
    if (orderId) {
      const order = await this.prismaService.order.findUnique({
        where: { id: orderId },
      });
      if (!order) {
        throw new HttpException('Order not found', HttpStatus.NOT_FOUND);
      }
      if (order.customer_id !== conversation.customerId) {
        this.logger.warn(`Commande ${orderId} n'appartient pas au client ${conversation.customerId} de la conversation ${conversationId}`);
        throw new HttpException('Order does not belong to the customer of the conversation', HttpStatus.FORBIDDEN);
      }
      if (this.isDev) {
        this.logger.debug(`Commande validée: ${JSON.stringify(order)}, pour le client ${conversation.customerId}, conversation ${conversationId}`);
      }
    }

    // Create a new message in the database
    const message = await this.prismaService.message.create({
      data: {
        /**
         * ⚠️ Corps de REPLI quand seule une pièce jointe est envoyée.
         *
         * L'app reconstruit le message reçu par socket sans recopier `meta`,
         * puis le jette si le corps est vide : une photo envoyée par un agent
         * n'apparaissait donc PAS en direct chez le client, et l'aperçu de la
         * conversation restait vide. Le mot apparaîtra sous l'image dans la
         * bulle : c'est le prix d'un message qui arrive au lieu d'un message
         * qui disparaît.
         */
        body: body || (finalAudioUrl ? 'Message vocal' : finalImageUrl ? 'Photo' : body),
        conversationId: conversation.id,
        authorUserId: authType === 'user' ? (auth as User).id : null, // Set user ID if authenticated as user
        authorCustomerId:
          authType === 'customer' ? (auth as Customer).id : null, // Set customer ID if authenticated as customer
        /**
         * ⚠️ `meta` est ECRASE en entier à chaque création. Toute nouvelle clé
         * doit donc figurer ici, sans quoi elle disparaît silencieusement.
         */
        meta: {
          imageUrl: finalImageUrl || null,
          orderId: orderId,
          audioUrl: finalAudioUrl || null,
          audioDurationMs: audioDurationMs ?? null,
        }
      },
      include: {
        authorUser: true,
        authorCustomer: true,
        conversation: {
          select: {
            id: true,
            customerId: true,
            restaurantId: true,
            users: {
              select: { userId: true },
            },
          },
        },
      },
    });

    await this.prismaService.conversation.update({
      where: {
        id: conversation.id,
      },
      data: {
        updatedAt: new Date(),
        /**
         * ⚠️ Première réponse du CLIENT dans un canal de diffusion : la
         * conversation cesse d'être une diffusion muette et redevient un
         * échange ordinaire.
         *
         * C'est ce seul drapeau qui la fait réapparaître dans la boîte de
         * réception du backoffice, laquelle écarte les diffusions sans réponse
         * (voir `getUserConversations`). Sans lui, un client pourrait répondre
         * à une promotion et n'obtenir jamais de réponse, sa question restant
         * invisible du service client.
         *
         * Volontairement à sens unique : une conversation qui a servi ne
         * retourne pas au silence.
         */
        ...(authType === 'customer' ? { hasReply: true } : {}),
      },
    });

    // Ajouter l'utilisateur à la conversation s'il n'y est pas déjà
    if (authType === 'user') {
      try {
        await this.prismaService.conversationUser.upsert({
          where: {
            conversationId_userId: {
              conversationId: conversation.id,
              userId: (auth as User).id,
            },
          },
          update: {},
          create: {
            conversationId: conversation.id,
            userId: (auth as User).id,
          },
        });
      } catch (error) {
        this.logger.warn(
          `Impossible d'ajouter l'utilisateur ${(auth as User).id} à la conversation ${conversation.id}: ${error.message}`,
        );
      }
    }

    const mappedMessage = this.mapMessagesField(message);

    // Liste des utilisateurs participant à la conversation
    const usersId = message.conversation.users.map(
      (conversationUser) => conversationUser.userId,
    );

    const { customerId, restaurantId } = message.conversation;

    this.messageWebSocketService.emitNewMessage(
      usersId,
      { restaurantId, customerId },
      mappedMessage,
    );

    // Envoyer une push notification au client si le message vient du staff
    if (authType === 'user' && customerId) {
      this.sendPushToCustomer(customerId, mappedMessage, restaurantId).catch((err) =>
        this.logger.warn(`Push notification échouée: ${err.message}`),
      );
    }

    // Notifier le STAFF (cloche in-app + email) quand le message vient d'un CLIENT
    // (sens ENTRANT). Non bloquant ; filtré par préférence côté sender.
    if (authType === 'customer') {
      this.notificationsSenderService
        .notifyStaffNewMessage({
          conversationId: message.conversationId,
          restaurantId,
          customerId,
          preview: mappedMessage.body ?? '',
        })
        .catch((err) =>
          this.logger.warn(`Notif staff « nouveau message » échouée: ${err.message}`),
        );
    }

    // Map the created message to ResponseMessageDto format
    return mappedMessage;
  }

  async markMessagesAsRead(conversationId: string, type: 'USER' | 'CUSTOMER', authorId: string): Promise<boolean> {
    this.logger.log(
      `Marquer comme lus les messages de la conversation ${conversationId} (lecteur ${type} ${authorId})`,
    );
    const conversation = await this.prismaService.conversation.findUnique({
      where: { id: conversationId },
      include: {
        users: true
      }
    });

    if (!conversation) {
      this.logger.warn(`Conversation ${conversationId} introuvable`);
      throw new NotFoundException('Conversation not found');
    }

    /**
     * ⚠️ La route de marquage client ne vérifiait PAS à qui appartient la
     * conversation.
     *
     * Le chemin de lecture est protégé, lui, car il passe par
     * `getConversationById` qui restreint au client propriétaire. Mais la route
     * dédiée appelle ce service directement : n'importe quel client authentifié
     * pouvait donc, avec un identifiant de conversation, blanchir les messages
     * d'un autre et éteindre son badge.
     *
     * On répond « introuvable » plutôt que « interdit », pour ne pas confirmer
     * l'existence de la conversation à qui la cherche.
     */
    if (type === 'CUSTOMER' && conversation.customerId !== authorId) {
      this.logger.warn(
        `Marquage refusé : le client ${authorId} n'est pas propriétaire de la conversation ${conversationId}`,
      );
      throw new NotFoundException('Conversation not found');
    }

    /**
     * ⚠️ On vise les messages de l'AUTRE partie, pas « ceux que je n'ai pas
     * écrits ».
     *
     * L'ancien filtre était `authorUserId != moi`. Entre agents, l'agent B
     * blanchissait donc les messages de l'agent A, et le compteur du client
     * dépendait de qui avait ouvert quoi. On raisonne désormais par camp :
     * quand le client lit, ce sont les messages du personnel qui deviennent
     * lus ; quand le personnel lit, ce sont ceux du client. Le test porte sur
     * la NULLITE de l'auteur, sans dépendre de la façon dont Prisma traite
     * `not` face à une colonne nulle.
     */
    const { count } = await this.prismaService.message.updateMany({
      where: {
        conversationId,
        isRead: false,
        ...(type === 'USER'
          ? { authorCustomerId: { not: null }, broadcastId: null }
          : {
              // ⚠️ Une diffusion n'a AUCUN auteur : sans ce second cas, elle
              // resterait non lue pour toujours et le badge du client ne
              // retomberait jamais. Cet ensemble DOIT rester identique à celui
              // que compte `countUnreadMessages`.
              OR: [{ authorUserId: { not: null } }, { broadcastId: { not: null } }],
            }),
      },
      data: { isRead: true, readAt: new Date() },
    });

    /**
     * ⚠️ On n'émet QUE si quelque chose a réellement changé.
     *
     * Le téléphone recharge la conversation à chaque retour au premier plan.
     * Sans cette condition, chaque retour ferait invalider les caches du
     * backoffice en boucle pour rien.
     *
     * Et on se tait sur une diffusion sans réponse : une campagne crée une
     * conversation par client, mille ouvertures produiraient mille évènements
     * vers un backoffice qui n'affiche même pas ces conversations. Dès que le
     * client répond, la conversation redevient ordinaire et l'agent reçoit
     * bien l'accusé.
     */
    const diffusionMuette = conversation.isBroadcast && !conversation.hasReply;
    if (count > 0 && !diffusionMuette) {
      this.messageWebSocketService.emitMessagesRead(conversation);
    }

    return true;
  }

  /**
   * Envoie une push notification Expo au client d'une conversation
   */
  private async sendPushToCustomer(customerId: string, message: ResponseMessageDto, restaurantId?: string | null) {
    const [settings, restaurant] = await Promise.all([
      this.prismaService.notificationSetting.findUnique({
        where: { customer_id: customerId },
      }),
      restaurantId
        ? this.prismaService.restaurant.findUnique({
            where: { id: restaurantId },
            select: { name: true },
          })
        : null,
    ]);

    if (!settings?.expo_push_token || !settings.push || !settings.active) return;

    const senderName = restaurant?.name || message.authorUser?.name || message.authorUser?.email || 'Chicken Nation';

    await this.expoPushService.sendPushNotifications({
      tokens: [settings.expo_push_token],
      title: senderName,
      body: message.body?.substring(0, 150) || 'Nouveau message',
      sound: 'default',
      data: {
        // ⚠️ `new_message` ne correspond à AUCUN cas du routeur de l'app : le
        // client touchait la notification et atterrissait sur l'accueil.
        // `message` est le type que le routeur sait traiter.
        type: 'message',
        conversationId: message.conversation?.id || '',
        messageId: message.id,
      },
    });
  }

  private mapMessagesField(message: any): ResponseMessageDto {
    if (this.isDev) {
      this.logger.debug(`Mapping du message: ${JSON.stringify(message)}`);
    }
    return {
      id: message.id,
      conversation: {
        id: message.conversationId,
        restaurantId: message.conversation?.restaurantId,
        customerId: message.conversation?.customerId,
      },
      meta: message.meta || {},
      body: message.body,
      isRead: message.isRead,
      // Heure de lecture, pour l'accusé affiché sous la bulle.
      readAt: message.readAt ?? null,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      authorUser: message.authorUser
        ? {
          id: message.authorUser.id,
          name: message.authorUser.fullname,
          email: message.authorUser.email,
          image: message.authorUser.image || null,
        }
        : null,
      authorCustomer: message.authorCustomer
        ? {
          id: message.authorCustomer.id,
          name:
            message.authorCustomer.first_name +
            ' ' +
            message.authorCustomer.last_name,
          first_name: message.authorCustomer.first_name || null,
          last_name: message.authorCustomer.last_name || null,
          image: message.authorCustomer.image || null,
        }
        : null,
    };
  }
}
