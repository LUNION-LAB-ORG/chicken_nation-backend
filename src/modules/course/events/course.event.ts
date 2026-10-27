import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { CourseChannels } from '../enums/course-channels';
import { DemandePlanification, DispatchEvenements } from '../enums/dispatch-evenements';
import type {
  CourseAssignedPayload,
  CourseCancelledPayload,
  CourseCompletedPayload,
  CourseOfferNewPayload,
  CourseStatutChangedPayload,
  DeliveryStatutChangedPayload,
} from '../interfaces/course-event.interface';
import type { OffreExpireePayload } from '../services/offres-cloture.service';
import { LIVRAISON_ANNULEE_PAR_LIVREUR, LivraisonAnnuleeParLivreurPayload } from './livraison-annulee.event';

/**
 * Émetteur d'événements internes du module course (pattern OrderEvent).
 * Les listeners (WebSocket, push) sont enregistrés dans CourseListenerService.
 */
@Injectable()
export class CourseEvent {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  async offerNew(payload: CourseOfferNewPayload) {
    this.eventEmitter.emit(CourseChannels.COURSE_OFFER_NEW, payload);
  }

  async offerExpired(payload: OffreExpireePayload) {
    this.eventEmitter.emit(CourseChannels.COURSE_OFFER_EXPIRED, payload);
  }

  /** Refus explicite d'une offre par le livreur (journal de la diffusion). */
  async offerRefused(payload: { course_id: string; deliverer_id: string; raison?: string | null }) {
    this.eventEmitter.emit(CourseChannels.COURSE_OFFER_REFUSED, payload);
  }

  async courseAssigned(payload: CourseAssignedPayload) {
    this.eventEmitter.emit(CourseChannels.COURSE_ASSIGNED, payload);
  }

  async courseStatutChanged(payload: CourseStatutChangedPayload) {
    this.eventEmitter.emit(CourseChannels.COURSE_STATUT_CHANGED, payload);
  }

  async deliveryStatutChanged(payload: DeliveryStatutChangedPayload) {
    this.eventEmitter.emit(CourseChannels.DELIVERY_STATUT_CHANGED, payload);
  }

  async courseCompleted(payload: CourseCompletedPayload) {
    this.eventEmitter.emit(CourseChannels.COURSE_COMPLETED, payload);
  }

  async courseCancelled(payload: CourseCancelledPayload) {
    this.eventEmitter.emit(CourseChannels.COURSE_CANCELLED, payload);
  }

  /** Livraison d'un client annulée par le livreur (commande intacte) : le module support crée le ticket. */
  livraisonAnnuleeParLivreur(payload: LivraisonAnnuleeParLivreurPayload) {
    this.eventEmitter.emit(LIVRAISON_ANNULEE_PAR_LIVREUR, payload);
  }

  /**
   * Demande un passage du planificateur v2 pour ce restaurant (regroupé par
   * restaurant, 500 ms). Sans effet sous v1 hormis le retour à l'ancienne
   * méthode (courses encore au restaurant marquées parties).
   */
  demanderPlanification(payload: DemandePlanification) {
    if (!payload.restaurant_id) return;
    this.eventEmitter.emit(DispatchEvenements.PLANIFIER_RESTAURANT, payload);
  }

  async refresh() {
    this.eventEmitter.emit(CourseChannels.COURSE_REFRESH, {
      timestamp: new Date().toISOString(),
    });
  }
}
