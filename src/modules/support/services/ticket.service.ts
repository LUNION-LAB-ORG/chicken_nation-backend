import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { PrismaService } from '../../../database/services/prisma.service';
import { CreateTicketDto } from '../dtos/create-ticket.dto';
import { QueryTicketsDto } from '../dtos/query-tickets.dto';
import { ResponseTicketDto } from '../dtos/response-ticket.dto';
import { generateSequentialTicketCode, generateTicketPrefix } from '../utils/code-generator';

@Injectable()
export class TicketService {
  constructor(private readonly prisma: PrismaService) { }

  private userSelect: Prisma.UserSelect = {
    id: true,
    fullname: true,
    phone: true,
    image: true,
    role: true,
  }

  private includeFields: Prisma.TicketThreadInclude = {
    customer: {
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        image: true,
      },
    },
    assignee: {
      select: this.userSelect,
    },
    participants: { include: { user: { select: this.userSelect } } },
    messages: {
      orderBy: { createdAt: 'desc' },
      take: 10,
    },
    order: { select: { id: true, reference: true } },
  }

  async getAllTickets(filter: QueryTicketsDto): Promise<QueryResponseDto<ResponseTicketDto>> {
    const { page = 1, limit = 10 } = filter;

    const [tickets, total] = await Promise.all([
      this.prisma.ticketThread.findMany({
        include: this.includeFields,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.ticketThread.count()
    ]);

    return {
      data: tickets.map(ticket => this.mapTicketToDto(ticket)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getCustomerTickets(customerId: string, filter: QueryTicketsDto): Promise<QueryResponseDto<ResponseTicketDto>> {
    const { page = 1, limit = 10 } = filter;

    const [tickets, total] = await Promise.all([
      this.prisma.ticketThread.findMany({
        where: { customerId },
        include: this.includeFields,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.ticketThread.count({ where: { customerId } })
    ]);

    return {
      data: tickets.map(ticket => this.mapTicketToDto(ticket)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTicketById(id: string): Promise<ResponseTicketDto> {
    const ticket = await this.prisma.ticketThread.findUnique({
      where: { id },
      include: this.includeFields,
    });

    if (!ticket) {
      throw new HttpException('Ticket not found', 404);
    }

    return this.mapTicketToDto(ticket);
  }

  async createTicket(data: CreateTicketDto): Promise<ResponseTicketDto> {
    const { category } = data;
    const lastTicket = await this.prisma.ticketThread.findFirst({
      orderBy: { createdAt: 'desc' },
      where: { category },
    });
    const lastNumber = lastTicket ? parseInt(lastTicket.code.split('-')[1]) : 0;
    const prefix = generateTicketPrefix(category);
    const code = generateSequentialTicketCode(prefix, lastNumber);

    const ticket = await this.prisma.ticketThread.create({
      data: {
        code: code,
        subject: data.subject,
        status: data.status,
        priority: data.priority,
        category: data.category,
        source: data.source,
        customerId: data.customerId,
        assigneeId: data.assigneeId,
        fromConversationId: data.fromConversationId,
        orderId: data.orderId,
      },
      include: this.includeFields,
    });

    return this.mapTicketToDto(ticket);
  }

  async updateTicket(id: string, data: Partial<CreateTicketDto>): Promise<ResponseTicketDto> {
    const { subject, status, priority, category, assigneeId, orderId } = data;
    const ticket = await this.prisma.ticketThread.update({
      where: { id },
      data: {
        subject,
        status,
        priority,
        category,
        assigneeId,
        orderId,
      },
      include: this.includeFields,
    });

    if (!ticket) {
      throw new HttpException('Ticket not found', 404);
    }

    return this.mapTicketToDto(ticket);
  }

  private mapTicketToDto(ticket: any): ResponseTicketDto {
    return {
      id: ticket.id,
      reference: ticket.reference,
      customer: {
        id: ticket.customer.id,
        name: `${ticket.customer.first_name} ${ticket.customer.last_name}`,
        first_name: ticket.customer.first_name,
        last_name: ticket.customer.last_name,
        email: ticket.customer.email,
        image: ticket.customer.image,
      },
      assignee: ticket.assignee,
      participants: ticket.participants.map(participant => participant.user),
      messages: ticket.messages,
      order: ticket.order,
    };
  }
}
