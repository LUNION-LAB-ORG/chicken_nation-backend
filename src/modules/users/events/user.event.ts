import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { User } from '@prisma/client';


@Injectable()
export class UserEvent {

    constructor(
        private eventEmitter: EventEmitter2,
    ) { }

    /**
     * Emet un évènement de la création d'un utilisateur
     */
    async userCreatedEvent(payload: { actor: User, user: Omit<User, 'password' | 'id'> }) {
        this.eventEmitter.emit(
            'user.created',
            payload
        );
    }

    /**
    * Emet un évènement de la création d'un membre
    */
    async memberCreatedEvent(payload: { actor: User, data: Omit<User, 'password' | 'id'> }) {
        this.eventEmitter.emit(
            'member.created',
            payload
        );
    }

    /**
     * Emet un évènement de la activation d'un utilisateur
     */
    async userActivatedEvent(payload: { actor: User, data: User }) {
        this.eventEmitter.emit(
            'user.activated',
            payload
        );
    }

    /**
     * Emet un évènement de la désactivation d'un utilisateur
     */
    async userDeactivatedEvent(payload: { actor: User, data: User }) {
        this.eventEmitter.emit(
            'user.deactivated',
            payload
        );
    }

    /**
     * Emet un évènement de la suppression d'un utilisateur
     */
    async userDeletedEvent(payload: { actor: User, data: User }) {
        this.eventEmitter.emit(
            'user.deleted',
            payload
        );
    }
}