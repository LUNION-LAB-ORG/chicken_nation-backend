import {
  HttpException,
  HttpStatus,
  Injectable,
  // Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/services/prisma.service';
import { Request } from 'express';
import { QueryConversationsDto } from '../dto/query-conversations.dto';
import { QueryResponseDto } from '../../../common/dto/query-response.dto';
import { ResponseConversationsDto } from '../dto/response-conversations.dto';
import { Customer, Prisma, User } from '@prisma/client';
import { CreateConversationDto } from '../dto/create-conversation.dto';
import { getAuthType } from '../utils/getTypeUser';
import { ConversationWebsocketsService } from '../websockets/conversation-websockets.service';
import { ResponseMessageDto } from '../dto/response-message.dto';
import { th } from 'date-fns/locale';

type ConversationWhereUniqueInput = Prisma.ConversationWhereUniqueInput;

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
      // CAS 2 — interne (DM 1–1) : unique par paire (userId, receiver)
      if (!userId || !receiverUserId) {
        throw new HttpException(
          'No userId or receiverUserId',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (userId === receiverUserId) {
        throw new HttpException(
          'Vous ne pouvez pas vous envoyer un message à vous-même',
          HttpStatus.BAD_REQUEST,
        );
      }
      // Verifier que le receiverUserId est bien un employé du restaurant
      const isReceiverInRestaurant = await this.prisma.user.findFirst({
        where: {
          id: receiverUserId,
        },
      });

      if (!isReceiverInRestaurant) {
        throw new NotFoundException("Le destinataire n'existe pas");
      }

      whereClause = {
        restaurantId,
        subject: subject,
        customerId: null, // interne
        AND: [
          { users: { some: { userId } } },
          { users: { some: { userId: receiverUserId } } },
        ],
      };
    }

    const existingConversation = await this.prisma.conversation.findFirst({
      where: whereClause,
      include: this.createConversationInclude(),
    });

    const unreadParams = {
      conversationId: existingConversation?.id || '',
      authId: authType === 'user' ? (auth as User).id : (auth as Customer).id,
      type: authType,
    };

    if (existingConversation) {
      const unreadNumer = await this.countUnreadMessages(unreadParams);

      return this.mapConversationField(existingConversation, unreadNumer);
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        restaurantId,
        customerId: customerIdToUse, // null si interne
        subject: subject,
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
                data: [
                  { userId: userId }, // Ajoute l'utilisateur qui a initié la conversation
                  ...(receiverUserId ? [{ userId: receiverUserId }] : []), // Ajoute le destinataire si c'est un DM
                ],
              },
            },
          }
          : {}),
      },
      include: {
        customer: { select: { id: true, first_name: true, last_name: true } },
        users: { select: { user: { select: { id: true, fullname: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    unreadParams.conversationId = conversation.id;
    const unreadNumer = await this.countUnreadMessages(unreadParams);
    const mappedConversation = this.mapConversationField(
      conversation,
      unreadNumer,
    );

    this.conversationWebsockets.emitConversationCreated(mappedConversation);

    return mappedConversation;
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
        customerId: (auth as Customer).id, // Vérifie si le client est associé à la conversation
      };
    } else if (authType === 'user') {
      whereClause = {
        ...whereClause,
        OR: [
          {
            users: {
              some: {
                userId: (auth as User).id, // Vérifie si l'utilisateur est participant à la conversation
              },
            },
          },
          {
            customerId: {
              not: null, // Si c'est une conversation avec un client
            },
            restaurant: {
              users: {
                some: {
                  id: (auth as User).id, // Vérifie si l'utilisateur est employé du restaurant
                },
              },
            },
          },
        ],
      };
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
        skip: skip,
        take: limit,
      }),
      this.prisma.conversation.count({ where: whereClause }),
    ]);

    // this.logger.debug('Liste des conversations client: ', conversations, total);

    const mappedConversations = await Promise.all(
      conversations.map(async (conversation) => {
        const unreadNumber = await this.countUnreadMessages({
          conversationId: conversation.id,
          authId: customerId,
          type: 'customer',
        });
        return this.mapConversationField(conversation, unreadNumber);
      }),
    );

    // this.logger.debug('Liste des conversations client mapped: ', mappedConversations);

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
  ): Promise<QueryResponseDto<ResponseConversationsDto>> {
    const { limit = 10, page = 1, ...rest } = filter;
    const skip = (page - 1) * limit;

    // this.logger.log('Obtenir liste conversations user: ', userId, " filtre :", filter);

    const whereClause: Prisma.ConversationWhereInput = {
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
        where: whereClause,
        include: this.createConversationInclude(),
        skip: skip,
        take: limit,
      }),
      this.prisma.conversation.count({ where: whereClause }),
    ]);

    // this.logger.debug('Liste des conversations user: ', conversations, total);

    const mappedConversations = await Promise.all(
      conversations.map(async (conversation) => {
        const unreadNumber = await this.countUnreadMessages({
          conversationId: conversation.id,
          authId: userId,
          type: 'user',
        });
        return this.mapConversationField(conversation, unreadNumber);
      }),
    );

    // this.logger.debug('Liste des conversations user mapped: ', mappedConversations);

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
      createdAt: conversation.createdAt,
      messages: conversation.messages.map(
        (
          message: any,
        ): Omit<ResponseMessageDto, 'conversationId' | 'conversation'> => ({
          id: message.id,
          isRead: message.isRead,
          body: message.body,
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
      restaurant: conversation.restaurant
        ? {
          id: conversation.restaurant.id,
          name: conversation.restaurant.name,
          image: conversation.restaurant.image,
        }
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
      })),
    };
  }

  private countUnreadMessages(params: {
    conversationId: string;
    authId: string;
    type: 'user' | 'customer';
  }): Promise<number> {
    const { conversationId, authId, type } = params;
    return this.prisma.message.count({
      where: {
        conversationId,
        isRead: false,
        ...(type === 'user' ? { authorUserId: { not: authId } } : {}),
        ...(type === 'customer' ? { authorCustomerId: { not: authId } } : {}),
      },
    });
  }
}
