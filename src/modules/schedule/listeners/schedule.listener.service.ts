import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { ScheduleChannels } from '../enums/schedule-channels';
import type {
  ScheduleAssignmentUpdatedPayload,
  SchedulePlanSentPayload,
  SchedulePresenceCheckRequestPayload,
  ScheduleRestDayChangedPayload,
} from '../interfaces/schedule-event.interface';
import { ScheduleWebSocketService } from '../websockets/schedule-websocket.service';

/**
 * Listener qui relaye les events internes vers la couche WebSocket.
 * Pattern miroir de CourseListenerService.
 */
@Injectable()
export class ScheduleListenerService {
  constructor(private readonly ws: ScheduleWebSocketService) {}

  @OnEvent(ScheduleChannels.SCHEDULE_PLAN_SENT)
  onPlanSent(payload: SchedulePlanSentPayload) {
    this.ws.emitPlanSent(payload);
  }

  @OnEvent(ScheduleChannels.SCHEDULE_ASSIGNMENT_UPDATED)
  onAssignmentUpdated(payload: ScheduleAssignmentUpdatedPayload) {
    this.ws.emitAssignmentUpdated(payload);
  }

  @OnEvent(ScheduleChannels.SCHEDULE_PRESENCE_CHECK_REQUEST)
  onPresenceCheckRequest(payload: SchedulePresenceCheckRequestPayload) {
    this.ws.emitPresenceCheckRequest(payload);
  }

  @OnEvent(ScheduleChannels.SCHEDULE_REST_DAY_CHANGED)
  onRestDayChanged(payload: ScheduleRestDayChangedPayload) {
    this.ws.emitRestDayChanged(payload);
  }
}
