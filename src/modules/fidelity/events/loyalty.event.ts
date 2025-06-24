import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LoyaltyLevelUpEvent } from '../interfaces/loyalty-event.interface';


@Injectable()
export class LoyaltyEvent {

    constructor(
        private eventEmitter: EventEmitter2,
    ) { }

    /**
     * Émet un événement de rachat de points
     */
    async redeemPoints(payload: any) {
        this.eventEmitter.emit(
            'loyalty.redeemPoints',
            payload
        );
    }

    /**
    * Émet un événement d'ajout de points
    */
    async addPoints(payload: any) {
        this.eventEmitter.emit(
            'loyalty.addPoints',
            payload
        );
    }

    /**
     * Émet un événement de niveau atteint
     */
    async levelUp(payload: LoyaltyLevelUpEvent) {
        this.eventEmitter.emit(
            'loyalty.levelUp',
            payload
        );
    }
}