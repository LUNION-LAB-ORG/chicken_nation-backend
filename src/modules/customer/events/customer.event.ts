import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Customer } from '@prisma/client';
import { CUSTOMER_EVENTS } from '../contantes/customer-events.contante';

@Injectable()
export class CustomerEvent {
    constructor(
        private eventEmitter: EventEmitter2,
    ) { }

    /**
     * Emet un évènement lors de l'inscription d'un client
     */
    async customerCreatedEvent(payload: { customer: Customer }) {
        this.eventEmitter.emit(
            CUSTOMER_EVENTS.CUSTOMER_CREATED,
            payload
        );
    }

    /**
     * Emet un évènement lors de l'activation d'un client
     */
    async customerActivatedEvent(payload: { customer: Customer }) {
        this.eventEmitter.emit(
            CUSTOMER_EVENTS.CUSTOMER_ACTIVATED,
            payload
        );
    }

    /**
     * Emet un évènement lors de la désactivation d'un client
     */
    async customerDeactivatedEvent(payload: { customer: Customer }) {
        this.eventEmitter.emit(
            CUSTOMER_EVENTS.CUSTOMER_DEACTIVATED,
            payload
        );
    }

    /**
     * Emet un évènement lors de la suppression d'un client
     */
    async customerDeletedEvent(payload: { customer: Customer }) {
        this.eventEmitter.emit(
            CUSTOMER_EVENTS.CUSTOMER_DELETED,
            payload
        );
    }
}
