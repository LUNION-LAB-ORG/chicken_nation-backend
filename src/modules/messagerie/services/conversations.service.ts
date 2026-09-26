import {
  HttpException,
  HttpStatus,
  Injectable,
  // Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import type { Request } from 'express';
import { QueryConversationsDto } from '../dto/query-conversations.dto';
import { QueryResponseDto } from '../../../common/dto/query-response.dto';
import { ResponseConversationsDto } from '../dto/response-conversations.dto';
import { Customer, EntityStatus, Prisma, User, UserRole, UserType } from '@prisma/client';
import { CreateConversationDto } from '../dto/create-conversation.dto';
import { getAuthType } from '../utils/getTypeUser';
import { ConversationWebsocketsService } from '../websockets/conversation-websockets.service';
import { ResponseMessageDto } from '../dto/response-message.dto';
import { CORPS_MESSAGE_SUPPRIME } from 'src/common/constantes/message-supprime';
import { estMentionnable } from '../utils/mentions';

type ConversationWhereUniqueInput = Prisma.ConversationWhereUniqueInput;

/**
 * Rôles autorisés à ouvrir un GROUPE interne.
 *
 * Un groupe alerte tous ses membres à chaque message : c'est une décision
 * d'organisation, pas un geste de tous les jours. Le tête-à-tête, lui, reste
 * ouvert à qui a accès à la messagerie.
 */
const ROLES_CREATION_GROUPE: UserRole[] = [
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.ASSISTANT_MANAGER,
];

@Injectable()
export class ConversationsService {
  // private readonly logger = new Logger(ConversationsService.name);
  private createConversationInclude({
    messageTake = 1,
    includeMessageAuthors = true,
    includeRestaurant = true,
    includeCustomerDetails = true,
    includeUserImage = true,
  }: {
    messageTake?: number;
    includeMessageAuthors?: boolean;
    includeRestaurant?: boolean;
    includeCustomerDetails?: boolean;
    includeUserImage?: boolean;
  } = {}): Prisma.ConversationInclude {
    return {
      customer: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          ...(includeCustomerDetails
            ? {
              email: true,
              phone: true,
              image: true,
            }
            : {}),
        },
      },
      users: {
        select: {
          user: {
            select: {
              id: true,
              fullname: true,
              role: true,
              // Lu pour calculer `mentionnable`, jamais renvoyé tel quel.
              entity_status: true,
              ...(includeUserImage ? { image: true } : {}),
            },
          },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: messageTake,
        ...(includeMessageAuthors
          ? {
            include: {
              authorUser: {
                select: {
                  id: true,
                  fullname: true,
                  email: true,
                  image: true,
                },
              },
              authorCustomer: {
                select: {
                  id: true,
                  first_name: true,
                  last_name: true,
                  image: true,
                },
              },
            },
          }
          : {}),
      },
      ...(includeRestaurant
        ? {
          restaurant: {
            select: {
              id: true,
              name: true,
              image: true,
            },
          },
        }
        : {}),
    };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationWebsockets: ConversationWebsocketsService,
  ) { }

  /**
   * Liste les conversations de l'utilisateur authentifié
   * Si l'utilisateur est un client, il ne voit que ses conversations.
   * Si l'utilisateur est un employé, il peut voir les conversations où il est un participant.
   * @param req
   * @param filter
   */
  async getConversations(req: Request, filter: QueryConversationsDto) {
    const auth = req.user!;

    let conversations: QueryResponseDto<ResponseConversationsDto> | null = null;

    // Vérifier si l'utilisateur est un client ou un employé

    if (getAuthType(auth) === 'customer') {
      conversations = await this.getCustomerConversations(
        (auth as Customer).id,
        filter,
      );
    } else if (getAuthType(auth) === 'user') {
      conversations = await this.getUserConversations(
        (auth as User).id,
        filter,
        (auth as User).type,
      );
    }

    return conversations;
  }

  /**
   * Crée une conversation avec un message initial
   * Si une conversation existe déjà pour le restaurant et le client, elle est retournée.
   * Si l'utilisateur est un employé, il est ajouté à la conversation.
   * @param req
   * @param createConversationDto
   */
  async createConversationWithInitialMessage(
    req: Request,
    createConversationDto: CreateConversationDto,
  ): Promise<ResponseConversationsDto> {
    const auth = req.user!;
    const {
      restaurant_id: restaurantId = null,
      seed_message,
      receiver_user_id: receiverUserId,
      participant_user_ids: participantUserIds,
      subject,
      customer_to_contact_id,
    } = createConversationDto;

    const authType = getAuthType(auth);
    const customerId = authType === 'customer' ? (auth as Customer).id : null;
    const userId = authType === 'user' ? (auth as User).id : null;

    if (customer_to_contact_id) {
      if (authType !== 'user') {
        throw new HttpException(
          'Only employees can create conversations on behalf of a customer',
          HttpStatus.FORBIDDEN,
        );
      }
      // Vérifier que le customer_to_contact_id existe
      const customerToContact = await this.prisma.customer.findUnique({
        where: { id: customer_to_contact_id },
      });
      if (!customerToContact) {
        throw new NotFoundException("Le client à contacter n'existe pas");
      }

      if (!restaurantId) {
        throw new HttpException(
          'le restaurantId est obligatoire lorsque vous contactez un client',
          HttpStatus.BAD_REQUEST,
        );
      }
      // Vérifier que le client à deja commandé dans ce restaurant
      const hasOrdered = await this.prisma.order.findFirst({
        where: {
          customer_id: customer_to_contact_id,
          restaurant_id: restaurantId,
        },
      });

      if (!hasOrdered) {
        throw new HttpException(
          "Le client à contacter n'a jamais commandé dans ce restaurant",
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    if (restaurantId) {
      const restaurant = await this.prisma.restaurant.findUnique({
        where: {
          id: restaurantId,
          OR: [
            { users: { some: { id: userId || undefined } } },
            { manager: userId || undefined },
          ],
        },
      });
      if (!restaurant) {
        throw new NotFoundException("Le restaurant n'a pas été trouvé");
      }
    }

    let whereClause: Prisma.ConversationWhereInput = {};
    /** Destinataires internes (hors créateur). Vide pour une conversation client. */
    let destinataires: string[] = [];
    let estGroupe = false;
    /** Un groupe est toujours neuf : on ne cherche pas d'existante. */
    let rechercherExistante = true;

    // CAS 1 — client ↔ restaurant : unique par (restaurantId, customerId)
    let customerIdToUse: string | null = null;
    if (customerId || customer_to_contact_id) {
      customerIdToUse = customerId || customer_to_contact_id!;
      if (!restaurantId) {
        throw new HttpException(
          'No restaurantId provided',
          HttpStatus.BAD_REQUEST,
        );
      }
      whereClause = { restaurantId, customerId: customerIdToUse };
    } else {
      // CAS 2 et 3 — interne : tête-à-tête ou GROUPE.
      if (!userId) {
        throw new HttpException('No userId', HttpStatus.BAD_REQUEST);
      }

      /**
       * Destinataires : la liste explicite si elle est fournie, sinon le
       * destinataire unique historique. On déduplique et on s'exclut soi-même
       * plutôt que de refuser la demande : cocher son propre nom dans une liste
       * est une maladresse d'écran, pas une erreur qui mérite un échec.
       */
      destinataires = [
        ...new Set(
          (participantUserIds?.length
            ? participantUserIds
            : receiverUserId
              ? [receiverUserId]
              : []
          ).filter((id) => !!id && id !== userId),
        ),
      ];

      if (destinataires.length === 0) {
        throw new HttpException(
          'Aucun destinataire : indiquez au moins un collègue.',
          HttpStatus.BAD_REQUEST,
        );
      }

      /**
       * CLOISONNEMENT PAR RESTAURANT.
       *
       * Un gestionnaire dirige UN point de vente : il ne constitue pas un
       * groupe avec le personnel d'un autre. Le contrôle ne portait que sur
       * l'existence des identifiants, or la liste vient du navigateur et peut
       * contenir n'importe qui. Le siège (comptes BACKOFFICE), lui, coordonne
       * le réseau et n'est pas borné.
       */
      const createur = auth as User;
      const bornerAuRestaurant =
        createur.type !== UserType.BACKOFFICE && !!createur.restaurant_id;

      const existants = await this.prisma.user.findMany({
        where: {
          id: { in: destinataires },
          ...(bornerAuRestaurant
            ? { restaurant_id: createur.restaurant_id }
            : {}),
        },
        select: { id: true },
      });
      if (existants.length !== destinataires.length) {
        // 400 et non 404 : le client ne conserve le message du serveur que sur
        // les 400, un 404 deviendrait « Ressource non trouvée » et n'apprendrait
        // rien à qui vient de choisir un collègue d'un autre restaurant.
        throw new HttpException(
          bornerAuRestaurant
            ? "Un des destinataires n'existe pas ou n'appartient pas à votre restaurant."
            : "Un des destinataires n'existe pas.",
          HttpStatus.BAD_REQUEST,
        );
      }

      estGroupe = destinataires.length >= 2;

      if (estGroupe) {
        /**
         * CAS 3 — GROUPE.
         *
         * Réservé aux responsables : un groupe notifie tout le monde à chaque
         * message, on ne laisse pas n'importe qui en ouvrir un.
         */
        const role = (auth as User).role;
        if (!ROLES_CREATION_GROUPE.includes(role)) {
          throw new HttpException(
            "Seuls les administrateurs et les gestionnaires peuvent créer un groupe.",
            HttpStatus.FORBIDDEN,
          );
        }
        if (!subject || !subject.trim()) {
          throw new HttpException(
            'Un groupe doit porter un nom.',
            HttpStatus.BAD_REQUEST,
          );
        }
        /**
         * AUCUNE déduplication pour un groupe, contrairement au tête-à-tête.
         *
         * Deux groupes peuvent réunir exactement les mêmes personnes pour deux
         * sujets différents, « Service du soir » et « Inventaire » par exemple,
         * et ce sont bien deux conversations. Réutiliser l'existante mêlerait
         * les deux fils. Et la clause du tête-à-tête, bâtie sur deux `some`,
         * aurait de toute façon accroché n'importe quel groupe contenant ces
         * deux personnes.
         */
        rechercherExistante = false;
      } else {
        // CAS 2 — tête-à-tête : unique par paire (userId, destinataire).
        whereClause = {
          restaurantId,
          subject: subject,
          customerId: null, // interne
          AND: [
            { users: { some: { userId } } },
            { users: { some: { userId: destinataires[0] } } },
            // Un groupe contient aussi ces deux personnes : sans cette borne,
            // un tête-à-tête retomberait sur un groupe existant.
            { users: { every: { userId: { in: [userId, destinataires[0]] } } } },
          ],
        };
      }
    }

    // Utiliser une transaction pour éviter les race conditions (création en double)
    const result = await this.prisma.$transaction(async (tx) => {
      const existingConversation = rechercherExistante
        ? await tx.conversation.findFirst({
            where: whereClause,
            include: this.createConversationInclude(),
          })
        : null;

      if (existingConversation) {
        return { conversation: existingConversation, isNew: false };
      }

      const conversation = await tx.conversation.create({
        data: {
          restaurantId,
          customerId: customerIdToUse, // null si interne
          subject: subject,
          // Décidé ICI, une fois pour toutes : un groupe le reste, quels que
          // soient les départs. Voir le commentaire du champ dans le schéma.
          isGroup: estGroupe,
          messages: {
            create: {
              body: seed_message,
              authorUserId: userId, // si l'auteur est un employé
              authorCustomerId: customerId, // si l'auteur est un client
            },
          },
          ...(userId
            ? {
              users: {
                createMany: {
                  // Le créateur, puis tous les destinataires : un seul pour un
                  // tête-à-tête, autant que voulu pour un groupe.
                  data: [
                    { userId: userId },
                    ...destinataires.map((id) => ({ userId: id })),
                  ],
                },
              },
            }
            : {}),
        },
        include: {
          customer: { select: { id: true, first_name: true, last_name: true } },
          /**
           * ⚠️ Rôle et statut lus ICI AUSSI : sans eux, `mentionnable` valait
           * faux pour tout le monde dans la réponse de création et dans
           * `conversation:created`, et un groupe tout neuf affichait chacun de
           * ses membres grisé jusqu'au rechargement.
           */
          users: {
            select: {
              user: {
                select: {
                  id: true,
                  fullname: true,
                  role: true,
                  entity_status: true,
                  image: true,
                },
              },
            },
          },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });

      return { conversation, isNew: true };
    });

    const unreadNumber = await this.countUnreadMessages({
      conversationId: result.conversation.id,
      authId: authType === 'user' ? (auth as User).id : (auth as Customer).id,
      type: authType,
    });

    const mappedConversation = this.mapConversationField(
      result.conversation,
      unreadNumber,
    );

    if (result.isNew) {
      this.conversationWebsockets.emitConversationCreated(mappedConversation);
    }

    return mappedConversation;
  }

  // ─────────────────── Gestion d'un groupe interne ───────────────────

  /**
   * Charge un GROUPE et vérifie que l'appelant a le droit d'y toucher.
   *
   * Les trois opérations de gestion partagent exactement les mêmes gardes, et
   * les avoir en un seul endroit évite qu'une des trois prenne du retard sur
   * les autres. Toutes répondent « introuvable » plutôt qu'« interdit » quand
   * l'appelant n'est pas membre : confirmer l'existence d'un groupe privé à qui
   * n'en fait pas partie est déjà une fuite.
   */
  private async chargerGroupePourGestion(
    auth: NonNullable<Request['user']>,
    conversationId: string,
    exigerRoleDeGestion: boolean,
  ) {
    if (getAuthType(auth) !== 'user') {
      throw new NotFoundException('Conversation introuvable');
    }
    const moi = auth as User;

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        customerId: true,
        restaurantId: true,
        subject: true,
        isGroup: true,
        receivesAlerts: true,
        users: { select: { userId: true } },
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation introuvable');
    }

    /**
     * Réservé aux conversations INTERNES. Une conversation avec un client est
     * une boîte partagée du service client : sa composition suit d'autres
     * règles, et on n'y « retire » personne.
     */
    if (conversation.customerId) {
      throw new HttpException(
        "La composition d'une conversation avec un client ne se gère pas ici.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const membres = conversation.users.map((u) => u.userId);
    /**
     * ⚠️ L'appartenance se vérifie AVANT tout le reste.
     *
     * Répondre « ce n'est pas un groupe » à qui n'est pas membre lui
     * apprendrait déjà quelque chose sur une conversation qui ne le regarde
     * pas. On ne distingue donc jamais « n'existe pas » de « pas pour vous ».
     */
    if (!membres.includes(moi.id)) {
      throw new NotFoundException('Conversation introuvable');
    }

    /**
     * ⚠️ Réservé à un vrai GROUPE.
     *
     * Sans ce contrôle, on pouvait faire entrer un tiers dans un tête-à-tête,
     * qui héritait alors de tout l'historique privé des deux autres. Et le
     * renommer cassait sa déduplication, la recherche d'une conversation
     * existante portant aussi sur son intitulé.
     */
    const estUnGroupe =
      conversation.isGroup || conversation.users.length > 2;
    if (!estUnGroupe) {
      throw new HttpException(
        "Cette conversation n'est pas un groupe : sa composition ne se modifie pas.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (exigerRoleDeGestion && !ROLES_CREATION_GROUPE.includes(moi.role)) {
      throw new HttpException(
        'Seuls les administrateurs et les gestionnaires peuvent modifier la composition d\'un groupe.',
        HttpStatus.FORBIDDEN,
      );
    }

    return { conversation, membres, moi };
  }

  /** Recharge le groupe sous sa forme de réponse, et prévient tout le monde. */
  private async renvoyerEtNotifier(conversationId: string, aPrevenir: string[]) {
    const frais = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: this.createConversationInclude({ messageTake: 50 }),
    });
    if (!frais) throw new NotFoundException('Conversation introuvable');

    /**
     * `unreadNumber` à 0 dans la charge diffusée : ce compteur est PROPRE à
     * chaque destinataire, une valeur unique serait fausse pour presque tous.
     * Les écrans rafraîchissent leur compte à réception, comme ils le font
     * déjà à la création d'une conversation.
     */
    const reponse = this.mapConversationField(frais, 0);
    this.conversationWebsockets.emitParticipantsChanged(aPrevenir, reponse);
    return reponse;
  }

  /**
   * Ajoute des collègues à un groupe existant.
   *
   * Les nouveaux arrivent avec une date de lecture posée à MAINTENANT : ils
   * voient tout l'historique, mais n'héritent pas d'une pastille comptant des
   * mois de messages écrits avant leur arrivée.
   */
  async ajouterParticipants(
    req: Request,
    conversationId: string,
    userIds: string[],
  ): Promise<ResponseConversationsDto> {
    const { conversation, membres, moi } = await this.chargerGroupePourGestion(
      req.user!,
      conversationId,
      true,
    );

    const aAjouter = [...new Set((userIds ?? []).filter((id) => !!id))].filter(
      (id) => !membres.includes(id),
    );
    if (aAjouter.length === 0) {
      throw new HttpException(
        'Ces personnes font déjà partie du groupe.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Même cloisonnement qu'à la création : un gestionnaire ne fait pas entrer
    // le personnel d'un autre point de vente. Le siège n'est pas borné.
    const bornerAuRestaurant =
      moi.type !== UserType.BACKOFFICE && !!moi.restaurant_id;
    const existants = await this.prisma.user.findMany({
      where: {
        id: { in: aAjouter },
        // Un compte désactivé n'a rien à faire dans un groupe : il n'y lira
        // rien et occupe une place dans la liste des membres.
        entity_status: EntityStatus.ACTIVE,
        ...(bornerAuRestaurant ? { restaurant_id: moi.restaurant_id } : {}),
      },
      select: { id: true },
    });
    if (existants.length !== aAjouter.length) {
      // Voir plus haut : seul un 400 laisse passer l'explication jusqu'à l'écran.
      throw new HttpException(
        bornerAuRestaurant
          ? "Une des personnes n'existe pas ou n'appartient pas à votre restaurant."
          : "Une des personnes n'existe pas.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const maintenant = new Date();
    await this.prisma.conversationUser.createMany({
      data: aAjouter.map((userId) => ({
        conversationId: conversation.id,
        userId,
        lastReadAt: maintenant,
      })),
      // Deux ajouts simultanés ne doivent pas faire échouer le second.
      skipDuplicates: true,
    });

    return this.renvoyerEtNotifier(conversation.id, [...membres, ...aAjouter]);
  }

  /**
   * Retire quelqu'un d'un groupe, ou le quitte soi-même.
   *
   * Se retirer soi-même ne demande aucun rôle particulier : on peut toujours
   * quitter un groupe. Retirer QUELQU'UN D'AUTRE est une décision
   * d'organisation, réservée aux responsables.
   */
  async retirerParticipant(
    req: Request,
    conversationId: string,
    userId: string,
  ): Promise<ResponseConversationsDto> {
    const auth = req.user as User;
    const estMoi = userId === auth?.id;

    const { conversation, membres } = await this.chargerGroupePourGestion(
      req.user!,
      conversationId,
      !estMoi,
    );

    if (!membres.includes(userId)) {
      throw new HttpException(
        'Cette personne ne fait pas partie du groupe.',
        HttpStatus.BAD_REQUEST,
      );
    }

    /**
     * Un groupe garde au moins deux membres quand on en retire quelqu'un :
     * en dessous, ce n'est plus un groupe et l'écran n'aurait plus de sens.
     * Quitter de soi-même reste possible dans tous les cas, personne ne doit
     * être retenu dans une conversation.
     */
    /**
     * Comptage et suppression dans la MÊME transaction.
     *
     * Lu en dehors, le compte peut être périmé au moment d'écrire : deux
     * retraits simultanés voient chacun trois membres, chacun se juge autorisé,
     * et le groupe tombe à un. On relit donc à l'intérieur.
     */
    await this.prisma.$transaction(async (tx) => {
      if (!estMoi) {
        const restants = await tx.conversationUser.count({
          where: { conversationId: conversation.id },
        });
        if (restants <= 2) {
          throw new HttpException(
            'Un groupe doit conserver au moins deux membres.',
            HttpStatus.BAD_REQUEST,
          );
        }
      }
      await tx.conversationUser.delete({
        where: {
          conversationId_userId: { conversationId: conversation.id, userId },
        },
      });
    });

    // Le partant reçoit un avis MINIMAL, sans le contenu du groupe qu'il quitte.
    this.conversationWebsockets.emitRetireDuGroupe(userId, conversation.id);

    return this.renvoyerEtNotifier(
      conversation.id,
      membres.filter((id) => id !== userId),
    );
  }

  /**
   * Fait de ce groupe un canal d'ALERTES, ou l'en retire.
   *
   * Le système y écrira quand un paiement part de travers, qu'une commande se
   * clôture sans être payée, ou que les notifications de paiement sont
   * refusées. Ça reste une conversation ordinaire : les membres y répondent, se
   * répartissent le travail, disent que c'est traité.
   */
  async basculerAlertes(
    req: Request,
    conversationId: string,
    recevoir: boolean,
  ): Promise<ResponseConversationsDto> {
    const { conversation, membres } = await this.chargerGroupePourGestion(
      req.user!,
      conversationId,
      true,
    );

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { receivesAlerts: recevoir },
    });

    return this.renvoyerEtNotifier(conversation.id, membres);
  }

  /** Renomme un groupe. Le nom est ce que tout le monde lit dans sa liste. */
  async renommerGroupe(
    req: Request,
    conversationId: string,
    subject: string,
  ): Promise<ResponseConversationsDto> {
    const { conversation, membres } = await this.chargerGroupePourGestion(
      req.user!,
      conversationId,
      true,
    );

    const nom = (subject ?? '').trim();
    if (!nom) {
      throw new HttpException(
        'Un groupe doit porter un nom.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { subject: nom },
    });

    return this.renvoyerEtNotifier(conversation.id, membres);
  }

  async getConversationById(
    req: Request,
    conversationId: string,
  ): Promise<ResponseConversationsDto | null> {
    const auth = req.user!;

    const authType = getAuthType(auth);
    let whereClause: ConversationWhereUniqueInput = {
      id: conversationId,
    };

    if (authType === 'customer') {
      whereClause = {
        ...whereClause,
        customerId: (auth as Customer).id,
      };
    } else if (authType === 'user') {
      if ((auth as User).type === UserType.BACKOFFICE) {
        /**
         * Le siège supervise tout ce qui touche un CLIENT : c'est sa fonction,
         * et rien ne change de ce côté.
         *
         * Un échange INTERNE, lui, n'est pas une conversation de service. Le
         * filtre s'arrêtait à l'identifiant pour un compte backoffice, si bien
         * que n'importe lequel pouvait ouvrir le tête-à-tête de deux collègues,
         * et demain le groupe privé des gestionnaires, sans en être membre. On
         * y entre désormais comme tout le monde : en y ayant été mis.
         */
        whereClause = {
          ...whereClause,
          OR: [
            { customerId: { not: null } },
            { users: { some: { userId: (auth as User).id } } },
          ],
        };
      } else {
        whereClause = {
          ...whereClause,
          OR: [
            {
              users: {
                some: {
                  userId: (auth as User).id,
                },
              },
            },
            {
              customerId: {
                not: null,
              },
              restaurant: {
                users: {
                  some: {
                    id: (auth as User).id,
                  },
                },
              },
            },
          ],
        };
      }
    }

    const [conversation, unreadNumber] = await Promise.all([
      this.prisma.conversation.findUnique({
        where: whereClause,
        include: this.createConversationInclude({ messageTake: 50 }),
      }),
      this.countUnreadMessages({
        conversationId,
        authId: authType === 'user' ? (auth as User).id : (auth as Customer).id,
        type: authType,
      }),
    ]);

    return conversation
      ? this.mapConversationField(conversation, unreadNumber)
      : null;
  }

  /**
   * Statistiques des conversations pour le backoffice
   */
  async getConversationStats(req: Request) {
    const auth = req.user!;
    const authType = getAuthType(auth);

    if (authType !== 'user') {
      return { total_conversations: 0, unread_conversations: 0, total_messages: 0, unread_messages: 0 };
    }

    const user = auth as User;
    const isBackoffice = user.type === UserType.BACKOFFICE;

    // Where clause selon le type d'utilisateur
    const conversationWhere: Prisma.ConversationWhereInput = isBackoffice
      ? {
        OR: [
          { customerId: { not: null } },
          { users: { some: { userId: user.id } } },
        ],
      }
      : {
        OR: [
          { users: { some: { userId: user.id } } },
          {
            customerId: { not: null },
            restaurant: { users: { some: { id: user.id } } },
          },
        ],
      };

    const [totalConversations, totalMessages, unreadMessages] = await Promise.all([
      this.prisma.conversation.count({ where: conversationWhere }),
      this.prisma.message.count({
        where: { conversation: conversationWhere },
      }),
      this.prisma.message.count({
        where: {
          conversation: conversationWhere,
          isRead: false,
          /**
           * ⚠️ CET ENSEMBLE DOIT ETRE CELUI QUE LE MARQUAGE BLANCHIT.
           *
           * Le filtre était `authorUserId != moi`, donc « tout ce que je n'ai
           * pas écrit », ce qui inclut les messages des AUTRES AGENTS. Or le
           * marquage côté personnel ne blanchit que les messages du CLIENT :
           * la pastille comptait donc des messages qu'aucune lecture ne
           * pouvait éteindre. Elle restait figée, pendant que les lignes de la
           * boîte de réception, elles, n'affichaient rien, puisque leur
           * compteur vise déjà le bon ensemble.
           *
           * Les deux comptes disent enfin la même chose.
           */
          authorCustomerId: { not: null },
          /**
           * ⚠️ Même exclusion que dans les compteurs par conversation.
           *
           * Sans elle, chaque destinataire d'une diffusion ajoute un message
           * « non lu » à la pastille du menu, alors que ce message a été
           * envoyé PAR le personnel. Et comme la conversation est justement
           * masquée de la boîte de réception tant que le client n'a pas
           * répondu, aucun agent ne peut aller la lire : la pastille resterait
           * gonflée pour toujours, et s'additionnerait à chaque diffusion.
           */
          broadcastId: null,
        },
      }),
    ]);

    // Compter les conversations qui ont au moins 1 message non lu
    const conversationsWithUnread = await this.prisma.conversation.count({
      where: {
        ...conversationWhere,
        messages: {
          some: {
            isRead: false,
            // Même ensemble que ci-dessus, et que le marquage.
            authorCustomerId: { not: null },
            // Voir ci-dessus : un message de diffusion n'est pas à lire.
            broadcastId: null,
          },
        },
      },
    });

    /**
     * LES CONVERSATIONS INTERNES manquaient entièrement à cette pastille.
     *
     * Les deux comptes ci-dessus ne retiennent que les messages du CLIENT, ce
     * qui est juste pour une conversation de service client mais laisse un
     * groupe d'équipe totalement muet : il faudrait ouvrir l'écran Messages
     * pour découvrir qu'on y a été interpellé. On ajoute donc les non-lus
     * internes, comptés par participant à partir de sa propre date de lecture.
     *
     * Les deux ensembles sont disjoints : une conversation a un client, ou elle
     * n'en a pas. Aucun double comptage possible.
     */
    let nonLusInternes = 0;
    let conversationsInternesNonLues = 0;
    if (getAuthType(auth) === 'user') {
      /**
       * BORNÉ, et par les plus récentes.
       *
       * Sans plafond, un agent présent dans des centaines de fils internes
       * ferait construire une clause `OR` d'autant de branches, sur une requête
       * appelée à chaque affichage de la pastille. Deux cents conversations
       * internes couvrent très largement l'usage réel ; au-delà, la pastille
       * ignore les plus anciennes, ce qui est sans conséquence puisque
       * l'activité se concentre sur les récentes.
       */
      const internes = await this.prisma.conversation.findMany({
        where: { customerId: null, users: { some: { userId: user.id } } },
        select: { id: true },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      });
      if (internes.length > 0) {
        const compte = await this.compterNonLusInternes(
          internes.map((c) => c.id),
          user.id,
        );
        compte.forEach((valeur) => {
          if (valeur > 0) {
            nonLusInternes += valeur;
            conversationsInternesNonLues += 1;
          }
        });
      }
    }

    return {
      total_conversations: totalConversations,
      unread_conversations: conversationsWithUnread + conversationsInternesNonLues,
      total_messages: totalMessages,
      unread_messages: unreadMessages + nonLusInternes,
    };
  }

  /**
   * Liste les conversations d'un client.
   * Il ne peut voir que ses propres conversations.
   * Si un restaurant est spécifié, il filtre par ce restaurant.
   * @param customerId
   * @param filter
   * @private
   */
  private async getCustomerConversations(
    customerId: string,
    filter: QueryConversationsDto,
  ) {
    // this.logger.log('Obtenir liste conversations customer: ', customerId, " filtre :", filter);
    const { limit = 10, page = 1 } = filter;
    const skip = (page - 1) * limit;

    const whereClause: Prisma.ConversationWhereInput = {
      customerId,
      restaurantId: filter.restaurantId, // Filtre par restaurant si spécifié
    };

    // this.logger.log('Obtenir liste conversations customer: ', customerId, " filtre :", filter, " whereClause :", whereClause);

    const [conversations, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where: whereClause,
        include: this.createConversationInclude(),
        /**
         * ⚠️ Tri INDISPENSABLE, et pas seulement confortable.
         *
         * Sans `orderBy`, Postgres renvoie les lignes dans l'ordre physique du
         * heap, qui n'est ni stable ni reproductible d'une requête à l'autre.
         * Combiné à une pagination par décalage (`skip`/`take`), cela produit
         * des conversations vues deux fois sur deux pages et d'autres jamais
         * vues. Le défaut passait inaperçu tant que le backoffice demandait 50
         * conversations d'un coup, c'est-à-dire presque tout : il éclate dès
         * qu'on pagine réellement.
         *
         * `updatedAt` est bien la bonne clé ici : `message.service` l'écrit à
         * chaque message (voir `conversation.update`), donc la conversation la
         * plus active remonte en tête, ce qu'attend le gestionnaire.
         */
        orderBy: { updatedAt: 'desc' },
        skip: skip,
        take: limit,
      }),
      this.prisma.conversation.count({ where: whereClause }),
    ]);

    // this.logger.debug('Liste des conversations client: ', conversations, total);

    // Batch unread counts en une seule requête (au lieu de N+1)
    const conversationIds = conversations.map((c) => c.id);
    const unreadCounts = await this.batchCountUnreadMessages(
      conversationIds,
      customerId,
      'customer',
    );

    const mappedConversations = conversations.map((conversation) =>
      this.mapConversationField(
        conversation,
        unreadCounts.get(conversation.id) ?? 0,
      ),
    );

    return {
      data: mappedConversations,
      meta: {
        total: total,
        page: page,
        limit: limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Liste les conversations d'un employé.
   * Il peut voir les conversations où il est participant ou celles avec un client du restaurant.
   * @param userId
   * @param filter
   * @private
   */
  private async getUserConversations(
    userId: string,
    filter: QueryConversationsDto = {},
    userType?: UserType,
  ): Promise<QueryResponseDto<ResponseConversationsDto>> {
    const { limit = 10, page = 1, ...rest } = filter;
    const skip = (page - 1) * limit;

    // Les utilisateurs BACKOFFICE voient toutes les conversations
    // (tous restaurants + conversations internes où ils sont participants)
    const whereClause: Prisma.ConversationWhereInput = userType === UserType.BACKOFFICE
      ? {
        OR: [
          { customerId: { not: null } },        // Toutes les conversations client ↔ restaurant
          { users: { some: { userId } } },       // + conversations internes où il est participant
        ],
        ...rest,
      }
      : {
        OR: [
          {
            users: {
              some: {
                userId: userId, // Vérifie si l'utilisateur est participant à la conversation
              },
            },
          },
          {
            AND: [
              {
                customerId: {
                  not: null, // Si c'est une conversation avec un client
                },
              },
              {
                restaurant: {
                  users: {
                    some: {
                      id: userId, // Vérifie si l'utilisateur est employé du restaurant
                    },
                  },
                },
              },
            ],
          },
        ],
        ...rest,
      };

    // this.logger.debug('Where clause pour user conversations: ', whereClause);

    const [conversations, total] = await Promise.all([
      this.prisma.conversation.findMany({
      /**
       * ⚠️ Les canaux de DIFFUSION sont écartés de la boîte de réception tant
       * que le client n'a pas répondu.
       *
       * Une diffusion à mille clients crée mille conversations. Sans ce filtre,
       * une seule campagne noierait entièrement le service client, et la
       * suivante recommencerait. Dès la première réponse, `hasReply` passe à
       * vrai et la conversation redevient ordinaire : elle remonte alors avec le
       * message diffusé en première ligne d'historique, pour que l'agent voie à
       * quoi le client répond.
       *
       * Le client, lui, voit toujours ses diffusions : ce filtre ne s'applique
       * qu'au chemin backoffice (`getUserConversations`).
       */
      where: { AND: [whereClause, { OR: [{ isBroadcast: false }, { hasReply: true }] }] },
        include: this.createConversationInclude(),
        /**
         * ⚠️ Tri INDISPENSABLE, et pas seulement confortable.
         *
         * Sans `orderBy`, Postgres renvoie les lignes dans l'ordre physique du
         * heap, qui n'est ni stable ni reproductible d'une requête à l'autre.
         * Combiné à une pagination par décalage (`skip`/`take`), cela produit
         * des conversations vues deux fois sur deux pages et d'autres jamais
         * vues. Le défaut passait inaperçu tant que le backoffice demandait 50
         * conversations d'un coup, c'est-à-dire presque tout : il éclate dès
         * qu'on pagine réellement.
         *
         * `updatedAt` est bien la bonne clé ici : `message.service` l'écrit à
         * chaque message (voir `conversation.update`), donc la conversation la
         * plus active remonte en tête, ce qu'attend le gestionnaire.
         */
        orderBy: { updatedAt: 'desc' },
        skip: skip,
        take: limit,
      }),
      this.prisma.conversation.count({
        where: { AND: [whereClause, { OR: [{ isBroadcast: false }, { hasReply: true }] }] },
      }),
    ]);

    // this.logger.debug('Liste des conversations user: ', conversations, total);

    // Batch unread counts en une seule requête (au lieu de N+1)
    const conversationIds = conversations.map((c) => c.id);
    const unreadCounts = await this.batchCountUnreadMessages(
      conversationIds,
      userId,
      'user',
    );

    const mappedConversations = conversations.map((conversation) =>
      this.mapConversationField(
        conversation,
        unreadCounts.get(conversation.id) ?? 0,
      ),
    );

    return {
      data: mappedConversations,
      meta: {
        total: total,
        page: page,
        limit: limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Mappe les champs d'une conversation pour la réponse
   * @param conversation
   * @param unreadNumber
   * @private
   */
  private mapConversationField(
    conversation: any,
    unreadNumber: number = 0,
  ): ResponseConversationsDto {
    return {
      id: conversation.id,
      unreadNumber,
      customerId: conversation.customerId,
      subject: conversation.subject ?? null,
      /**
       * Le drapeau fait foi. Le repli sur le nombre de participants ne sert
       * qu'aux conversations créées avant l'existence de la colonne et que la
       * migration n'aurait pas reprises.
       */
      isGroup:
        conversation.isGroup ??
        (!conversation.customerId && (conversation.users?.length ?? 0) > 2),
      receivesAlerts: conversation.receivesAlerts ?? false,
      /**
       * ⚠️ Date du DERNIER MESSAGE, et non date de création de la conversation.
       *
       * L'application trie sa liste sur ce champ. En y mettant la date de
       * création, une conversation qui reçoit un message frais ne remontait
       * pas : le client voyait une ligne marquée « il y a 2 min » coincée en
       * bas de liste, ce qui est exactement la plainte remontée. L'heure
       * AFFICHÉE, elle, vient déjà du dernier message, il n'y a donc aucun
       * écart visible, seulement un tri qui redevient juste.
       *
       * Corriger ici plutôt que dans l'application évite une livraison : le
       * téléphone déjà installé trie correctement dès le déploiement du
       * serveur. `lastMessageAt` et `updatedAt` sont exposés juste en dessous
       * pour qu'une future version s'appuie sur un champ au nom honnête.
       */
      createdAt: this.dateDeTri(conversation),
      lastMessageAt: this.dateDernierMessage(conversation),
      updatedAt: conversation.updatedAt ?? conversation.createdAt,
      messages: conversation.messages.map(
        (
          message: any,
        ): Omit<ResponseMessageDto, 'conversationId' | 'conversation'> => ({
          id: message.id,
          isRead: message.isRead,
          /**
           * ⚠️ Un message SUPPRIMÉ ne sert jamais son texte d'origine, ici non
           * plus. Ce chemin (aperçu de la liste, 50 derniers messages d'une
           * conversation, charge `conversation:participants`) servait le corps
           * brut : ce que l'auteur avait retiré restait lisible partout ailleurs
           * que dans le fil.
           */
          deleted: !!message.deletedAt,
          deletedAt: message.deletedAt ?? null,
          body: message.deletedAt ? CORPS_MESSAGE_SUPPRIME : message.body,
          authorUser: message.authorUser
            ? {
              id: message.authorUser?.id,
              name: message.authorUser?.fullname,
              email: message.authorUser?.email,
              image: message.authorUser?.image,
            }
            : null,
          authorCustomer: message.authorCustomer
            ? {
              id: message.authorCustomer?.id,
              name: `${message.authorCustomer?.first_name} ${message.authorCustomer?.last_name}`,
              first_name: message.authorCustomer?.first_name,
              last_name: message.authorCustomer?.last_name,
              image: message.authorCustomer?.image,
            }
            : null,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        }),
      ),
      /**
       * ⚠️ Une conversation de DIFFUSION n'a pas de restaurant, et l'application
       * en tire son titre : `item.restaurant?.name || 'Support Technique'`.
       * Vos promotions arrivaient donc signées « Support Technique », avec une
       * icône de casque d'assistance.
       *
       * On lui donne ici un expéditeur de marque. Sans risque : l'application
       * n'affiche JAMAIS l'image du restaurant dans cette liste, elle utilise
       * une icône locale, un `image: null` ne peut donc rien casser. Et c'est
       * la seule correction qui vaut pour les téléphones DÉJÀ installés, sans
       * passer par une livraison.
       */
      restaurant: conversation.restaurant
        ? {
          id: conversation.restaurant.id,
          name: conversation.restaurant.name,
          image: conversation.restaurant.image,
        }
        : conversation.isBroadcast
          ? { id: null, name: 'Chicken Nation', image: null }
          : null,
      customer: conversation.customer
        ? {
          id: conversation.customer.id,
          first_name: conversation.customer.first_name,
          last_name: conversation.customer.last_name,
          image: conversation.customer.image,
          email: conversation.customer.email,
          phone: conversation.customer.phone,
        }
        : null,
      users: conversation.users?.map((user: any) => ({
        id: user.user.id,
        fullName: user.user.fullname,
        image: user.user.image || null,
        role: user.user.role,
        /**
         * Peut être mentionné : compte actif ET accès à la messagerie. Même
         * règle que celle qui valide les mentions à l'envoi, pour que l'écran
         * ne propose jamais une personne que le serveur écarterait.
         */
        mentionnable: estMentionnable(user.user),
      })),
    };
  }

  /** Date du dernier message, ou à défaut celle de la conversation. */
  private dateDernierMessage(conversation: any): Date {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    let derniere: Date | null = null;
    for (const m of messages) {
      const d = m?.createdAt ? new Date(m.createdAt) : null;
      if (d && (!derniere || d > derniere)) derniere = d;
    }
    return derniere ?? conversation.updatedAt ?? conversation.createdAt;
  }

  /**
   * Date sur laquelle l'application trie. Voir le commentaire de `createdAt`
   * dans `mapConversationField`.
   */
  private dateDeTri(conversation: any): Date {
    return this.dateDernierMessage(conversation);
  }

  /**
   * NON-LUS D'UNE CONVERSATION INTERNE, pour UN agent donné.
   *
   * Compté à part, et autrement, pour une raison de fond : `Message.isRead` est
   * un drapeau porté par le message, pas par le lecteur. Dans un groupe de
   * cinq, le premier qui ouvre éteindrait la pastille des quatre autres. On
   * s'appuie donc sur `ConversationUser.lastReadAt`, propre à chacun : est non
   * lu ce qui a été posté depuis MA dernière ouverture et que je n'ai pas
   * écrit. Jamais ouverte, tout est non lu.
   *
   * Les conversations CLIENT gardent leur comptage historique, intact : elles
   * n'ont qu'un interlocuteur, le drapeau du message y suffit, et y toucher
   * risquerait des régressions sur des compteurs déjà éprouvés.
   */
  private async compterNonLusInternes(
    conversationIds: string[],
    userId: string,
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (conversationIds.length === 0) return map;

    const participations = await this.prisma.conversationUser.findMany({
      where: {
        userId,
        conversationId: { in: conversationIds },
        conversation: { customerId: null }, // interne uniquement
      },
      select: { conversationId: true, lastReadAt: true },
    });
    if (participations.length === 0) return map;

    /**
     * Chaque conversation a SA date de dernière lecture : impossible de
     * l'exprimer par un seul `createdAt > X`. On énumère donc les couples
     * (conversation, date), ce qui reste une requête unique et une page de
     * conversations à la fois.
     */
    const counts = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        /**
         * « Pas écrit par moi », et non « écrit par quelqu'un d'autre ».
         *
         * ⚠️ Un message SYSTÈME n'a aucun auteur. Or en base, une comparaison
         * avec une colonne nulle n'est jamais vraie : le simple test
         * `authorUserId != moi` excluait donc silencieusement tout message sans
         * auteur. Une alerte postée par le système n'aurait allumé la pastille
         * de personne. On vise explicitement les deux cas.
         */
        OR: [{ authorUserId: null }, { authorUserId: { not: userId } }],
        AND: [
          {
            OR: participations.map((p) => ({
              conversationId: p.conversationId,
              ...(p.lastReadAt ? { createdAt: { gt: p.lastReadAt } } : {}),
            })),
          },
        ],
      },
      _count: { id: true },
    });

    counts.forEach((c) => map.set(c.conversationId, c._count.id));
    return map;
  }

  private async countUnreadMessages(params: {
    conversationId: string;
    authId: string;
    type: 'user' | 'customer';
  }): Promise<number> {
    const { conversationId, authId, type } = params;

    // Conversation interne : comptage par participant (voir ci-dessus).
    if (type === 'user') {
      const internes = await this.compterNonLusInternes([conversationId], authId);
      if (internes.has(conversationId)) return internes.get(conversationId)!;
      /**
       * Absente de la carte : soit la conversation a un client et relève du
       * comptage historique ci-dessous, soit elle est interne et n'a rien de
       * neuf. On distingue les deux en vérifiant la participation, sans quoi un
       * groupe à jour retomberait sur le filtre client et compterait zéro par
       * un chemin qui ne veut rien dire.
       */
      const estInterne = await this.prisma.conversationUser.findFirst({
        where: { userId: authId, conversationId, conversation: { customerId: null } },
        select: { conversationId: true },
      });
      if (estInterne) return 0;
    }

    return this.prisma.message.count({
      where: {
        conversationId,
        isRead: false,
        /**
         * ⚠️ Un message de DIFFUSION n'est pas « non lu » pour le personnel :
         * c'est le personnel qui l'a envoyé. Sans cette exclusion, chaque
         * diffusion ferait apparaître autant de conversations non lues qu'elle
         * a de destinataires, et le compteur du menu deviendrait inutilisable.
         */
        /**
         * ⚠️ Cet ensemble DOIT être celui que le marquage blanchit, sinon un
         * badge reste allumé pour toujours. Le marquage côté personnel ne
         * touche que les messages du CLIENT ; compter en plus ceux des autres
         * agents laissait les conversations internes définitivement non lues.
         *
         * Les diffusions restent exclues : c'est le personnel qui les envoie,
         * et une campagne ferait apparaître autant de conversations non lues
         * qu'elle a de destinataires.
         */
        ...(type === 'user' ? { authorCustomerId: { not: null }, broadcastId: null } : {}),
        /**
         * ⚠️ Côté CLIENT, on compte les messages du PERSONNEL, et le test porte
         * sur la nullité de l'auteur.
         *
         * Le filtre était `authorCustomerId != moi`. Or un message du personnel
         * et un message de diffusion ont tous deux un auteur client NUL : la
         * valeur du compteur dépendait donc entièrement de la façon dont Prisma
         * traite `not` face à une colonne nulle, et un changement de
         * comportement aurait éteint le badge du client sans que rien ne le
         * signale. C'est aussi exactement l'ensemble que vise le marquage de
         * lecture : les deux doivent coïncider, sinon un badge peut rester
         * allumé pour toujours.
         *
         * Les diffusions comptent bien ici, contrairement au personnel : pour
         * le client, c'est un message reçu comme un autre.
         */
        ...(type === 'customer'
          ? {
              // ⚠️ Une diffusion n'a AUCUN auteur, ni personnel ni client : le
              // seul test sur `authorUserId` la rendait invisible, et le badge
              // ne s'allumait donc jamais pour la fonctionnalité même de
              // diffusion. On vise « tout ce qui ne vient pas du client ».
              OR: [{ authorUserId: { not: null } }, { broadcastId: { not: null } }],
            }
          : {}),
      },
    });
  }

  /**
   * Batch count des messages non-lus pour N conversations en une seule requête
   */
  private async batchCountUnreadMessages(
    conversationIds: string[],
    authId: string,
    type: 'user' | 'customer',
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();

    const counts = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        conversationId: { in: conversationIds },
        isRead: false,
        // Même exclusion que ci-dessus : voir `countUnreadMessages`.
        /**
         * ⚠️ Cet ensemble DOIT être celui que le marquage blanchit, sinon un
         * badge reste allumé pour toujours. Le marquage côté personnel ne
         * touche que les messages du CLIENT ; compter en plus ceux des autres
         * agents laissait les conversations internes définitivement non lues.
         *
         * Les diffusions restent exclues : c'est le personnel qui les envoie,
         * et une campagne ferait apparaître autant de conversations non lues
         * qu'elle a de destinataires.
         */
        ...(type === 'user' ? { authorCustomerId: { not: null }, broadcastId: null } : {}),
        // Même raisonnement que ci-dessus : voir `countUnreadMessages`.
        ...(type === 'customer'
          ? {
              // ⚠️ Une diffusion n'a AUCUN auteur, ni personnel ni client : le
              // seul test sur `authorUserId` la rendait invisible, et le badge
              // ne s'allumait donc jamais pour la fonctionnalité même de
              // diffusion. On vise « tout ce qui ne vient pas du client ».
              OR: [{ authorUserId: { not: null } }, { broadcastId: { not: null } }],
            }
          : {}),
      },
      _count: { id: true },
    });

    const map = new Map<string, number>();
    counts.forEach((c) => map.set(c.conversationId, c._count.id));

    /**
     * Les conversations INTERNES ne sont pas dans le compte ci-dessus : son
     * filtre ne retient que les messages du client, et un message d'agent n'en
     * a pas. Elles sont comptées séparément, par participant, puis fusionnées.
     * Les deux ensembles sont disjoints, une conversation ayant un client ou
     * n'en ayant pas.
     */
    if (type === 'user') {
      const internes = await this.compterNonLusInternes(conversationIds, authId);
      internes.forEach((valeur, id) => map.set(id, valeur));
    }

    return map;
  }
}
