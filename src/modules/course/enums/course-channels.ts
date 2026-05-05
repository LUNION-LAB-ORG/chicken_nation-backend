/**
 * Canaux WebSocket et EventEmitter pour le module course.
 * Pattern cohérent avec OrderChannels.
 */
export enum CourseChannels {
  /** Nouvelle offer envoyée à un livreur (push vers `deliverer_{id}`) */
  COURSE_OFFER_NEW = 'course:offer:new',

  /** Offer expirée sans réponse */
  COURSE_OFFER_EXPIRED = 'course:offer:expired',

  /** Livreur a accepté l'offer — devient sa course active */
  COURSE_ASSIGNED = 'course:assigned',

  /** Transition de statut de la Course globale */
  COURSE_STATUT_CHANGED = 'course:statut:changed',

  /** Transition de statut d'une Delivery individuelle */
  DELIVERY_STATUT_CHANGED = 'course:delivery:statut:changed',

  /** Course terminée (toutes deliveries DELIVERED ou FAILED) */
  COURSE_COMPLETED = 'course:completed',

  /** Course annulée */
  COURSE_CANCELLED = 'course:cancelled',

  /** Rafraîchissement générique (backoffice) */
  COURSE_REFRESH = 'course:refresh',
}
