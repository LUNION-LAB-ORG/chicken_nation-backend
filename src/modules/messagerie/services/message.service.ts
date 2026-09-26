import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Customer, User, UserRole } from '@prisma/client';
import type { Request } from 'express';
import { QueryResponseDto } from '../../../common/dto/query-response.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateMessageDto } from '../dto/createMessageDto';
import { QueryMessagesDto } from '../dto/query-messages.dto';
import { ResponseMessageDto } from '../dto/response-message.dto';
import { getAuthType } from '../utils/getTypeUser';
import {
  resumerCitation,
  SELECT_CITATION,
  SELECT_MENTIONS,
  versionClient,
  type Lecteur,
} from '../utils/citation';
import { estMentionnable, resoudreMentions } from '../utils/mentions';
import { CORPS_MESSAGE_SUPPRIME } from 'src/common/constantes/message-supprime';
import {
  agregerReactions,
  estEmojiAutorise,
  EMOJIS_REACTION,
  type ReactionAgregee,
} from 'src/common/constantes/emojis-reaction';
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
import { AuditService } from 'src/modules/audit/audit.service';

/**
 * Citation et mentions : à joindre à TOUTE lecture qui passe par
 * `mapMessagesField`. Deux requêtes groupées par page (clé primaire et index
 * unique), pas une par message.
 */
const INCLURE_REPONSE_ET_MENTIONS = {
  replyTo: SELECT_CITATION,
  mentions: SELECT_MENTIONS,
} as const;

/** Nom montré dans la notification d'une conversation interne sans sujet. */
const LIBELLE_DISCUSSION_PRIVEE = 'Discussion privée';

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
    private readonly auditService: AuditService,
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
        /**
         * Départage par identifiant : deux messages de la même milliseconde
         * (alertes postées en rafale) gardent toujours le même ordre, sans quoi
         * la pagination par décalage pourrait sauter l'un et doubler l'autre.
         * La route de position compte avec exactement le même ordre.
         */
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          authorUser: true, // Include user details if needed
          authorCustomer: true, // Include customer details if needed
          // Réactions : agrégées au mapping, jamais renvoyées nominativement.
          reactions: { select: { emoji: true, userId: true, customerId: true } },
          ...INCLURE_REPONSE_ET_MENTIONS,
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
    // `mine` dépend du lecteur : on le lui passe, sinon toutes les pastilles
    // paraîtraient posées par quelqu'un d'autre.
    const monId = (req.user as User | Customer | undefined)?.id ?? null;
    // Le client ne voit ni le nom de l'agent cité, ni les mentions internes.
    const lecteur: Lecteur = req.user ? getAuthType(req.user) : 'user';
    const mappedMessages = messages.map((message) =>
      this.mapMessagesField(message, monId, lecteur),
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

    const authorId =
      authType === 'user' ? (auth as User).id : (auth as Customer).id;

    /**
     * RÉPONSE À UN MESSAGE PRÉCIS.
     *
     * Le message cité doit appartenir à CETTE conversation : sinon, connaître
     * un seul identifiant suffirait à faire afficher l'extrait d'une
     * conversation qu'on ne peut pas lire. On répond « introuvable », comme
     * pour les réactions, sans rien confirmer à qui cherche. On ne répond pas
     * à un message retiré : son contenu n'est plus servi.
     */
    const replyToId = createMessageDto.replyToId ?? null;
    let auteurCiteId: string | null = null;
    if (replyToId) {
      const cite = await this.prismaService.message.findFirst({
        where: { id: replyToId, conversationId: conversation.id },
        select: { id: true, deletedAt: true, authorUserId: true },
      });
      if (!cite) {
        throw new NotFoundException('Message cité introuvable');
      }
      if (cite.deletedAt) {
        throw new BadRequestException(
          'Impossible de répondre à un message supprimé',
        );
      }
      auteurCiteId = cite.authorUserId ?? null;
    }

    /**
     * MENTIONS : personnel seulement, conversations internes seulement, vers
     * des membres actifs ayant accès à la messagerie, dont le « @Nom » figure
     * dans le texte. Les autres identifiants sont ignorés sans faire échouer
     * l'envoi ; la réponse dit ce qui a réellement été retenu.
     */
    const mentionsRetenues = await resoudreMentions(this.prismaService, {
      conversation,
      authType,
      auteurId: authorId,
      body,
      ids: createMessageDto.mentionUserIds,
    });

    // 🛡️ Garde anti-doublon (filet de sécurité serveur, indépendant de la version app)
    // Si un message TEXTE identique du même auteur a déjà été créé dans la même
    // conversation il y a moins de DUPLICATE_WINDOW_MS, on ne recrée rien : on renvoie
    // le message existant SANS re-broadcaster ni re-notifier. On ne dédoublonne que le
    // texte pur (pas d'image, pas de commande liée) pour ne jamais perdre un envoi légitime.
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
          /**
           * ⚠️ Même texte ne veut pas dire même message quand il RÉPOND à
           * autre chose : deux « OK » envoyés en réponse à deux messages
           * différents sont deux messages. Sans ce critère, le second était
           * avalé et le premier renvoyé à sa place.
           */
          replyToId,
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
          ...INCLURE_REPONSE_ET_MENTIONS,
        },
      });

      if (recentDuplicate) {
        this.logger.warn(
          `Doublon ignoré (conversation ${conversation.id}, auteur ${authorId}): message texte identique créé il y a moins de ${MessageService.DUPLICATE_WINDOW_MS}ms`,
        );
        return this.mapMessagesField(recentDuplicate, authorId, authType);
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
        },
        replyToId,
        /**
         * Mentions écrites DANS la même requête que le message : Prisma les
         * enchaîne en une transaction. Pas de message sans ses mentions, ni de
         * mention orpheline si l'écriture échoue.
         */
        ...(mentionsRetenues.length > 0
          ? {
              mentions: {
                create: mentionsRetenues.map((m) => ({
                  userId: m.userId,
                  libelle: m.label,
                })),
              },
            }
          : {}),
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
        ...INCLURE_REPONSE_ET_MENTIONS,
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

    /**
     * Ajouter l'auteur à la conversation s'il n'y est pas déjà — UNIQUEMENT
     * pour les conversations CLIENT.
     *
     * C'est voulu là : le service client est une boîte partagée, l'agent qui
     * prend la main rejoint le fil. Ça ne l'est pas du tout sur une
     * conversation INTERNE : écrire suffirait alors à s'inviter dans un groupe
     * privé, définitivement, et la règle qui réserve la création d'un groupe
     * aux responsables ne vaudrait plus rien. Dans une conversation interne, on
     * est membre parce qu'on y a été mis, pas parce qu'on y a parlé.
     */
    if (authType === 'user' && conversation.customerId) {
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

    /**
     * Entre COLLÈGUES (conversation interne) : la personne mentionnée, et
     * l'auteur du message auquel on répond, sont prévenus nommément (cloche et
     * socket personnel). Non bloquant : une notification ratée ne doit jamais
     * faire échouer un envoi déjà écrit et diffusé.
     */
    if (authType === 'user' && !customerId) {
      this.notifierMentionsEtReponse({
        conversationId: message.conversationId,
        messageId: message.id,
        restaurantId,
        libelleConversation:
          conversation.subject?.trim() || LIBELLE_DISCUSSION_PRIVEE,
        auteurId: authorId,
        auteurNom: (auth as User).fullname ?? '',
        extrait: mappedMessage.body ?? '',
        mentionnes: mentionsRetenues.map((m) => m.userId),
        auteurCiteId,
      }).catch((err) =>
        this.logger.warn(
          `Notification de mention ou de réponse échouée : ${err?.message}`,
        ),
      );
    }

    // Le client qui écrit reçoit SA version : ni nom d'agent cité, ni mentions.
    return authType === 'customer' ? versionClient(mappedMessage) : mappedMessage;
  }

  /**
   * Prévient les personnes MENTIONNÉES, puis l'auteur du message CITÉ s'il
   * n'est pas déjà du nombre (réponse implicite). L'auteur du message cité
   * n'est prévenu que s'il est employé, différent de celui qui répond, encore
   * membre de la conversation et éligible (compte actif, accès à la
   * messagerie). Une réponse à une alerte ne prévient personne : elle n'a pas
   * d'auteur.
   */
  private async notifierMentionsEtReponse(p: {
    conversationId: string;
    messageId: string;
    restaurantId: string | null;
    libelleConversation: string;
    auteurId: string;
    auteurNom: string;
    extrait: string;
    mentionnes: string[];
    auteurCiteId: string | null;
  }): Promise<void> {
    const commun = {
      auteurNom: p.auteurNom,
      conversationId: p.conversationId,
      messageId: p.messageId,
      restaurantId: p.restaurantId,
      libelleConversation: p.libelleConversation,
      extrait: p.extrait,
    };

    if (p.mentionnes.length > 0) {
      await this.notificationsSenderService.notifyStaffMention({
        ...commun,
        motif: 'mention',
        userIds: p.mentionnes,
      });
    }

    const cite = p.auteurCiteId;
    if (!cite || cite === p.auteurId || p.mentionnes.includes(cite)) return;

    const participation = await this.prismaService.conversationUser.findUnique({
      where: {
        conversationId_userId: { conversationId: p.conversationId, userId: cite },
      },
      select: { user: { select: { role: true, entity_status: true } } },
    });
    if (!participation || !estMentionnable(participation.user)) return;

    await this.notificationsSenderService.notifyStaffMention({
      ...commun,
      motif: 'reponse',
      userIds: [cite],
    });
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
     * POSITION DE LECTURE DU LECTEUR, pour les conversations internes.
     *
     * Le `updateMany` ci-dessus blanchit des MESSAGES : dans un groupe, il
     * éteindrait la pastille de tous les membres d'un coup. C'est pourquoi il
     * ne vise, côté personnel, que les messages du client — il ne touche donc
     * rien dans une conversation interne. La lecture d'un agent s'enregistre
     * ici, sur SA ligne de participation et sur elle seule : ouvrir la
     * conversation n'a aucun effet sur l'état de ses collègues.
     *
     * Écrit systématiquement, même quand `count` vaut zéro : dans un groupe,
     * `count` est toujours zéro, et c'est pourtant là que la date compte.
     */
    let lectureInterneEnregistree = false;
    if (type === 'USER' && !conversation.customerId) {
      const participation = await this.prismaService.conversationUser.findUnique({
        where: { conversationId_userId: { conversationId, userId: authorId } },
        select: { lastReadAt: true },
      });
      if (participation) {
        /**
         * ⚠️ On ne date la lecture QUE s'il y avait réellement quelque chose à
         * lire. `updateMany` renvoie le nombre de lignes TROUVÉES, or la ligne
         * de participation existe toujours : s'y fier ferait partir un accusé
         * de lecture à tous les membres du groupe à CHAQUE ouverture de
         * l'écran, y compris quand rien n'a bougé, et déclencherait autant de
         * rafraîchissements inutiles chez chacun.
         */
        const nouveaux = await this.prismaService.message.count({
          where: {
            conversationId,
            // Même ensemble que `compterNonLusInternes`, messages SYSTÈME (sans
            // auteur) compris : les deux doivent viser exactement la même chose,
            // sinon une pastille reste allumée sans rien à lire.
            OR: [{ authorUserId: null }, { authorUserId: { not: authorId } }],
            ...(participation.lastReadAt
              ? { createdAt: { gt: participation.lastReadAt } }
              : {}),
          },
        });
        if (nouveaux > 0) {
          await this.prismaService.conversationUser.update({
            where: { conversationId_userId: { conversationId, userId: authorId } },
            data: { lastReadAt: new Date() },
          });
          lectureInterneEnregistree = true;
        }
      }
    }

    /**
     * Ouvrir une conversation INTERNE vaut lecture de ses notifications de
     * mention et de réponse pour ce lecteur. Non bloquant.
     */
    if (type === 'USER' && !conversation.customerId) {
      void this.notificationsSenderService
        .marquerNotificationsConversationLues({ userId: authorId, conversationId })
        .catch((e) =>
          this.logger.warn(
            `Notifications de mention non marquées lues (${conversationId}) : ${e?.message}`,
          ),
        );
    }

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
    // `count` reste à zéro dans une conversation interne (rien à blanchir) :
    // sans ce second cas, aucun accusé ne partirait jamais d'un groupe.
    if ((count > 0 || lectureInterneEnregistree) && !diffusionMuette) {
      this.messageWebSocketService.emitMessagesRead(
        conversation,
        type === 'USER' ? 'user' : 'customer',
      );
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

  /**
   * `monId` : qui lit. Indispensable pour `mine` sur les réactions, qui dépend
   * du lecteur et non du message. Absent, tout est simplement à `false`.
   *
   * `lecteur` : employé ou client. Le client ne voit ni le nom de l'agent
   * cité (« Chicken Nation » à la place), ni les mentions, affaire interne.
   */
  private mapMessagesField(
    message: any,
    monId?: string | null,
    lecteur: Lecteur = 'user',
  ): ResponseMessageDto {
    if (this.isDev) {
      this.logger.debug(`Mapping du message: ${JSON.stringify(message)}`);
    }

    /**
     * MESSAGE SUPPRIMÉ : on remplace ce qui est servi, ici et nulle part
     * ailleurs.
     *
     * Le texte remplace le corps plutôt que de le vider : une bulle vide
     * ressemblerait à un défaut d'affichage, et les applications déjà
     * installées ignorent le drapeau `deleted`. En remplaçant côté serveur,
     * elles affichent la bonne chose sans mise à jour.
     *
     * ⚠️ `meta` part AUSSI : une photo ou une note vocale y vit sous forme de
     * lien, le laisser reviendrait à ne rien supprimer. Les réactions
     * disparaissent également, des pastilles accrochées à un contenu qui
     * n'existe plus n'ayant plus de sens.
     */
    const supprime = !!message.deletedAt;

    return {
      id: message.id,
      deleted: supprime,
      deletedAt: message.deletedAt ?? null,
      reactions: supprime ? [] : agregerReactions(message.reactions, monId ?? null),
      conversation: {
        id: message.conversationId,
        restaurantId: message.conversation?.restaurantId,
        customerId: message.conversation?.customerId,
      },
      meta: supprime ? null : (message.meta || {}),
      body: supprime ? CORPS_MESSAGE_SUPPRIME : message.body,
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
      /**
       * Message CITÉ, résumé à la lecture. Retiré avec le reste quand le
       * message lui-même est supprimé : une citation au-dessus de « Ce message
       * a été supprimé » n'aurait plus de sens.
       */
      replyTo: supprime ? null : resumerCitation(message.replyTo ?? null, lecteur),
      mentions:
        supprime || lecteur === 'customer'
          ? []
          : (message.mentions ?? []).map((m: { userId: string; libelle: string }) => ({
            userId: m.userId,
            label: m.libelle,
          })),
    };
  }

  // ───────────────────────── Position ─────────────────────────

  /**
   * PAGE où se trouve un message, pour aller jusqu'à un message cité qui n'est
   * pas encore chargé, ou pour suivre un lien de notification.
   *
   * Même ordre que la liste (`createdAt` décroissant, puis `id` décroissant) :
   * la page vaut le nombre de messages PLUS RÉCENTS que la cible, divisé par
   * la taille de page, plus un. Un seul comptage, sur l'index
   * (conversationId, createdAt).
   *
   * Accès : celui de la conversation (`getConversationById`), puis le message
   * doit lui appartenir ; sinon « introuvable », sans rien confirmer.
   */
  async getPositionMessage(
    req: Request,
    conversationId: string,
    messageId: string,
    limit = 100,
  ): Promise<{ messageId: string; page: number; limit: number }> {
    const taille = Number.isInteger(limit) && limit > 0 ? limit : 100;

    const conversation = await this.conversationsService.getConversationById(
      req,
      conversationId,
    );
    if (!conversation) {
      throw new NotFoundException('Conversation introuvable');
    }

    const cible = await this.prismaService.message.findFirst({
      where: { id: messageId, conversationId: conversation.id },
      select: { id: true, createdAt: true },
    });
    if (!cible) {
      throw new NotFoundException('Message introuvable');
    }

    const plusRecents = await this.prismaService.message.count({
      where: {
        conversationId: conversation.id,
        OR: [
          { createdAt: { gt: cible.createdAt } },
          { createdAt: cible.createdAt, id: { gt: cible.id } },
        ],
      },
    });

    return {
      messageId: cible.id,
      page: Math.floor(plusRecents / taille) + 1,
      limit: taille,
    };
  }

  // ───────────────────────── Suppression ─────────────────────────

  /**
   * Retire un message envoyé par erreur.
   *
   * Suppression DOUCE : la ligne reste, son contenu cesse d'être servi. Un fil
   * de support est une pièce à conviction quand un litige remonte, et effacer
   * vraiment la ligne ferait disparaître jusqu'au fait qu'un message a existé.
   *
   * Qui peut retirer quoi :
   *  - SON PROPRE message, toujours. C'est le cas d'usage : on s'est trompé.
   *  - N'importe quel message DU PERSONNEL si l'on est administrateur, pour
   *    rattraper la bévue d'un collègue parti en tournée.
   *  - JAMAIS le message d'un client. Retirer ses mots reviendrait à réécrire
   *    ce qu'il a dit, ce qui n'est pas une correction mais une falsification.
   */
  async supprimerMessage(
    req: Request,
    conversationId: string,
    messageId: string,
  ): Promise<ResponseMessageDto> {
    const auth = req.user!;
    if (getAuthType(auth) !== 'user') {
      throw new NotFoundException('Message introuvable');
    }
    const moi = auth as User;

    const message = await this.prismaService.message.findFirst({
      where: { id: messageId, conversationId },
      select: {
        id: true,
        authorUserId: true,
        deletedAt: true,
        conversation: {
          select: {
            id: true,
            customerId: true,
            restaurantId: true,
            users: { select: { userId: true } },
          },
        },
        // Qui a pu être prévenu de ce message : pour masquer l'aperçu.
        mentions: { select: { userId: true } },
        replyTo: { select: { authorUserId: true } },
      },
    });
    if (!message) {
      throw new NotFoundException('Message introuvable');
    }

    const conversation = message.conversation;

    // Même règle d'accès que la lecture : participant, ou membre du restaurant
    // quand il s'agit d'un échange avec un client.
    const estParticipant = conversation.users.some((u) => u.userId === moi.id);
    if (!estParticipant) {
      if (!conversation.customerId) {
        throw new NotFoundException('Message introuvable');
      }
      const duRestaurant = conversation.restaurantId
        ? await this.prismaService.user.findFirst({
            where: { id: moi.id, restaurant_id: conversation.restaurantId },
            select: { id: true },
          })
        : null;
      if (!duRestaurant) {
        throw new NotFoundException('Message introuvable');
      }
    }

    if (!message.authorUserId) {
      throw new BadRequestException(
        "Seuls les messages du personnel peuvent être retirés : on ne réécrit pas les mots d'un client.",
      );
    }

    const estAdmin = moi.role === UserRole.ADMIN;
    if (message.authorUserId !== moi.id && !estAdmin) {
      throw new BadRequestException(
        'Vous ne pouvez retirer que vos propres messages.',
      );
    }

    // Déjà retiré : on ne fait rien et on ne se plaint pas. Deux clics ou deux
    // écrans ouverts ne doivent pas produire d'erreur.
    if (!message.deletedAt) {
      await this.prismaService.message.update({
        where: { id: messageId },
        data: { deletedAt: new Date(), deletedById: moi.id },
      });

      /**
       * Tracé au journal d'audit. Retirer un message est le genre d'action
       * qu'on doit pouvoir expliquer trois mois plus tard : qui, quand, dans
       * quelle conversation.
       */
      this.auditService.record({
        actor_id: moi.id,
        actor_name: moi.fullname ?? moi.email ?? null,
        actor_role: moi.role ?? null,
        restaurant_id: conversation.restaurantId ?? null,
        action: 'DELETE',
        module: 'messages',
        entity_id: messageId,
        method: 'DELETE',
        path: `/conversations/${conversationId}/messages/${messageId}`,
        status_code: 200,
        summary: `Message retiré${message.authorUserId !== moi.id ? " (écrit par un collègue)" : ''}`,
        metadata: { conversationId, messageId, auteur: message.authorUserId },
      });

      /**
       * Les notifications de mention ou de réponse montraient un extrait de ce
       * message : on le remplace, sans quoi la cloche continuerait d'afficher
       * ce qui vient d'être retiré. Non bloquant.
       */
      const prevenus = [
        ...message.mentions.map((m) => m.userId),
        ...(message.replyTo?.authorUserId ? [message.replyTo.authorUserId] : []),
      ];
      if (prevenus.length > 0) {
        void this.notificationsSenderService
          .masquerApercuNotificationsMessage({ messageId, userIds: prevenus })
          .catch((e) =>
            this.logger.warn(
              `Aperçu des notifications du message ${messageId} non masqué : ${e?.message}`,
            ),
          );
      }
    }

    const frais = await this.prismaService.message.findUnique({
      where: { id: messageId },
      include: {
        authorUser: true,
        authorCustomer: true,
        reactions: { select: { emoji: true, userId: true, customerId: true } },
        conversation: { select: { customerId: true, restaurantId: true } },
        ...INCLURE_REPONSE_ET_MENTIONS,
      },
    });
    const mappe = this.mapMessagesField(frais, moi.id);

    this.messageWebSocketService.emitMessageSupprime(
      { id: conversation.id, customerId: conversation.customerId },
      conversation.users.map((u) => u.userId),
      mappe,
    );

    return mappe;
  }

  // ───────────────────────── Réactions ─────────────────────────

  /**
   * Pose, remplace ou retire une réaction, comme sur WhatsApp.
   *
   * Une seule réaction par personne et par message : reposer le même emoji le
   * retire, en choisir un autre remplace le précédent. La règle est tenue par
   * une contrainte d'unicité en base, pas par ce code : deux clics simultanés
   * ne peuvent donc pas produire de doublon.
   *
   * ⚠️ Cette opération ne DOIT PAS ressembler à l'envoi d'un message. Elle ne
   * touche ni `updatedAt` de la conversation, ni `hasReply`, et n'émet aucune
   * notification : un pouce ne doit pas faire remonter une conversation en tête
   * de boîte de réception, ni réveiller un téléphone la nuit.
   */
  async basculerReaction(
    req: Request,
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ messageId: string; reactions: ReactionAgregee[] }> {
    if (!estEmojiAutorise(emoji)) {
      throw new BadRequestException(
        `Réaction non reconnue. Valeurs acceptées : ${EMOJIS_REACTION.join(' ')}`,
      );
    }

    const auth = req.user!;
    const type = getAuthType(auth);
    const monId = (auth as User | Customer).id;

    /**
     * Le message est chargé AVEC sa conversation : il ne suffit pas qu'il
     * existe, il doit appartenir à la conversation citée dans l'URL. Sans ce
     * recoupement, connaître un seul identifiant de message permettrait de
     * réagir dans n'importe quelle conversation.
     */
    const message = await this.prismaService.message.findFirst({
      where: { id: messageId, conversationId },
      select: {
        id: true,
        conversation: {
          select: {
            id: true,
            customerId: true,
            restaurantId: true,
            users: { select: { userId: true } },
          },
        },
      },
    });
    if (!message) {
      throw new NotFoundException('Message introuvable');
    }

    const conversation = message.conversation;

    /**
     * Même règle d'accès que la lecture de la conversation : un client n'agit
     * que dans la sienne ; un agent doit en être participant, ou appartenir au
     * restaurant s'il s'agit d'un échange avec un client. On répond
     * « introuvable » plutôt qu'« interdit », pour ne rien apprendre à qui
     * cherche.
     */
    if (type === 'customer') {
      if (conversation.customerId !== monId) {
        throw new NotFoundException('Message introuvable');
      }
    } else {
      const estParticipant = conversation.users.some((u) => u.userId === monId);
      if (!estParticipant && !conversation.customerId) {
        // Conversation INTERNE : il faut en être membre, sans exception.
        throw new NotFoundException('Message introuvable');
      }
      if (!estParticipant && conversation.customerId) {
        const duRestaurant = conversation.restaurantId
          ? await this.prismaService.user.findFirst({
              where: { id: monId, restaurant_id: conversation.restaurantId },
              select: { id: true },
            })
          : null;
        if (!duRestaurant) {
          throw new NotFoundException('Message introuvable');
        }
      }
    }

    const qui = type === 'customer' ? { customerId: monId } : { userId: monId };

    await this.prismaService.$transaction(async (tx) => {
      const existante = await tx.messageReaction.findFirst({
        where: { messageId, ...qui },
        select: { id: true, emoji: true },
      });

      if (!existante) {
        await tx.messageReaction.create({ data: { messageId, emoji, ...qui } });
      } else if (existante.emoji === emoji) {
        // Reposer le même emoji le retire : c'est la bascule attendue.
        await tx.messageReaction.delete({ where: { id: existante.id } });
      } else {
        await tx.messageReaction.update({
          where: { id: existante.id },
          data: { emoji },
        });
      }
    });

    const fraiches = await this.prismaService.messageReaction.findMany({
      where: { messageId },
      select: { emoji: true, userId: true, customerId: true },
    });

    /**
     * ⚠️ Chaque destinataire reçoit SA propre vue.
     *
     * `mine` dépend de qui regarde : une charge unique serait fausse pour tout
     * le monde sauf un. On diffuse donc un agrégat calculé par personne.
     */
    this.messageWebSocketService.emitReactionsChanged(
      { id: conversation.id, customerId: conversation.customerId },
      conversation.users.map((u) => u.userId),
      messageId,
      fraiches,
    );

    return { messageId, reactions: agregerReactions(fraiches, monId) };
  }
}
