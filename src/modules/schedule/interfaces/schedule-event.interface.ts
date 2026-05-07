import { PresenceCheckResponse, ShiftAssignmentStatus, ShiftType } from '@prisma/client';

/**
 * Payloads des événements émis par ScheduleEvent.
 */

export interface SchedulePlanSentPayload {
  planId: string;
  restaurantId: string;
  periodStart: string; // ISO date
  periodEnd: string;
  /** Livreurs concernés (= ceux qui ont au moins 1 assignment dans le plan). */
  delivererIds: string[];
}

export interface ScheduleAssignmentUpdatedPayload {
  assignmentId: string;
  delivererId: string;
  shiftId: string;
  newStatus: ShiftAssignmentStatus;
  date: string; // ISO date
  shiftType: ShiftType;
}

export interface SchedulePresenceCheckRequestPayload {
  delivererId: string;
  date: string; // ISO date
  /** Type de shift principal du jour si déterminable (peut être null). */
  shiftType: ShiftType | null;
}

export interface ScheduleRestDayChangedPayload {
  restDayId: string;
  delivererId: string;
  date: string;
  /** `'added'` ou `'removed'`. */
  action: 'added' | 'removed';
}

/** Payload envoyé au mobile pour la réponse au check-in. */
export interface PresenceCheckResponsePayload {
  delivererId: string;
  date: string;
  response: PresenceCheckResponse;
}
