import { Course, CourseStatut, Delivery, DeliveryStatut } from '@prisma/client';

/**
 * Payloads des événements émis par CourseEvent (EventEmitter2).
 * Utilisés par les listeners pour : WebSocket, push notifications, analytics.
 */

export interface CourseWithDetails extends Course {
  deliveries: Delivery[];
}

export interface CourseOfferNewPayload {
  course: CourseWithDetails;
  deliverer_id: string;
  offer_id: string;
  expires_at: Date;
  /**
   * `true` si le livreur est sélectionné via le bonus de chaînage (sa course
   * actuelle se termine imminemment et le nouveau restaurant est proche).
   * Permet à l'app mobile d'afficher un badge explicatif "Chaînage".
   */
  is_chain_bonus?: boolean;
}

export interface CourseAssignedPayload {
  course: CourseWithDetails;
}

export interface CourseStatutChangedPayload {
  course: CourseWithDetails;
  previous_statut: CourseStatut;
  new_statut: CourseStatut;
  reason?: string;
}

export interface DeliveryStatutChangedPayload {
  delivery: Delivery;
  course_id: string;
  course_reference: string;
  previous_statut: DeliveryStatut;
  new_statut: DeliveryStatut;
}

export interface CourseCompletedPayload {
  course: CourseWithDetails;
  success_count: number;
  fail_count: number;
}

export interface CourseCancelledPayload {
  course: CourseWithDetails;
  cancelled_by: string;
  reason?: string;
}
