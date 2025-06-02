import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';


@Injectable()
export class PaiementEvent {

    constructor(
        private eventEmitter: EventEmitter2,
    ) { }

    /**
     * Émet un événement de paiement effectué
     */
    async paiementEffectue(payload: any) {
        this.eventEmitter.emit(
            'paiement.effectue',
            payload
        );
    }


    /**
     * Émet un événement de paiement annulé
     */
    async paiementAnnule(payload: any) {
        this.eventEmitter.emit(
            'paiement.annule',
            payload
        );
    }
}