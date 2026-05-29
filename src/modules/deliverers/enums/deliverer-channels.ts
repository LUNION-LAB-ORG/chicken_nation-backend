/**
 * Canaux d'événements métier pour les livreurs.
 * Émis via EventEmitter2 puis relayés en WebSocket par DelivererWebSocketService.
 */
export enum DelivererChannels {
  // Opérationnel (validation admin, affectation, suspension)
  DELIVERER_OPERATIONAL_CHANGED = 'deliverer:operational:changed',

  // Cycle de vie du compte
  DELIVERER_VALIDATED = 'deliverer:validated',
  DELIVERER_REJECTED = 'deliverer:rejected',
  DELIVERER_SUSPENDED = 'deliverer:suspended',
  DELIVERER_REACTIVATED = 'deliverer:reactivated',
  DELIVERER_ASSIGNED = 'deliverer:assigned',

  // Refresh générique pour l'admin
  DELIVERER_REFRESH = 'deliverer:refresh',

  // Pause forcée déclenchée après N refus en X min (Phase P6b)
  DELIVERER_AUTO_PAUSED = 'deliverer:auto-paused',

  // I-admin : nouveau livreur a complété son inscription, attend validation admin.
  // Émis par AuthDelivererService.completeRegistration, écouté par
  // DelivererListenerService → email aux ADMIN actifs.
  DELIVERER_PENDING_VALIDATION = 'deliverer:pending-validation',

  // Changement d'état dans la file FIFO (pause, reprise, disponible, indisponible).
  // Déclenche un recalcul de rang chez tous les livreurs du même restaurant.
  DELIVERER_QUEUE_CHANGED = 'deliverer:queue:changed',

  // Nouvelle position GPS remontée par le livreur (POST /deliverers/me/location).
  // ÉVÉNEMENT INTERNE uniquement (event-bus) — PAS un canal WS exposé tel quel.
  // Écouté par DEUX listeners :
  //  1. module course (DeliveryTrackingService) → relaie `delivery:location` au(x)
  //     client(s) de la course active (room `customer_{id}`).
  //  2. DelivererListenerService → relaie `deliverer:location:live` au STAFF
  //     (room `backoffice_all` + `restaurant_{id}`) pour la carte temps réel.
  DELIVERER_LOCATION_UPDATED = 'deliverer:location:updated',

  // Position GPS live diffusée au STAFF (backoffice + restaurant) pour la carte
  // temps réel des livreurs. Contrairement à DELIVERER_LOCATION_UPDATED (bus
  // interne), ceci est un VRAI canal WebSocket auquel le backoffice s'abonne.
  // Émis pour CHAQUE remontée GPS d'un livreur opérationnel (pas seulement en
  // course) → la Carte Live admin voit glisser tous les livreurs en direct.
  DELIVERER_LOCATION_LIVE = 'deliverer:location:live',
}
