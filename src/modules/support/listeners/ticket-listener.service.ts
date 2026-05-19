import { InjectQueue } from "@nestjs/bullmq";
import { OnEvent } from "@nestjs/event-emitter";
import { Queue } from "bullmq";
import { TicketStatus } from "@prisma/client";
import { ResponseTicketDto } from "../dtos/response-ticket.dto";
import { SupportWebSocketService } from "../websockets/support-websocket.service";
import { Logger } from "@nestjs/common";
import { PrismaService } from "src/database/services/prisma.service";

export class TicketListenerService {
	private readonly logger = new Logger(TicketListenerService.name);
	constructor(
		private readonly supportWebSocketService: SupportWebSocketService,
		@InjectQueue('tickets') private readonly ticketsQueue: Queue,
		private readonly prisma: PrismaService,
	) { }

	/**
	 * Enfile un job d'auto-assignation pour un ticket.
	 *
	 * Décisions :
	 * - jobId stable par ticket (= dédup auto par BullMQ ; pas de doublons si on
	 *   re-enfile alors qu'un job est encore en attente).
	 * - attempts: 20 + backoff fixe 30s → 10 minutes de tentatives. Au-delà,
	 *   le job est abandonné (removeOnFail: true). Le ticket reste avec
	 *   `assigneeId: null` et sera re-enfilé via @OnEvent('user.online') quand
	 *   un agent compétent passe online.
	 */
	private enqueueAutoAssign(ticketId: string, categoryId: string) {
		return this.ticketsQueue.add(
			'auto-assign',
			{ ticketId, categoryId },
			{
				jobId: `auto-assign-${ticketId}`,
				attempts: 20,
				backoff: {
					type: 'fixed',
					delay: 30000, // 30s
				},
				removeOnComplete: true,
				removeOnFail: true,
			},
		);
	}

	@OnEvent('ticket.created')
	handleTicketCreatedEvent(payload: ResponseTicketDto) {
		this.logger.log(`Handling ticket.created event ${payload.id}`);
		this.enqueueAutoAssign(payload.id, payload.category.id);
		this.supportWebSocketService.emitNewTicket(payload);
	}

	@OnEvent('ticket.updated')
	handleTicketUpdatedEvent(payload: ResponseTicketDto) {
		this.logger.log(`Handling ticket.updated event ${payload.id}`);
		this.supportWebSocketService.emitUpdateTicket(payload);
	}

	/**
	 * Quand un agent (type='user') passe online via WebSocket, on ré-enfile
	 * l'auto-assignation pour tous les tickets pending dans ses catégories.
	 *
	 * Couvre le cas où :
	 *  - les retries initiaux (20 × 30s) se sont épuisés avant qu'un agent ne soit dispo
	 *  - OU les agents online dans la catégorie étaient tous saturés (≥5 tickets)
	 *  - OU le ticket a été créé hors heures d'ouverture
	 *
	 * BullMQ dédup automatiquement via le jobId stable : si un job est encore
	 * en attente, on ne crée pas de doublon.
	 */
	@OnEvent('user.online')
	async handleUserOnlineEvent(payload: { userId: string }) {
		try {
			// 1. Récupérer les catégories sur lesquelles l'agent est compétent
			const skills = await this.prisma.ticketUserSkill.findMany({
				where: { userId: payload.userId },
				select: { categoryId: true },
			});

			if (skills.length === 0) {
				// Pas un agent support — silencieux
				return;
			}

			const categoryIds = skills.map((s) => s.categoryId);

			// 2. Trouver les tickets pending dans ces catégories
			const pendingTickets = await this.prisma.ticketThread.findMany({
				where: {
					assigneeId: null,
					status: TicketStatus.OPEN,
					categoryId: { in: categoryIds },
				},
				select: { id: true, categoryId: true },
			});

			if (pendingTickets.length === 0) return;

			this.logger.log(
				`Agent ${payload.userId} online → re-enqueue de ${pendingTickets.length} ticket(s) pending`,
			);

			// 3. Ré-enfiler chaque ticket (dédup par jobId stable)
			await Promise.all(
				pendingTickets.map((t) =>
					t.categoryId ? this.enqueueAutoAssign(t.id, t.categoryId) : null,
				),
			);
		} catch (error) {
			this.logger.error(
				`Erreur lors du re-enqueue tickets pour agent ${payload.userId}: ${error instanceof Error ? error.message : error}`,
			);
		}
	}
}
