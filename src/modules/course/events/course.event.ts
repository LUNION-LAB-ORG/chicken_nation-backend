import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { CourseChannels } from '../enums/course-channels';
import type {
  CourseAssignedPayload,
  CourseCancelledPayload,
  CourseCompletedPayload,
  CourseOfferNewPayload,
  CourseStatutChangedPayload,
  DeliveryStatutChangedPayload,
} from '../interfaces/course-event.interface';

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

  async offerExpired(payload: { course_id: string; deliverer_id: string }) {
    this.eventEmitter.emit(CourseChannels.COURSE_OFFER_EXPIRED, payload);
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

  async refresh() {
    this.eventEmitter.emit(CourseChannels.COURSE_REFRESH, {
      timestamp: new Date().toISOString(),
    });
  }
}
