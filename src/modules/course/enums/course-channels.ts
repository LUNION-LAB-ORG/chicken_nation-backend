/**
 * Canaux WebSocket et EventEmitter pour le module course.
 * Pattern cohérent avec OrderChannels.
 */
export enum CourseChannels {
  /** Nouvelle offer envoyée à un livreur (push vers `deliverer_{id}`) */
  COURSE_OFFER_NEW = 'course:offer:new',

  /**
   * Offre fermée : expirée sans réponse (`motif: 'EXPIREE'`) ou close par le
   * serveur sans pénalité (motif de clôture). Relayée au livreur, dont l'appli
   * ferme l'offre affichée.
   */
  COURSE_OFFER_EXPIRED = 'course:offer:expired',

  /** Offre refusée par le livreur. INTERNE (journal), pas relayée aux sockets. */
  COURSE_OFFER_REFUSED = 'course:offer:refused',

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

  /**
   * « Sac rapporté » (28/10) : la caisse a reçu le sac d'une livraison que le
   * livreur avait annulée. Socket seulement, vers `deliverer_{id}` (le premier
   * livreur) : `{ order_id, reference }`. L'appli relit ses sacs, vibre et
   * affiche « Sac rendu ».
   */
  SAC_RAPPORTE = 'deliverer:sac:rapporte',

  // ── Canaux CLIENT (app cliente — suivi de livraison temps réel) ──────────
  // Émis vers la room `customer_{id}` par DeliveryTrackingService. Noms courts
  // et orientés "client" (pas le préfixe `course:` interne du backoffice).

  /** Position GPS live du livreur pendant la livraison du client. */
  CUSTOMER_DELIVERY_LOCATION = 'delivery:location',

  /** Changement de statut de LA livraison du client (en route, arrivé, livré…). */
  CUSTOMER_DELIVERY_STATUT_CHANGED = 'delivery:statut:changed',
}
