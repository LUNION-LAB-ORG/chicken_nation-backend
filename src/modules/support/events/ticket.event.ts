import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResponseTicketDto } from '../dtos/response-ticket.dto';

@Injectable()
export class TicketEvent {
    private readonly logger = new Logger(TicketEvent.name);
    constructor(private eventEmitter: EventEmitter2) { }

    emitTicketCreated(payload: ResponseTicketDto) {
        this.logger.log(`Emitting ticket.created event ${payload.id}`);
        this.eventEmitter.emit('ticket.created', payload);
    }

    emitTicketUpdated(payload: ResponseTicketDto) {
        this.logger.log(`Emitting ticket.updated event ${payload.id}`);
        this.eventEmitter.emit('ticket.updated', payload);
    }

    emitTicketClosed(payload: ResponseTicketDto) {
        this.logger.log(`Emitting ticket.closed event ${payload.id}`);
        this.eventEmitter.emit('ticket.closed', payload);
    }
}