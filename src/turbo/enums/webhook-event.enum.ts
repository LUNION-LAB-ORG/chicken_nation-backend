export enum WebhookEvent {
    DELIVERY_CREATED = 'created', // Lorsqu'une course est créée
    DELIVERY_COURIER_ASSIGNED = 'courier_assigned', // Lorsqu'un livreur est affecté
    DELIVERY_PICKUP_STARTED = 'pickup_started', // Lorsqu'une course est prise en charge
    DELIVERY_PICKED_UP = 'picked_up', // Lorsqu'une course est récupérée
    DELIVERY_IN_TRANSIT = 'in_transit', // Lorsqu'une course est en cours de livraison
    DELIVERY_DELIVERED = 'delivered', // Lorsqu'une course est livrée
    DELIVERY_CANCELLED = 'cancelled', // Lorsqu'une course est annulée
    COURIER_LOCATION_UPDATED = 'courier.location_updated', // Lorsqu'un livreur met à jour sa position
    DELIVERY_EMERGENCY = 'emergency', // Lorsqu'une course est en urgence
}
