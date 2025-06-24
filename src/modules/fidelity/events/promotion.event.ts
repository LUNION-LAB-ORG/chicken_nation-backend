import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PromotionManagementEventPayload, PromotionUsedEventPayload } from '../interfaces/promotion.interface';

@Injectable()
export class PromotionEvent {
    constructor(
        private eventEmitter: EventEmitter2,
    ) { }

    /**
     * Emits a promotion creation event
     */
    async promotionCreatedEvent(payload: PromotionManagementEventPayload) {
        this.eventEmitter.emit(
            'promotion.created',
            payload
        );
    }

    /**
     * Emits a promotion update event
     */
    async promotionUpdatedEvent(payload: PromotionManagementEventPayload) {
        this.eventEmitter.emit(
            'promotion.updated',
            payload
        );
    }

    /**
     * Emits a promotion deletion event
     */
    async promotionDeletedEvent(payload: PromotionManagementEventPayload) {
        this.eventEmitter.emit(
            'promotion.deleted',
            payload
        );
    }

    /**
     * Emits a promotion used event
     */
    async promotionUsedEvent(payload: PromotionUsedEventPayload) {
        this.eventEmitter.emit(
            'promotion.used',
            payload
        );
    }
}