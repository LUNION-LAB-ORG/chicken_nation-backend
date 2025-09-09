import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { PrismaService } from '../../../database/services/prisma.service';
import { CreateTicketDto } from '../dtos/create-ticket.dto';
import { QueryTicketsDto } from '../dtos/query-tickets.dto';
import { ResponseTicketDto } from '../dtos/response-ticket.dto';
import { generateSequentialTicketCode, generateTicketPrefix } from '../utils/code-generator';
import { SupportWebSocketService } from '../websockets/support-websocket.service';

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);
  private readonly isDev = process.env.NODE_ENV !== 'production';

  constructor(
    private readonly prisma: PrismaService,
    private readonly supportWebSocketService: SupportWebSocketService
  ) { }

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
    this.logger.log(`Récupération de tickets (page=${filter.page ?? 1}, limit=${filter.limit ?? 10})`);

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

    this.logger.log(`Tickets récupérés: ${tickets.length}/${total}`);

    if (this.isDev) {
      this.logger.debug(`Filtres: ${JSON.stringify(filter)}`);
      this.logger.debug(`Tickets bruts: ${JSON.stringify(tickets)}`);
    }

    const mappedTickets = tickets.map(ticket => this.mapTicketToDto(ticket));

    if (this.isDev) {
      this.logger.debug(`Tickets mappés: ${JSON.stringify(mappedTickets)}`);
    }

    return {
      data: mappedTickets,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getCustomerTickets(customerId: string, filter: QueryTicketsDto): Promise<QueryResponseDto<ResponseTicketDto>> {
    this.logger.log(`Tickets du client ${customerId} (page=${filter.page ?? 1}, limit=${filter.limit ?? 10})`);

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

    this.logger.log(`Tickets récupérés pour client ${customerId}: ${tickets.length}/${total}`);

    if (this.isDev) {
      this.logger.debug(`Filtres du client ${customerId}: ${JSON.stringify(filter)}`);
      this.logger.debug(`Tickets du client ${customerId} bruts: ${JSON.stringify(tickets)}`);
    }

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
    this.logger.log(`Recuperer du ticket ${id}`);
    const ticket = await this.prisma.ticketThread.findUnique({
      where: { id },
      include: this.includeFields,
    });

    if (!ticket) {
      this.logger.warn(`Ticket ${id} introuvable`);
      throw new HttpException('Ticket not found', 404);
    }

    return this.mapTicketToDto(ticket);
  }

  async createTicket(data: CreateTicketDto): Promise<ResponseTicketDto> {
    this.logger.log(`Création d'un ticket pour customer=${data.customerId}`);

    if (this.isDev) {
      this.logger.debug(`Payload: ${JSON.stringify(data)}`);
    }

    const { category } = data;
    const lastTicket = await this.prisma.ticketThread.findFirst({
      orderBy: { createdAt: 'desc' },
      where: { category },
    });

    const lastNumber = lastTicket ? parseInt(lastTicket.code.split('-')[1]) : 0;
    const prefix = generateTicketPrefix(category);
    const code = generateSequentialTicketCode(prefix, lastNumber);

    // Vérifier que la commande et le client existent (en parallèle)
    const [order, customer] = await Promise.all([
      data.orderId ? this.prisma.order.findUnique({
        where: { id: data.orderId },
      }) : null,
      this.prisma.customer.findUnique({
        where: { id: data.customerId },
      })
    ]);

    if (data.orderId && !order) {
      this.logger.warn(`Échec création: commande ${data.orderId} introuvable`);
      throw new HttpException('Order not found', 404);
    }

    if (!customer) {
      this.logger.warn(`Échec création: client ${data.customerId} introuvable`);
      throw new HttpException('Customer not found', 404);
    }

    const ticket = await this.prisma.ticketThread.create({
      data: {
        code: code,
        subject: data.subject,
        status: data.status || 'OPEN',
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

    this.logger.log(`Ticket créé: id=${ticket.id}, code=${ticket.code}`);

    const ticketDto = this.mapTicketToDto(ticket);

    if (this.isDev) {
      this.logger.debug(`Ticket DTO: ${JSON.stringify(ticketDto)}`);
    }

    this.supportWebSocketService.emitNewTicket(ticketDto);

    return ticketDto;
  }

  async updateTicket(id: string, data: Partial<CreateTicketDto>): Promise<ResponseTicketDto> {
    this.logger.log(`Mise à jour du ticket ${id}`);

    if (this.isDev) {
      this.logger.debug(`Payload: ${JSON.stringify(data)}`);
    }

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
      this.logger.warn(`Échec mise à jour: ticket ${id} introuvable`);
      throw new HttpException('Ticket not found', 404);
    }

    this.logger.log(`Ticket mis à jour: id=${ticket.id}, code=${ticket.code}`);

    const ticketDto = this.mapTicketToDto(ticket);

    if (this.isDev) {
      this.logger.debug(`Ticket DTO mis à jour: ${JSON.stringify(ticketDto)}`);
    }

    this.supportWebSocketService.emitUpdateTicket(ticketDto);

    return ticketDto;
  }

  private mapTicketToDto(ticket: any): ResponseTicketDto {

    if (this.isDev) {
      this.logger.debug(`Mapping du ticket: ${ticket.id}`);
    }

    return {
      id: ticket.id,
      code: ticket.code,
      customer: {
        id: ticket.customer.id,
        name: `${ticket.customer.first_name} ${ticket.customer.last_name}`,
        first_name: ticket.customer.first_name,
        last_name: ticket.customer.last_name,
        email: ticket.customer.email,
        image: ticket.customer.image,
      },
      assignee: ticket.assignee && {
        id: ticket.assignee?.id,
        name: ticket.assignee ? ticket.assignee.fullname : null,
        phone: ticket.assignee ? ticket.assignee.phone : null,
        image: ticket.assignee ? ticket.assignee.image : null,
        role: ticket.assignee ? ticket.assignee.role : null,
      } || null,
      participants: ticket.participants.map(participant => ({
        id: participant.user.id,
        name: participant.user.fullname,
        phone: participant.user.phone,
        image: participant.user.image,
        role: participant.user.role,
      })),
      messages: ticket.messages,
      order: {
        id: ticket.order?.id,
        reference: ticket.order?.reference,
        restaurantId: ticket.order?.restaurant_id,
      },
    };
  }
}
