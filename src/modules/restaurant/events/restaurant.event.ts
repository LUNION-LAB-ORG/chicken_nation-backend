import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, Restaurant } from '@prisma/client';


@Injectable()
export class RestaurantEvent {

    constructor(
        private eventEmitter: EventEmitter2,
    ) { }

    /**
     * Emet un évènement de la création d'un restaurant
     */
    async restaurantCreatedEvent(payload: {
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        restaurant: Restaurant
    }) {
        this.eventEmitter.emit(
            'restaurant.created',
            payload
        );
    }

    /**
     * Emet un évènement de la mise à jour d'un restaurant
     */
    async restaurantUpdatedEvent(payload: Restaurant) {
        this.eventEmitter.emit(
            'restaurant.updated',
            payload
        );
    }
    /**
     * Emet un évènement de la désactivation d'un restaurant
     */
    async restaurantDeactivatedEvent(payload: Restaurant) {
        this.eventEmitter.emit(
            'restaurant.deactivated',
            payload
        );
    }
    /**
     * Emet un évènement de la réactivation d'un restaurant
     */
    async restaurantReactivatedEvent(payload: Restaurant) {
        this.eventEmitter.emit(
            'restaurant.reactivated',
            payload
        );
    }

    /**
     * Emet un évènement de la suppression d'un restaurant
     */
    async restaurantDeletedEvent(payload: Restaurant) {
        this.eventEmitter.emit(
            'restaurant.deleted',
            payload
        );
    }
}