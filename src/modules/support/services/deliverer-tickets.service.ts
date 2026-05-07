import {
    BadRequestException,
    ForbiddenException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { CreateDelivererTicketDto } from '../dtos/create-deliverer-ticket.dto';
import { QueryTicketsDto } from '../dtos/query-tickets.dto';
import { ResponseTicketDto } from '../dtos/response-ticket.dto';
import { TicketEvent } from '../events/ticket.event';
import { generateSequentialTicketCode, generateTicketPrefix } from '../utils/code-generator';
import { CategoriesTicketService } from './categories-ticket.service';
import { TicketMessageService } from './message.service';

/**
 * Service dédié aux tickets support OUVERTS PAR UN LIVREUR (P-chat livreur).
 *
 * Réutilise les mêmes tables que TicketService (TicketThread + TicketMessage)
 * mais avec :
 *   - delivererId en demandeur (au lieu de customerId)
 *   - authorDelivererId pour les messages du livreur (au lieu de authorCustomerId)
 *
 * Toutes les méthodes vérifient l'appartenance : le livreur ne peut accéder
 * qu'à SES propres tickets (filtre `delivererId = me`).
 */
@Injectable()
export class DelivererTicketsService {
    private readonly logger = new Logger(DelivererTicketsService.name);

    private readonly include: Prisma.TicketThreadInclude = {
        category: { select: { id: true, name: true } },
        assignee: {
            select: { id: true, fullname: true, image: true, role: true },
        },
        messages: {
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: {
                authorUser: {
                    select: { id: true, fullname: true, image: true },
                },
                authorCustomer: {
                    select: { id: true, first_name: true, last_name: true, image: true },
                },
                authorDeliverer: {
                    select: { id: true, first_name: true, last_name: true, image: true },
                },
            },
        },
        // Compteur unread pour le LIVREUR : messages NON lus envoyés par
        // staff (ou customer dans cas exotique d'escalation), mais PAS par
        // le livreur lui-même.
        _count: {
            select: {
                messages: {
                    where: {
                        isRead: false,
                        authorDelivererId: null,
                    },
                },
            },
        },
    };

    constructor(
        private readonly prisma: PrismaService,
        private readonly ticketEvent: TicketEvent,
        private readonly categoryService: CategoriesTicketService,
        private readonly messageService: TicketMessageService,
    ) { }

    /**
     * Liste les tickets ouverts par le livreur connecté.
     */
    async getMyTickets(delivererId: string, filter: QueryTicketsDto) {
        const { page = 1, limit = 20 } = filter;

        const where: Prisma.TicketThreadWhereInput = {
            delivererId,
            ...(filter.status?.length && { status: { in: filter.status } }),
            ...(filter.priority?.length && { priority: { in: filter.priority } }),
        };

        const [tickets, total] = await Promise.all([
            this.prisma.ticketThread.findMany({
                where,
                include: this.include,
                orderBy: { updatedAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.ticketThread.count({ where }),
        ]);

        return {
            data: tickets.map((t) => this.mapToDto(t)),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Détail d'un ticket — vérifie que le ticket appartient bien au livreur.
     */
    async getTicketDetail(ticketId: string, delivererId: string): Promise<ResponseTicketDto> {
        const ticket = await this.prisma.ticketThread.findUnique({
            where: { id: ticketId },
            include: this.include,
        });

        if (!ticket) throw new NotFoundException('Ticket introuvable');
        if (ticket.delivererId !== delivererId) {
            throw new ForbiddenException("Ce ticket ne t'appartient pas");
        }

        return this.mapToDto(ticket);
    }

    /**
     * Crée un nouveau ticket pour le livreur connecté.
     * Inclut automatiquement le 1er message.
     */
    async createTicket(
        delivererId: string,
        dto: CreateDelivererTicketDto,
    ): Promise<ResponseTicketDto> {
        // 1. Vérifier la catégorie
        const category = await this.categoryService.findOne(dto.categoryId);
        if (!category) throw new NotFoundException('Catégorie introuvable');

        // 2. Vérifier la course si fournie + qu'elle appartient bien au livreur
        if (dto.courseId) {
            const course = await this.prisma.course.findUnique({
                where: { id: dto.courseId },
                select: { id: true, deliverer_id: true, reference: true },
            });
            if (!course) throw new NotFoundException('Course introuvable');
            if (course.deliverer_id !== delivererId) {
                throw new ForbiddenException("Cette course ne t'appartient pas");
            }
        }

        // 3. Générer le code séquentiel
        const lastTicket = await this.prisma.ticketThread.findFirst({
            orderBy: { createdAt: 'desc' },
            where: { categoryId: dto.categoryId },
        });
        const lastNumber = lastTicket ? parseInt(lastTicket.code.split('-')[1] || '0') : 0;
        const code = generateSequentialTicketCode(generateTicketPrefix(category.name), lastNumber);

        // 4. Création atomique : ticket + 1er message en transaction
        const ticket = await this.prisma.$transaction(async (tx) => {
            const created = await tx.ticketThread.create({
                data: {
                    code,
                    subject: dto.subject,
                    status: TicketStatus.OPEN,
                    priority: dto.priority ?? 'MEDIUM',
                    source: 'mobile_deliverer',
                    delivererId,
                    categoryId: dto.categoryId,
                },
            });

            await tx.ticketMessage.create({
                data: {
                    ticketId: created.id,
                    body: dto.initialMessage,
                    authorDelivererId: delivererId,
                    internal: false,
                },
            });

            return created;
        });

        const fullTicket = await this.prisma.ticketThread.findUnique({
            where: { id: ticket.id },
            include: this.include,
        });

        if (!fullTicket) throw new HttpException('Erreur lors de la création', 500);

        const dto2 = this.mapToDto(fullTicket);

        // 5. Émettre l'event ticket:created → backoffice + livreur
        this.ticketEvent.emitTicketCreated(dto2);

        this.logger.log(`Ticket ${code} créé par livreur ${delivererId.slice(0, 8)}`);

        return dto2;
    }

    /**
     * Le livreur ferme son propre ticket (statut → CLOSED).
     * Côté staff, l'admin a son propre endpoint /tickets/:id (autre service).
     */
    async closeMyTicket(ticketId: string, delivererId: string): Promise<ResponseTicketDto> {
        const ticket = await this.prisma.ticketThread.findUnique({
            where: { id: ticketId },
        });
        if (!ticket) throw new NotFoundException('Ticket introuvable');
        if (ticket.delivererId !== delivererId) {
            throw new ForbiddenException("Ce ticket ne t'appartient pas");
        }
        if (ticket.status === TicketStatus.CLOSED) {
            throw new BadRequestException('Ticket déjà fermé');
        }

        const updated = await this.prisma.ticketThread.update({
            where: { id: ticketId },
            data: {
                status: TicketStatus.CLOSED,
                resolvedAt: new Date(),
            },
            include: this.include,
        });

        return this.mapToDto(updated);
    }

    /**
     * Mapping vers le DTO de réponse — réutilise la structure de
     * ResponseTicketDto pour cohérence avec le service customer.
     */
    private mapToDto(ticket: any): ResponseTicketDto {
        return {
            id: ticket.id,
            code: ticket.code,
            status: ticket.status,
            priority: ticket.priority,
            customer: null, // Toujours null pour les tickets livreur
            deliverer: ticket.deliverer ? {
                id: ticket.deliverer.id,
                name: `${ticket.deliverer.first_name ?? ''} ${ticket.deliverer.last_name ?? ''}`.trim(),
                first_name: ticket.deliverer.first_name,
                last_name: ticket.deliverer.last_name,
                phone: ticket.deliverer.phone,
                image: ticket.deliverer.image,
            } : null,
            assignee: ticket.assignee ? {
                id: ticket.assignee.id,
                name: ticket.assignee.fullname,
                phone: null,
                image: ticket.assignee.image,
                role: ticket.assignee.role,
            } : null,
            participants: [],
            messages: ticket.messages ?? [],
            order: null,
            category: ticket.category ? {
                id: ticket.category.id,
                name: ticket.category.name,
            } : null,
            unreadCount: ticket._count?.messages ?? 0,
        } as ResponseTicketDto;
    }
}
