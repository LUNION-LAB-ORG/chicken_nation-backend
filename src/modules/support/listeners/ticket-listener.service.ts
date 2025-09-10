import { InjectQueue } from "@nestjs/bullmq";
import { OnEvent } from "@nestjs/event-emitter";
import { Queue } from "bullmq";
import { ResponseTicketDto } from "../dtos/response-ticket.dto";
import { SupportWebSocketService } from "../websockets/support-websocket.service";

export class TicketListenerService {
	constructor(
		private readonly supportWebSocketService: SupportWebSocketService,
		@InjectQueue('tickets') private readonly ticketsQueue: Queue,
	) { }

	@OnEvent('ticket.created')
	handleTicketCreatedEvent(payload: ResponseTicketDto) {
		this.ticketsQueue.add(
			'auto-assign',
			{ ticketId: payload.id },
			{
				attempts: Infinity,
				backoff: {
					type: 'fixed', // délai constant entre chaque tentative
					delay: 10000
				},
				removeOnComplete: true,
				removeOnFail: false
			}
		);
		this.supportWebSocketService.emitNewTicket(payload);
	}

	@OnEvent('ticket.updated')
	handleTicketUpdatedEvent(payload: ResponseTicketDto) {
		this.supportWebSocketService.emitUpdateTicket(payload);
	}
}