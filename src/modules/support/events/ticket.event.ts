import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable } from "@nestjs/common";
import { ResponseTicketDto } from '../dtos/response-ticket.dto';

@Injectable()
export class TicketEvent {
    constructor(private eventEmitter: EventEmitter2) { }

    emitTicketCreated(payload: ResponseTicketDto) {
        this.eventEmitter.emit('ticket.created', payload);
    }

    emitTicketUpdated(payload: ResponseTicketDto) {
        this.eventEmitter.emit('ticket.updated', payload);
    }

    emitTicketClosed(payload: ResponseTicketDto) {
        this.eventEmitter.emit('ticket.closed', payload);
    }
}