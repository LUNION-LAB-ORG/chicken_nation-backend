import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { CourseChannels } from '../enums/course-channels';
import type {
  CourseAssignedPayload,
  CourseCancelledPayload,
  CourseCompletedPayload,
  CourseOfferNewPayload,
  CourseStatutChangedPayload,
  DeliveryStatutChangedPayload,
} from '../interfaces/course-event.interface';
import { CourseWebSocketService } from '../websockets/course-websocket.service';

/**
 * Relaie les événements internes (EventEmitter2) vers les WebSocket sockets.
 * Pont event-bus ↔ socket.io (pattern OrderListenerService).
 */
@Injectable()
export class CourseListenerService {
  constructor(private readonly ws: CourseWebSocketService) {}

  @OnEvent(CourseChannels.COURSE_OFFER_NEW)
  onOfferNew(payload: CourseOfferNewPayload) {
    this.ws.emitOfferNew(payload);
  }

  @OnEvent(CourseChannels.COURSE_OFFER_EXPIRED)
  onOfferExpired(payload: { course_id: string; deliverer_id: string }) {
    this.ws.emitOfferExpired(payload);
  }

  @OnEvent(CourseChannels.COURSE_ASSIGNED)
  onAssigned(payload: CourseAssignedPayload) {
    this.ws.emitAssigned(payload);
  }

  @OnEvent(CourseChannels.COURSE_STATUT_CHANGED)
  onStatutChanged(payload: CourseStatutChangedPayload) {
    this.ws.emitStatutChanged(payload);
  }

  @OnEvent(CourseChannels.DELIVERY_STATUT_CHANGED)
  onDeliveryStatutChanged(payload: DeliveryStatutChangedPayload) {
    this.ws.emitDeliveryStatutChanged(payload);
  }

  @OnEvent(CourseChannels.COURSE_COMPLETED)
  onCompleted(payload: CourseCompletedPayload) {
    this.ws.emitCompleted(payload);
  }

  @OnEvent(CourseChannels.COURSE_CANCELLED)
  onCancelled(payload: CourseCancelledPayload) {
    this.ws.emitCancelled(payload);
  }
}
