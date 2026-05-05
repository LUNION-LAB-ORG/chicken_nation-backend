import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ScheduleChannels } from '../enums/schedule-channels';
import type {
  SchedulePlanSentPayload,
  ScheduleAssignmentUpdatedPayload,
  SchedulePresenceCheckRequestPayload,
  ScheduleRestDayChangedPayload,
} from '../interfaces/schedule-event.interface';

/**
 * Émetteur d'événements internes du module schedule (pattern OrderEvent / CourseEvent).
 * Les listeners (WebSocket, push) sont enregistrés dans ScheduleListenerService.
 */
@Injectable()
export class ScheduleEvent {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  async planSent(payload: SchedulePlanSentPayload) {
    this.eventEmitter.emit(ScheduleChannels.SCHEDULE_PLAN_SENT, payload);
  }

  async assignmentUpdated(payload: ScheduleAssignmentUpdatedPayload) {
    this.eventEmitter.emit(ScheduleChannels.SCHEDULE_ASSIGNMENT_UPDATED, payload);
  }

  async presenceCheckRequest(payload: SchedulePresenceCheckRequestPayload) {
    this.eventEmitter.emit(ScheduleChannels.SCHEDULE_PRESENCE_CHECK_REQUEST, payload);
  }

  async restDayChanged(payload: ScheduleRestDayChangedPayload) {
    this.eventEmitter.emit(ScheduleChannels.SCHEDULE_REST_DAY_CHANGED, payload);
  }
}
