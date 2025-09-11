import { InjectQueue } from "@nestjs/bullmq";
import { OnEvent } from "@nestjs/event-emitter";
import { Queue } from "bullmq";
import { ResponseTicketDto } from "../dtos/response-ticket.dto";
import { SupportWebSocketService } from "../websockets/support-websocket.service";
import { Logger } from "@nestjs/common";

export class TicketListenerService {
	private readonly logger = new Logger(TicketListenerService.name);
	constructor(
		private readonly supportWebSocketService: SupportWebSocketService,
		@InjectQueue('tickets') private readonly ticketsQueue: Queue,
	) { }

	@OnEvent('ticket.created')
	handleTicketCreatedEvent(payload: ResponseTicketDto) {
		// TODO: Creer des queues spécifiques par catégorie
		this.logger.log(`Handling ticket.created event ${payload.id}`);
		this.ticketsQueue.add(
			`auto-assign-${payload.id}`,
			{
				ticketId: payload.id,
				categoryId: payload.category.id
			},
			{
				attempts: 9999,
				backoff: {
					type: 'fixed', // délai constant entre chaque tentative
					delay: 30000 // 30 secondes de délai entre chaque tentative
				},
				removeOnComplete: true,
				removeOnFail: false
			}
		);
		this.supportWebSocketService.emitNewTicket(payload);
	}

	@OnEvent('ticket.updated')
	handleTicketUpdatedEvent(payload: ResponseTicketDto) {
		this.logger.log(`Handling ticket.updated event ${payload.id}`);
		this.supportWebSocketService.emitUpdateTicket(payload);
	}
}