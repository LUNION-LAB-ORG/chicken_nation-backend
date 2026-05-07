/**
 * Canaux WebSocket et EventEmitter pour le module schedule (P7.4).
 */
export enum ScheduleChannels {
  /** Plan envoyé aux livreurs (push à tous les livreurs du restaurant) */
  SCHEDULE_PLAN_SENT = 'schedule:plan:sent',

  /** Une assignment d'un livreur a changé de statut (CONFIRMED/REFUSED) */
  SCHEDULE_ASSIGNMENT_UPDATED = 'schedule:assignment:updated',

  /** Push matinal de check-in présence (8h, configurable) */
  SCHEDULE_PRESENCE_CHECK_REQUEST = 'schedule:presence-check:request',

  /** Un repos a été ajouté/retiré (notif admin pour ajustements) */
  SCHEDULE_REST_DAY_CHANGED = 'schedule:rest-day:changed',
}
