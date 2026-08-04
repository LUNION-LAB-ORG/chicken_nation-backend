import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, Restaurant } from '@prisma/client';

/**
 * Forme PUBLIQUE d'un restaurant : sans les secrets (apikey Turbo / tokens HubRise).
 * C'est ce que renvoie `RestaurantService.PUBLIC_SELECT` et ce qui transite dans les
 * événements relayés en WebSocket (revue sécurité 31/07). Un `Restaurant` complet
 * reste assignable à ce type, donc les appelants qui passent l'objet complet compilent.
 */
type PublicRestaurant = Omit<
    Restaurant,
    'apikey' | 'hubrise_access_token' | 'hubrise_location_id' | 'hubrise_catalog_id' | 'hubrise_customer_list_id'
>;


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
    async restaurantUpdatedEvent(payload: PublicRestaurant) {
        this.eventEmitter.emit(
            'restaurant.updated',
            payload
        );
    }
    /**
     * Emet un évènement de la désactivation d'un restaurant
     */
    async restaurantDeactivatedEvent(payload: PublicRestaurant) {
        this.eventEmitter.emit(
            'restaurant.deactivated',
            payload
        );
    }
    /**
     * Emet un évènement de la réactivation d'un restaurant
     */
    async restaurantReactivatedEvent(payload: PublicRestaurant) {
        this.eventEmitter.emit(
            'restaurant.reactivated',
            payload
        );
    }

    /**
     * Emet un évènement de la suppression d'un restaurant
     */
    async restaurantDeletedEvent(payload: PublicRestaurant) {
        this.eventEmitter.emit(
            'restaurant.deleted',
            payload
        );
    }
}