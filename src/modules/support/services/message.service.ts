import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateTicketMessageDto } from '../dtos/create-ticket-message.dto';
import { Prisma } from '@prisma/client';
import { ResponseTicketMessageDto } from '../dtos/response-ticket-message.dto';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';

@Injectable()
export class TicketMessageService {
    constructor(private readonly prisma: PrismaService) { }

    private MessageInclude: Prisma.TicketMessageInclude = {
        authorCustomer: {
            select: {
                id: true,
                first_name: true,
                last_name: true,
                email: true,
                image: true,
            }
        },
        authorUser: {
            select: {
                id: true,
                fullname: true,
                email: true,
                image: true,
            }
        },
        ticket: {
            select: {
                id: true,
                code: true,
            }
        },
    }

    async createMessage(ticketId: string, data: CreateTicketMessageDto): Promise<ResponseTicketMessageDto> {
        const { body, internal, authorId, authorType, meta } = data;
        let author
        if (authorType === 'USER') {
            author = await this.prisma.user.findUnique({ where: { id: authorId } });
        } else if (authorType === 'CUSTOMER') {
            author = await this.prisma.customer.findUnique({ where: { id: authorId } });
        }

        if (!author) {
            throw new HttpException('Author not found', 404);
        }

        const message = await this.prisma.ticketMessage.create({
            data: {
                body,
                ticketId,
                internal,
                authorCustomerId: authorType === 'CUSTOMER' ? authorId : null,
                authorUserId: authorType === 'USER' ? authorId : null,
                meta,
            },
            include: this.MessageInclude,
        });

        return this.mapMessageToDto(message);
    }

    async getMessagesByTicketId(ticketId: string, filter: FilterQueryDto): Promise<QueryResponseDto<ResponseTicketMessageDto>> {
        const { page = 1, limit = 10 } = filter;
        const [messages, total] = await Promise.all([
            this.prisma.ticketMessage.findMany({
                where: { ticketId },
                orderBy: { createdAt: 'desc' },
                include: this.MessageInclude,
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.ticketMessage.count({ where: { ticketId } })
        ]);

        if (!messages) {
            throw new HttpException('Messages not found', 404);
        }

        return {
            data: messages.map(msg => this.mapMessageToDto(msg)),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            }
        };
    }


    async markMessagesAsRead(ticketId: string): Promise<void> {
        await this.prisma.ticketMessage.updateMany({
            where: { ticketId, isRead: false },
            data: { isRead: true },
        });

        // TODO: Emit event
    }

    private mapMessageToDto(message: any): ResponseTicketMessageDto {
        return {
            id: message.id,
            body: message.body,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            authorUser: message.authorUser ? {
                id: message.authorUser.id,
                name: message.authorUser.fullname,
                email: message.authorUser.email,
                image: message.authorUser.image,
            } : null,
            authorCustomer: message.authorCustomer ? {
                id: message.authorCustomer.id,
                name: `${message.authorCustomer.first_name} ${message.authorCustomer.last_name}`,
                image: message.authorCustomer.image,
                first_name: message.authorCustomer.first_name,
                last_name: message.authorCustomer.last_name,
            } : null,
            ticket: message.ticket,
            isRead: message.isRead,
            internal: message.internal,
        };
    }
}

