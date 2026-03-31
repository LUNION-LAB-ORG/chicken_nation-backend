import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateTicketDto } from '../dtos/create-ticket.dto';
import { QueryTicketsDto } from '../dtos/query-tickets.dto';
import { ResponseTicketDto } from '../dtos/response-ticket.dto';
import { UpdateTicketDto } from '../dtos/update-ticket.dto';
import { TicketEvent } from '../events/ticket.event';
import { generateSequentialTicketCode, generateTicketPrefix } from '../utils/code-generator';
import { CategoriesTicketService } from './categories-ticket.service';

@Injectable()
export class TicketService {
  // private readonly logger = new Logger(TicketService.name);
  private readonly isDev = process.env.NODE_ENV !== 'production';

  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketEvent: TicketEvent,
    private readonly categoryService: CategoriesTicketService
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
    order: { select: { id: true, reference: true, restaurant_id: true } },
    category: { select: { id: true, name: true } },
    _count: { select: { messages: { where: { isRead: false, authorCustomerId: { not: null } } } } },
  }

  private buildWhereClause(filter: QueryTicketsDto, extraWhere?: Prisma.TicketThreadWhereInput): Prisma.TicketThreadWhereInput {
    const where: Prisma.TicketThreadWhereInput = { ...extraWhere };

    if (filter.status?.length) {
      where.status = { in: filter.status };
    }

    if (filter.priority?.length) {
      where.priority = { in: filter.priority };
    }

    if (filter.category?.length) {
      where.categoryId = { in: filter.category };
    }

    if (filter.assignedToId?.length) {
      where.assigneeId = { in: filter.assignedToId };
    }

    if (filter.clientId) {
      where.customerId = filter.clientId;
    }

    if (filter.dateFrom || filter.dateTo) {
      where.createdAt = {};
      if (filter.dateFrom) {
        (where.createdAt as any).gte = new Date(filter.dateFrom);
      }
      if (filter.dateTo) {
        (where.createdAt as any).lte = new Date(filter.dateTo);
      }
    }

    if (filter.restaurantId) {
      where.order = { restaurant_id: filter.restaurantId };
    }

    if (filter.search) {
      const searchTerm = filter.search.trim();
      where.OR = [
        { code: { contains: searchTerm, mode: 'insensitive' } },
        { subject: { contains: searchTerm, mode: 'insensitive' } },
        { customer: { first_name: { contains: searchTerm, mode: 'insensitive' } } },
        { customer: { last_name: { contains: searchTerm, mode: 'insensitive' } } },
        { customer: { email: { contains: searchTerm, mode: 'insensitive' } } },
      ];
    }

    return where;
  }

  async getAllTickets(filter: QueryTicketsDto): Promise<QueryResponseDto<ResponseTicketDto>> {
    const { page = 1, limit = 10 } = filter;
    const where = this.buildWhereClause(filter);

    const [tickets, total] = await Promise.all([
      this.prisma.ticketThread.findMany({
        where,
        include: this.includeFields,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.ticketThread.count({ where })
    ]);

    const mappedTickets = tickets.map(ticket => this.mapTicketToDto(ticket));

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

  async getTicketStats(restaurantId?: string) {
    const baseWhere: Prisma.TicketThreadWhereInput = restaurantId
      ? { order: { restaurant_id: restaurantId } }
      : {};

    const [total, open, inProgress, resolved, closed, high, medium, low] = await Promise.all([
      this.prisma.ticketThread.count({ where: baseWhere }),
      this.prisma.ticketThread.count({ where: { ...baseWhere, status: TicketStatus.OPEN } }),
      this.prisma.ticketThread.count({ where: { ...baseWhere, status: TicketStatus.IN_PROGRESS } }),
      this.prisma.ticketThread.count({ where: { ...baseWhere, status: TicketStatus.RESOLVED } }),
      this.prisma.ticketThread.count({ where: { ...baseWhere, status: TicketStatus.CLOSED } }),
      this.prisma.ticketThread.count({ where: { ...baseWhere, priority: 'HIGH' } }),
      this.prisma.ticketThread.count({ where: { ...baseWhere, priority: 'MEDIUM' } }),
      this.prisma.ticketThread.count({ where: { ...baseWhere, priority: 'LOW' } }),
    ]);

    // Calcul du temps moyen de résolution (tickets résolus avec resolvedAt)
    const resolvedTickets = await this.prisma.ticketThread.findMany({
      where: { ...baseWhere, resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true },
      take: 100,
      orderBy: { resolvedAt: 'desc' },
    });

    let averageResolutionTime = 0;
    if (resolvedTickets.length > 0) {
      const totalMs = resolvedTickets.reduce((sum, t) => {
        return sum + (t.resolvedAt!.getTime() - t.createdAt.getTime());
      }, 0);
      averageResolutionTime = Math.round(totalMs / resolvedTickets.length / 60000); // en minutes
    }

    // Tickets avec au moins un message non lu (de client)
    const unreadTickets = await this.prisma.ticketThread.count({
      where: {
        ...baseWhere,
        messages: {
          some: {
            isRead: false,
            authorCustomerId: { not: null },
          },
        },
      },
    });

    return {
      total,
      open,
      inProgress,
      resolved,
      closed,
      high,
      medium,
      low,
      unreadTickets,
      averageResponseTime: 0,
      averageResolutionTime,
    };
  }

  async getCustomerTickets(customerId: string, filter: QueryTicketsDto): Promise<QueryResponseDto<ResponseTicketDto>> {
    const { page = 1, limit = 10 } = filter;
    const where = this.buildWhereClause(filter, { customerId });

    const [tickets, total] = await Promise.all([
      this.prisma.ticketThread.findMany({
        where,
        include: this.includeFields,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.ticketThread.count({ where })
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
    // this.logger.log(`Recuperer du ticket ${id}`);
    const ticket = await this.prisma.ticketThread.findUnique({
      where: { id },
      include: this.includeFields,
    });

    if (!ticket) {
      // this.logger.warn(`Ticket ${id} introuvable`);
      throw new HttpException('Ticket not found', 404);
    }

    return this.mapTicketToDto(ticket);
  }

  async createTicket(data: CreateTicketDto): Promise<ResponseTicketDto> {
    // this.logger.log(`Création d'un ticket pour customer=${data.customerId}`);

    if (this.isDev) {
      // this.logger.debug(`Payload: ${JSON.stringify(data)}`);
    }

    const { categoryId } = data;

    // Verifier que la catégorie existe

    const [lastTicket, category] = await Promise.all([
      this.prisma.ticketThread.findFirst({
        orderBy: { createdAt: 'desc' },
        where: { categoryId },
      }),
      this.categoryService.findOne(categoryId)
    ]);

    if (!category) {
      // this.logger.warn(`Échec création: catégorie ${categoryId} introuvable`);
      throw new HttpException('Category not found', 404);
    }

    // Vérifier que la commande et le client existent (en parallèle)
    const [order, customer] = await Promise.all([
      data.orderId ? this.prisma.order.findUnique({
        where: { id: data.orderId },
      }) : null,
      this.prisma.customer.findUnique({
        where: { id: data.customerId },
      })
    ]);

    //TODO: activer la verification de l'existence de la commande
    if (data.orderId && !order) {
      // this.logger.warn(`Échec création: commande ${data.orderId} introuvable`);
      throw new HttpException('Order not found', 404);
    }

    if (!customer) {
      // this.logger.warn(`Échec création: client ${data.customerId} introuvable`);
      throw new HttpException('Customer not found', 404);
    }

    const lastNumber = lastTicket ? parseInt(lastTicket.code.split('-')[1]) : 0;
    const prefix = generateTicketPrefix(category.name);
    const code = generateSequentialTicketCode(prefix, lastNumber);

    const ticket = await this.prisma.ticketThread.create({
      data: {
        code: code,
        subject: data.subject,
        status: data.status || 'OPEN',
        priority: data.priority,
        source: data.source,
        customerId: data.customerId,
        assigneeId: data.assigneeId,
        fromConversationId: data.fromConversationId,
        orderId: data.orderId,
        categoryId: data.categoryId,
      },
      include: this.includeFields,
    });

    // this.logger.log(`Ticket créé: id=${ticket.id}, code=${ticket.code}`);

    const ticketDto = this.mapTicketToDto(ticket);

    if (this.isDev) {
      // this.logger.debug(`Ticket DTO: ${JSON.stringify(ticketDto)}`);
    }

    this.ticketEvent.emitTicketCreated(ticketDto);

    return ticketDto;
  }

  async updateTicket(id: string, data: UpdateTicketDto): Promise<ResponseTicketDto> {
    // this.logger.log(`Mise à jour du ticket ${id}`);

    if (this.isDev) {
      // this.logger.debug(`Payload: ${JSON.stringify(data)}`);
    }

    const { subject, status, priority, categoryId, orderId } = data;

    // Si une catégorie est fournie, vérifier qu'elle existe
    if (categoryId) {
      const category = await this.categoryService.findOne(categoryId);

      if (!category) {
        // this.logger.warn(`Échec mise à jour: catégorie ${categoryId} introuvable`);
        throw new HttpException('Category not found', 404);
      }
    }

    const updateData: any = {
      subject,
      status,
      priority,
      orderId,
      categoryId,
    };

    // Si le statut passe à RESOLVED ou CLOSED, enregistrer la date de résolution
    if (status === TicketStatus.RESOLVED || status === TicketStatus.CLOSED) {
      updateData.resolvedAt = new Date();
    }

    const ticket = await this.prisma.ticketThread.update({
      where: { id },
      data: updateData,
      include: this.includeFields,
    });

    if (!ticket) {
      // this.logger.warn(`Échec mise à jour: ticket ${id} introuvable`);
      throw new HttpException('Ticket not found', 404);
    }

    // this.logger.log(`Ticket mis à jour: id=${ticket.id}, code=${ticket.code}`);

    const ticketDto = this.mapTicketToDto(ticket);

    if (this.isDev) {
      // this.logger.debug(`Ticket DTO mis à jour: ${JSON.stringify(ticketDto)}`);
    }

    this.ticketEvent.emitTicketUpdated(ticketDto);

    return ticketDto;
  }

  async closeTicket(id: string): Promise<ResponseTicketDto> {
    // this.logger.log(`Fermeture du ticket ${id}`);

    const ticket = await this.prisma.ticketThread.update({
      where: { id },
      data: {
        status: TicketStatus.CLOSED,
        resolvedAt: new Date(),
      },
      include: this.includeFields,
    });

    if (!ticket) {
      // this.logger.warn(`Échec fermeture: ticket ${id} introuvable`);
      throw new HttpException('Ticket not found', 404);
    }

    // this.logger.log(`Ticket fermé: id=${ticket.id}, code=${ticket.code}`);

    const ticketDto = this.mapTicketToDto(ticket);
    this.ticketEvent.emitTicketClosed(ticketDto);
    return ticketDto;
  }

  private mapTicketToDto(ticket: any): ResponseTicketDto {

    if (this.isDev) {
      // this.logger.debug(`Mapping du ticket: ${ticket.id}`);
    }

    return {
      id: ticket.id,
      code: ticket.code,
      status: ticket.status,
      priority: ticket.priority,
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
      category: ticket.category && {
        id: ticket.category.id,
        name: ticket.category.name,
      } || null,
      unreadCount: ticket._count?.messages ?? 0,
    };
  }
}
