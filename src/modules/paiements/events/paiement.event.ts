import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaiementChannels } from '../enums/paiement-channels';


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
            PaiementChannels.PAIEMENT_SUCCESS,
            payload
        );
    }


    /**
     * Émet un événement de paiement annulé
     */
    async paiementAnnule(payload: any) {
        this.eventEmitter.emit(
            PaiementChannels.PAIEMENT_CANCEL,
            payload
        );
    }
}