import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LoyaltyLevelUpEvent, LoyaltyPointsAddedEvent, LoyaltyPointsExpiredEvent, LoyaltyPointsExpiringSoonEvent, LoyaltyPointsRedeemedEvent } from '../interfaces/loyalty-event.interface';


@Injectable()
export class LoyaltyEvent {

    constructor(
        private eventEmitter: EventEmitter2,
    ) { }

    /**
     * Émet un événement de rachat de points
     */
    async redeemPointsEvent(payload: LoyaltyPointsRedeemedEvent) {
        this.eventEmitter.emit(
            'loyalty.pointsRedeemed',
            payload
        );
    }

    /**
    * Émet un événement d'ajout de points
    */
    async addPointsEvent(payload: LoyaltyPointsAddedEvent) {
        this.eventEmitter.emit(
            'loyalty.pointsAdded',
            payload
        );
    }

    /**
     * Émet un événement de niveau atteint
     */
    async levelUpEvent(payload: LoyaltyLevelUpEvent) {
        this.eventEmitter.emit(
            'loyalty.levelUp',
            payload
        );
    }

    /**
     * Émet un événement d'expiration de points
     */
    async pointsExpiringSoonEvent(payload: LoyaltyPointsExpiringSoonEvent) {
        this.eventEmitter.emit(
            'loyalty.pointsExpiringSoon',
            payload
        );
    }

    /**
     * Émet un événement d'expiration de points
     */
    async pointsExpireEvent(payload: LoyaltyPointsExpiredEvent) {
        this.eventEmitter.emit(
            'loyalty.pointsExpired',
            payload
        );
    }

}