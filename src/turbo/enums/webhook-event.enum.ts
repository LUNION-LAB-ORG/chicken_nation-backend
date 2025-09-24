export enum WebhookEvent {
    DELIVERY_CREATED = 'delivery.created', // Lorsqu'une course est créée
    DELIVERY_COURIER_ASSIGNED = 'delivery.courier_assigned', // Lorsqu'un livreur est affecté
    DELIVERY_PICKUP_STARTED = 'delivery.pickup_started', // Lorsqu'une course est prise en charge
    DELIVERY_PICKED_UP = 'delivery.picked_up', // Lorsqu'une course est récupérée
    DELIVERY_IN_TRANSIT = 'delivery.in_transit', // Lorsqu'une course est en cours de livraison
    DELIVERY_DELIVERED = 'delivery.delivered', // Lorsqu'une course est livrée
    DELIVERY_CANCELLED = 'delivery.cancelled', // Lorsqu'une course est annulée
    COURIER_LOCATION_UPDATED = 'courier.location_updated', // Lorsqu'un livreur met à jour sa position
    DELIVERY_EMERGENCY = 'delivery.emergency', // Lorsqu'une course est en urgence
}
