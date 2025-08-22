import { Injectable } from '@nestjs/common';
import { QueryMessagesDto } from '../dtos/query-messages.dto';
import { Request } from 'express';
import { PrismaService } from '../../../database/services/prisma.service';
import { ResponseMessageDto } from '../dtos/response-message.dto';
import { QueryResponseDto } from '../../../common/dto/query-response.dto';
import { ConversationsService } from './conversations.service';
import { getAuthType } from '../utils/getTypeUser';
import { Customer, User } from '@prisma/client';
import { CreateMessageDto } from '../dto/createMessageDto';

@Injectable()
export class MessageService {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly prismaService: PrismaService,
  ) {}

  async getMessages(
    req: Request,
    conversationId: string,
    filter: QueryMessagesDto,
  ): Promise<QueryResponseDto<ResponseMessageDto>> {
    const { limit = 10, page = 1 } = filter;
    const skip = (page - 1) * limit;

    // Validate the conversationId
    const conversation = await this.conversationsService.getConversationById(
      req,
      conversationId,
    );

    // If the conversation does not exist, throw an error
    if (!conversation) {
      throw new Error('Conversation not found');
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
        },
      }),
      this.prismaService.message.count({
        where: whereClause,
      }),
    ]);

    // Map the messages to the ResponseMessageDto format
    const mappedMessages = messages.map((message) =>
      this.mapMessagesField(message),
    );

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
  ): Promise<ResponseMessageDto> {
    const { body } = createMessageDto;
    if (!body || body.trim() === '') {
      throw new Error('Message body is required and must be a non-empty string');
    }

    const auth = req.user ?? await this.prismaService.user.findFirst(); // TODO: supprimer

    if (!auth) {
      throw new Error('User not authenticated');
    }

    const authType = getAuthType(auth);

    // Validate the conversationId
    const conversation = await this.conversationsService.getConversationById(
      req,
      conversationId,
    );

    // If the conversation does not exist, throw an error
    if (!conversation) {
      throw new Error('Conversation not found');
    }

    console.log(auth);

    // Create a new message in the database
    const message = await this.prismaService.message.create({
      data: {
        body,
        conversationId: conversation.id,
        authorUserId: authType === 'user' ? (auth as User).id : null, // Set user ID if authenticated as user
        authorCustomerId: authType === 'customer' ? (auth as Customer).id : null, // Set customer ID if authenticated as customer
      },
      include: {
        authorUser: true, // Include user details if needed
        authorCustomer: true, // Include customer details if needed
      },
    });

    // Map the created message to ResponseMessageDto format
    return this.mapMessagesField(message);
  }

  private mapMessagesField(message: any): ResponseMessageDto {
    return {
      id: message.id,
      conversationId: message.conversationId,
      body: message.body,
      isRead: message.isRead,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      authorUser: message.authorUser
        ? {
            id: message.authorUser.id,
            name: message.authorUser.name,
            email: message.authorUser.email,
          }
        : null,
      authorCustomer: message.authorCustomer
        ? {
            id: message.authorCustomer.id,
            name: message.authorCustomer.name,
            email: message.authorCustomer.email,
          }
        : null,
    };
  }
}
