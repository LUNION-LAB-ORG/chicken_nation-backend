import {
    BadRequestException,
    ForbiddenException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { EntityStatus, Prisma, TicketPriority, TicketStatus } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import {
    LivraisonAnnuleeParLivreurPayload,
    MOTIF_COURT_ECHEC,
} from 'src/modules/course/events/livraison-annulee.event';

import { CreateDelivererTicketDto } from '../dtos/create-deliverer-ticket.dto';
import { QueryTicketsDto } from '../dtos/query-tickets.dto';
import { ResponseTicketDto } from '../dtos/response-ticket.dto';
import { TicketEvent } from '../events/ticket.event';
import { generateSequentialTicketCode, generateTicketPrefix } from '../utils/code-generator';
import { CategoriesTicketService } from './categories-ticket.service';
import { TicketMessageService } from './message.service';

/** Commande donnée par le livreur, pas livrée dans une de ses courses (ou inconnue). */
export const MESSAGE_COMMANDE_HORS_COURSES = 'Commande hors de tes courses.';

/** Nouveaux essais quand le code du ticket est pris au même instant (P2002). */
const NOUVEAUX_ESSAIS_CODE = 3;

/** Ce que la création d'un ticket du livreur écrit (route de l'appli, ou ticket créé par le serveur). */
interface TicketLivreurACreer {
    subject: string;
    initialMessage: string;
    category: { id: string; name: string };
    orderId?: string;
    priority?: TicketPriority;
}

/** Nom de catégorie comparable : minuscules, sans accents. */
const nomComparable = (nom: string) =>
    nom.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Catégorie d'un ticket créé par le serveur, choisie par son nom : celle qui
 * contient « livraison », sinon « course », sinon la première. Même choix que
 * l'appli du livreur pour « Terminer » (`matchCategory`).
 */
export function choisirCategorieLivraison<T extends { name: string }>(categories: readonly T[]): T | null {
    return (
        categories.find((c) => nomComparable(c.name).includes('livraison')) ??
        categories.find((c) => nomComparable(c.name).includes('course')) ??
        categories[0] ??
        null
    );
}

const estCollisionDeCode = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

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
        // Feuille « Problème » (27/10) : la commande liée, et le livreur
        // (nom, téléphone) pour le centre d'appels qui reçoit l'événement.
        order: { select: { id: true, reference: true, restaurant_id: true } },
        deliverer: {
            select: { id: true, first_name: true, last_name: true, phone: true, image: true },
        },
        assignee: {
            select: { id: true, fullname: true, image: true, role: true },
        },
        messages: {
            // ⚠️ Le livreur ne voit PAS les notes internes du personnel : ce
            // fil est le sien, pas la main courante du support.
            where: { internal: false },
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
     * Crée un nouveau ticket pour le livreur connecté (`POST /tickets/deliverer/me`).
     * Inclut automatiquement le 1er message.
     *
     * Feuille « Problème » (27/10) : « Terminer » crée SEULEMENT ce ticket, la
     * livraison continue (rien n'est écrit sur la livraison, la course ou la
     * commande). `orderId` (facultatif) doit être livrée dans une course de ce
     * livreur, sinon 403 « Commande hors de tes courses. » (commande inconnue
     * comprise) ; il est enregistré et renvoyé, et le restaurant de la
     * commande reçoit le ticket dans sa salle.
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

        // 3. La commande si fournie : livrée dans une course de ce livreur
        // (une commande n'a qu'une livraison, `Delivery.order_id` unique).
        if (dto.orderId) {
            const livraison = await this.prisma.delivery.findUnique({
                where: { order_id: dto.orderId },
                select: { course: { select: { deliverer_id: true } } },
            });
            if (livraison?.course?.deliverer_id !== delivererId) {
                throw new ForbiddenException(MESSAGE_COMMANDE_HORS_COURSES);
            }
        }

        return this.creer(delivererId, {
            subject: dto.subject,
            initialMessage: dto.initialMessage,
            category,
            orderId: dto.orderId,
            priority: dto.priority,
        });
    }

    /**
     * « Annuler » de la feuille « Problème » (27/10) : le serveur crée le
     * ticket du livreur, par le même chemin que `createTicket`, une fois
     * l'annulation de la livraison écrite (`LivraisonAnnuleeListener`).
     * Commande liée, priorité haute, catégorie choisie par son nom parmi les
     * catégories actives. Sans aucune catégorie : pas de ticket (`null`), un
     * avertissement au journal ; l'annulation reste faite.
     */
    async creerTicketAnnulation(p: LivraisonAnnuleeParLivreurPayload): Promise<ResponseTicketDto | null> {
        const categories = await this.prisma.ticketCategory.findMany({
            where: { entity_status: EntityStatus.ACTIVE },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
        });
        const category = choisirCategorieLivraison(categories);
        if (!category) {
            this.logger.warn(
                `Livraison ${p.order_reference} annulée par le livreur ${p.deliverer_id.slice(0, 8)} : ` +
                    'aucune catégorie de ticket, pas de ticket.',
            );
            return null;
        }
        const motif = MOTIF_COURT_ECHEC[p.reason] ?? p.reason;
        return this.creer(p.deliverer_id, {
            subject: `Livraison annulée : ${motif}`,
            initialMessage: `${p.note?.trim() || motif}\nCommande ${p.order_reference} · Course ${p.course_reference}`,
            category,
            orderId: p.order_id,
            priority: TicketPriority.HIGH,
        });
    }

    /**
     * Création atomique du ticket et de son 1er message, puis `ticket.created`
     * (backoffice, attribution automatique, restaurant de la commande). Code
     * séquentiel par préfixe de catégorie ; pris au même instant par un autre
     * ticket (P2002) : relu et réessayé, jusqu'à 3 fois.
     */
    private async creer(delivererId: string, t: TicketLivreurACreer): Promise<ResponseTicketDto> {
        const ticket = await this.inserer(delivererId, t);

        const fullTicket = await this.prisma.ticketThread.findUnique({
            where: { id: ticket.id },
            include: this.include,
        });

        if (!fullTicket) throw new HttpException('Erreur lors de la création', 500);

        const dto2 = this.mapToDto(fullTicket);

        // Émettre l'event ticket:created → backoffice + livreur (+ restaurant de la commande)
        this.ticketEvent.emitTicketCreated(dto2);

        this.logger.log(`Ticket ${ticket.code} créé par livreur ${delivererId.slice(0, 8)}`);

        return dto2;
    }

    /** Le ticket et son 1er message, d'un seul tenant ; code pris au même instant : nouvel essai. */
    private async inserer(delivererId: string, t: TicketLivreurACreer): Promise<{ id: string; code: string }> {
        const prefixe = generateTicketPrefix(t.category.name);
        for (let essai = 0; ; essai++) {
            const code = await this.prochainCode(t.category.id, prefixe, essai > 0);
            try {
                return await this.prisma.$transaction(async (tx) => {
                    const created = await tx.ticketThread.create({
                        data: {
                            code,
                            subject: t.subject,
                            status: TicketStatus.OPEN,
                            priority: t.priority ?? 'MEDIUM',
                            source: 'mobile_deliverer',
                            delivererId,
                            categoryId: t.category.id,
                            orderId: t.orderId,
                        },
                    });

                    await tx.ticketMessage.create({
                        data: {
                            ticketId: created.id,
                            body: t.initialMessage,
                            authorDelivererId: delivererId,
                            internal: false,
                        },
                    });

                    return created;
                });
            } catch (err) {
                if (!estCollisionDeCode(err) || essai >= NOUVEAUX_ESSAIS_CODE) throw err;
                this.logger.warn(`Code de ticket ${code} déjà pris, nouvel essai.`);
            }
        }
    }

    /**
     * Code suivant : après le dernier ticket de la catégorie (comme avant) ;
     * après une collision, après le plus grand code du préfixe (deux
     * catégories peuvent partager le même préfixe).
     */
    private async prochainCode(categoryId: string, prefixe: string, apresCollision: boolean): Promise<string> {
        const dernier = apresCollision
            ? await this.prisma.ticketThread.findFirst({
                  where: { code: { startsWith: `${prefixe}-` } },
                  orderBy: { code: 'desc' },
                  select: { code: true },
              })
            : await this.prisma.ticketThread.findFirst({
                  orderBy: { createdAt: 'desc' },
                  where: { categoryId },
                  select: { code: true },
              });
        const lastNumber = dernier ? parseInt(dernier.code.split('-')[1] || '0') || 0 : 0;
        return generateSequentialTicketCode(prefixe, lastNumber);
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
            // Commande liée (« Problème », 27/10) : même forme que les tickets
            // du personnel (`restaurantId`, lu par la diffusion au restaurant),
            // plus `restaurant_id`.
            order: ticket.order ? {
                id: ticket.order.id,
                reference: ticket.order.reference,
                restaurantId: ticket.order.restaurant_id,
                restaurant_id: ticket.order.restaurant_id,
            } : null,
            category: ticket.category ? {
                id: ticket.category.id,
                name: ticket.category.name,
            } : null,
            unreadCount: ticket._count?.messages ?? 0,
            createdAt: ticket.createdAt,
            updatedAt: ticket.updatedAt,
        } as ResponseTicketDto;
    }
}
