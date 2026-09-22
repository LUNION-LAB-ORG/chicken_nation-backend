import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateTicketMessageDto } from '../dtos/create-ticket-message.dto';
import { Prisma } from '@prisma/client';
import {
  agregerReactions,
  estEmojiAutorise,
  EMOJIS_REACTION,
  type ReactionAgregee,
} from 'src/common/constantes/emojis-reaction';
import { ResponseTicketMessageDto } from '../dtos/response-ticket-message.dto';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { SupportWebSocketService } from '../websockets/support-websocket.service';
import { ExpoPushService } from '../../../expo-push/expo-push.service';

@Injectable()
export class TicketMessageService {
    private readonly logger = new Logger(TicketMessageService.name);
    constructor(
        private readonly prisma: PrismaService,
        private readonly supportWebSocketService: SupportWebSocketService,
        private readonly expoPushService: ExpoPushService,
    ) { }

    private MessageInclude: Prisma.TicketMessageInclude = {
        // Réactions : agrégées au mapping, jamais renvoyées nominativement.
        reactions: { select: { emoji: true, userId: true, customerId: true, delivererId: true } },
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

        const [message, ticket] = await Promise.all([
            this.prisma.ticketMessage.create({
                data: {
                    body,
                    ticketId,
                    internal,
                    authorCustomerId: authorType === 'CUSTOMER' ? authorId : null,
                    authorUserId: authorType === 'USER' ? authorId : null,
                    meta,
                },
                include: this.MessageInclude,
            }),
            /**
             * ⚠️ `update` et non `findUnique` : on a besoin des mêmes champs,
             * mais SURTOUT de faire remonter le ticket dans la liste.
             *
             * La liste du backoffice est triée par `updatedAt desc`, or
             * `TicketThread.updatedAt` est un `@updatedAt` Prisma : il ne bouge
             * que si la LIGNE DU THREAD est écrite. Créer un message n'y
             * touchait pas. Résultat, un ticket qui recevait un message frais
             * ne remontait pas d'un pixel, pendant que les tickets simplement
             * fermés remontaient en tête parce que `closeTicket`, lui, écrit le
             * thread. La première page ne montrait donc que des tickets clos, et
             * les tickets à traiter coulaient hors de portée : le gestionnaire
             * voyait « 5 non lus » au menu sans jamais pouvoir les trouver.
             *
             * `data: {}` suffit : Prisma pose `updatedAt` de lui-même.
             */
            this.prisma.ticketThread.update({
                where: { id: ticketId },
                data: {},
                select: {
                    customerId: true,
                    delivererId: true,
                    orderId: true,
                    order: { select: { restaurant_id: true } },
                },
            })
        ]);

        const messageDto = this.mapMessageToDto(message);

        const payload = {
            message: messageDto,
            restaurantId: ticket?.order?.restaurant_id || null,
        }

        this.supportWebSocketService.emitNewTicketMessage(ticketId, payload);

        // Push notification au client si message vient du staff et n'est pas interne
        if (authorType === 'USER' && !internal && ticket?.customerId) {
            this.sendPushToCustomer(ticket.customerId, ticketId, body, ticket?.order?.restaurant_id).catch((err) =>
                this.logger.warn(`Push notification ticket client échouée: ${err.message}`),
            );
        }

        // Push notification au livreur si message vient du staff et n'est pas interne
        if (authorType === 'USER' && !internal && ticket?.delivererId) {
            this.sendPushToDeliverer(ticket.delivererId, ticketId, body).catch((err) =>
                this.logger.warn(`Push notification ticket livreur échouée: ${err.message}`),
            );
        }

        return messageDto;
    }

    /**
     * ⚠️ `inclureInternes` n'a pas de valeur par défaut, et c'est délibéré.
     *
     * Cette méthode sert TROIS publics par trois routes distinctes : le
     * personnel, le client et le livreur. Elle ne filtrait pas `internal`, si
     * bien qu'une note écrite entre agents pour usage interne était servie
     * telle quelle au client dans son propre ticket. Un défaut par défaut
     * aurait laissé le prochain appelant hériter du trou en silence : ici,
     * chacun doit dire pour qui il lit.
     */
    async getMessagesByTicketId(ticketId: string, filter: FilterQueryDto, inclureInternes: boolean, monId?: string | null): Promise<QueryResponseDto<ResponseTicketMessageDto>> {
        const { page = 1, limit = 10 } = filter;
        const where: Prisma.TicketMessageWhereInput = {
            ticketId,
            ...(inclureInternes ? {} : { internal: false }),
        };
        const [messages, total] = await Promise.all([
            this.prisma.ticketMessage.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                include: this.MessageInclude,
                skip: (page - 1) * limit,
                take: limit,
            }),
            // ⚠️ MÊME `where` que la liste : un compte plus large ferait
            // promettre une pagination qui ne se remplit jamais.
            this.prisma.ticketMessage.count({ where })
        ]);

        if (!messages) {
            throw new HttpException('Messages not found', 404);
        }

        return {
            // `mine` dépend du lecteur : sans lui, aucune pastille n'apparaîtrait
            // comme étant la sienne.
            data: messages.map(msg => this.mapMessageToDto(msg, monId ?? null)),
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            }
        };
    }


    async markMessagesAsRead(
        ticketId: string,
        type: 'USER' | 'CUSTOMER' | 'DELIVERER',
        authorId: string,
    ): Promise<boolean> {
        this.logger.log(`Marquer les messages du ticket ${ticketId} comme lus (par ${type})`);
        // Marque comme lus tous les messages NON envoyés par cet auteur.
        // Si je suis le livreur, marque comme lus tous les messages qui ne
        // viennent PAS de moi (= messages staff).
        const notMineFilter =
            type === 'USER'
                ? { authorUserId: { not: authorId } }
                : type === 'CUSTOMER'
                    ? { authorCustomerId: { not: authorId } }
                    : { authorDelivererId: { not: authorId } };

        await this.prisma.ticketMessage.updateMany({
            where: {
                ticketId,
                isRead: false,
                ...notMineFilter,
            },
            data: { isRead: true },
        });

        this.supportWebSocketService.emitMessagesRead(ticketId);

        return true;
    }

    private async sendPushToDeliverer(delivererId: string, ticketId: string, body: string) {
        const deliverer = await this.prisma.deliverer.findUnique({
            where: { id: delivererId },
            select: { expo_push_token: true },
        });

        if (!deliverer?.expo_push_token) return;

        await this.expoPushService.sendPushNotifications({
            tokens: [deliverer.expo_push_token],
            title: 'Nouveau message support',
            body: body?.substring(0, 150) || 'Nouveau message',
            sound: 'default',
            data: {
                type: 'new_ticket_message',
                ticketId,
            },
        });
    }

    private async sendPushToCustomer(customerId: string, ticketId: string, body: string, restaurantId?: string | null) {
        const [settings, restaurant] = await Promise.all([
            this.prisma.notificationSetting.findUnique({
                where: { customer_id: customerId },
            }),
            restaurantId
                ? this.prisma.restaurant.findUnique({
                    where: { id: restaurantId },
                    select: { name: true },
                })
                : null,
        ]);

        if (!settings?.expo_push_token || !settings.push || !settings.active) return;

        const title = restaurant?.name || 'Chicken Nation';

        await this.expoPushService.sendPushNotifications({
            tokens: [settings.expo_push_token],
            title,
            body: body?.substring(0, 150) || 'Nouveau message',
            sound: 'default',
            data: {
                type: 'new_ticket_message',
                ticketId,
            },
        });
    }

    /** `monId` : qui lit. `mine` dépend du lecteur, pas du message. */
    private mapMessageToDto(message: any, monId?: string | null): ResponseTicketMessageDto {
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
            reactions: agregerReactions(message.reactions, monId ?? null),
        };
    }

    // ───────────────────────── Réactions ─────────────────────────

    /**
     * Pose, remplace ou retire une réaction sur un message de TICKET.
     *
     * Trois publics peuvent réagir, et chacun a sa porte d'entrée : le
     * personnel, le client demandeur, le livreur demandeur. Le contrôle
     * d'appartenance au ticket est fait par l'appelant, qui seul sait de quel
     * garde il vient ; ici on vérifie ce que lui ne peut pas voir : que le
     * message appartient bien au ticket cité, et qu'un message INTERNE reste
     * hors de portée de qui n'est pas du personnel.
     */
    async basculerReaction(params: {
        ticketId: string;
        messageId: string;
        emoji: string;
        /** Exactement un des trois. */
        userId?: string | null;
        customerId?: string | null;
        delivererId?: string | null;
    }): Promise<{ messageId: string; reactions: ReactionAgregee[] }> {
        const { ticketId, messageId, emoji } = params;

        if (!estEmojiAutorise(emoji)) {
            throw new HttpException(
                `Réaction non reconnue. Valeurs acceptées : ${EMOJIS_REACTION.join(' ')}`,
                HttpStatus.BAD_REQUEST,
            );
        }

        /**
         * Le message est recoupé avec le ticket de l'URL. Sans ce contrôle,
         * connaître un seul identifiant de message suffirait à réagir dans le
         * fil de n'importe quel ticket, le garde d'appartenance ne portant que
         * sur le ticket.
         */
        const message = await this.prisma.ticketMessage.findFirst({
            where: { id: messageId, ticketId },
            select: { id: true, internal: true },
        });
        if (!message) {
            throw new HttpException('Message introuvable', HttpStatus.NOT_FOUND);
        }

        const estPersonnel = !!params.userId;
        if (message.internal && !estPersonnel) {
            // Un client ou un livreur ne VOIT pas les notes internes : il ne
            // doit pas pouvoir y réagir en connaissant leur identifiant.
            throw new HttpException('Message introuvable', HttpStatus.NOT_FOUND);
        }

        const qui = params.userId
            ? { userId: params.userId }
            : params.customerId
                ? { customerId: params.customerId }
                : { delivererId: params.delivererId! };
        const monId = params.userId ?? params.customerId ?? params.delivererId ?? null;

        await this.prisma.$transaction(async (tx) => {
            const existante = await tx.ticketMessageReaction.findFirst({
                where: { ticketMessageId: messageId, ...qui },
                select: { id: true, emoji: true },
            });

            if (!existante) {
                await tx.ticketMessageReaction.create({
                    data: { ticketMessageId: messageId, emoji, ...qui },
                });
            } else if (existante.emoji === emoji) {
                // Reposer le même emoji le retire.
                await tx.ticketMessageReaction.delete({ where: { id: existante.id } });
            } else {
                await tx.ticketMessageReaction.update({
                    where: { id: existante.id },
                    data: { emoji },
                });
            }
        });

        const fraiches = await this.prisma.ticketMessageReaction.findMany({
            where: { ticketMessageId: messageId },
            select: { emoji: true, userId: true, customerId: true, delivererId: true },
        });

        this.supportWebSocketService.emitReactionsChanged(ticketId, messageId, fraiches);

        return { messageId, reactions: agregerReactions(fraiches, monId) };
    }
}

