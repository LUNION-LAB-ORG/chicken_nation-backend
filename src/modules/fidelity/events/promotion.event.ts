import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';


@Injectable()
export class PromotionEvent {

    constructor(
        private eventEmitter: EventEmitter2,
    ) { }

    /**
     * Émet un événement de promotion utilisée
     */
    async promotionUsed(payload: any) {
        this.eventEmitter.emit(
            'promotion.used',
            payload
        );
    }
}