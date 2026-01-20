import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Customer, User } from '@prisma/client';
import { Request } from 'express';
import { QueryResponseDto } from '../../../common/dto/query-response.dto';
import { PrismaService } from '../../../database/services/prisma.service';
import { CreateMessageDto } from '../dto/createMessageDto';
import { QueryMessagesDto } from '../dto/query-messages.dto';
import { ResponseMessageDto } from '../dto/response-message.dto';
import { getAuthType } from '../utils/getTypeUser';
import { MessageWebSocketService } from '../websockets/message-websocket.service';
import { ConversationsService } from './conversations.service';
import { S3Service } from '../../../s3/s3.service';

@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);
  private readonly isDev = process.env.NODE_ENV !== 'production';

  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly prismaService: PrismaService,
    private readonly messageWebSocketService: MessageWebSocketService,
    private readonly s3service: S3Service,
  ) { }

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
  ): Promise<ResponseMessageDto> {

    this.logger.debug(`createMessageDto: ${JSON.stringify(createMessageDto)}, conversation ${conversationId}`);

    // Validate the message body
    const { body, imageUrl = '', orderId = null } = createMessageDto;
    if (!body || body.trim() === '') {
      throw new HttpException(
        'Message body is required and must be a non-empty string',
        HttpStatus.BAD_REQUEST
      );
    }

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

    // Upload image to S3 if provided
    const uploadResult = await this.uploadImage(image);
    const finalImageUrl = uploadResult?.key ?? imageUrl;

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
        body,
        conversationId: conversation.id,
        authorUserId: authType === 'user' ? (auth as User).id : null, // Set user ID if authenticated as user
        authorCustomerId:
          authType === 'customer' ? (auth as Customer).id : null, // Set customer ID if authenticated as customer
        meta: {
          imageUrl: finalImageUrl || null,
          orderId: orderId,
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
      },
    });

    // TODO: Chercher comment le faire en une seule requête
    // Ajouter l'utilisateur à la conversation s'il n'y est pas déjà
    // Seulement si c'est une conversation entre un client et un restaurant
    if (authType === 'user') {
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

    // Map the created message to ResponseMessageDto format
    return mappedMessage;
  }

  async markMessagesAsRead(conversationId: string, type: 'USER' | 'CUSTOMER', authorId: string): Promise<boolean> {
    this.logger.log(`Marquer les messages de la conversation ${conversationId} comme lus`);
    const conversation = await this.prismaService.conversation.findUnique({
      where: { id: conversationId },
      include: {
        users:true
      }
    });

    if (!conversation) {
      this.logger.warn(`Conversation ${conversationId} introuvable`);
      throw new NotFoundException('Conversation not found');
    }

    await this.prismaService.message.updateMany({
      where: {
        conversationId,
        isRead: false,
        ...(type === 'USER' ? { authorUserId: { not: authorId } } : { authorCustomerId: { not: authorId } })
      },
      data: { isRead: true },
    });



    this.messageWebSocketService.emitMessagesRead(conversation);

    return true;
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
