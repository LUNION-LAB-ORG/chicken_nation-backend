import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Customer, Promotion } from '@prisma/client';


@Injectable()
export class PromotionEvent {

    constructor(
        private eventEmitter: EventEmitter2,
    ) { }

    /**
     * Emet un évènement de la création d'une promotion
     */
    async promotionCreatedEvent(payload: Promotion) {
        this.eventEmitter.emit(
            'promotion.created',
            payload
        );
    }

    /**
     * Emet un évènement de la mise à jour d'une promotion
     */
    async promotionUpdatedEvent(payload: Promotion) {
        this.eventEmitter.emit(
            'promotion.updated',
            payload
        );
    }

    /**
     * Émet un événement de promotion utilisée
     */
    async promotionUsedEvent(payload: { customer: Customer; promotion: Promotion; discountAmount: number }) {
        this.eventEmitter.emit(
            'promotion.used',
            payload
        );
    }
}