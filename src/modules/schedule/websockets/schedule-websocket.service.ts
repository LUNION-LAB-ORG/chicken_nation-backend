import { Injectable } from '@nestjs/common';

import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { ScheduleChannels } from '../enums/schedule-channels';
import type {
  ScheduleAssignmentUpdatedPayload,
  SchedulePlanSentPayload,
  SchedulePresenceCheckRequestPayload,
  ScheduleRestDayChangedPayload,
} from '../interfaces/schedule-event.interface';

/**
 * Wrapper WebSocket du module schedule (pattern CourseWebSocketService).
 *
 * Responsabilités :
 *   - Push `schedule:plan:sent` à tous les livreurs concernés (room par livreur)
 *   - Push `schedule:assignment:updated` au livreur concerné + admin pour stats
 *   - Push `schedule:presence-check:request` au livreur (notif quotidienne 8h)
 *   - Push `schedule:rest-day:changed` à l'admin (audit + ajustements)
 */
@Injectable()
export class ScheduleWebSocketService {
  constructor(private readonly appGateway: AppGateway) {}

  emitPlanSent(payload: SchedulePlanSentPayload) {
    for (const delivererId of payload.delivererIds) {
      this.appGateway.emitToDeliverer(
        delivererId,
        ScheduleChannels.SCHEDULE_PLAN_SENT,
        {
          planId: payload.planId,
          periodStart: payload.periodStart,
          periodEnd: payload.periodEnd,
        },
      );
    }
  }

  emitAssignmentUpdated(payload: ScheduleAssignmentUpdatedPayload) {
    this.appGateway.emitToDeliverer(
      payload.delivererId,
      ScheduleChannels.SCHEDULE_ASSIGNMENT_UPDATED,
      payload,
    );
  }

  emitPresenceCheckRequest(payload: SchedulePresenceCheckRequestPayload) {
    this.appGateway.emitToDeliverer(
      payload.delivererId,
      ScheduleChannels.SCHEDULE_PRESENCE_CHECK_REQUEST,
      payload,
    );
  }

  emitRestDayChanged(payload: ScheduleRestDayChangedPayload) {
    // Push à l'admin (room "admin") + au livreur concerné pour cohérence UI.
    this.appGateway.emitToDeliverer(
      payload.delivererId,
      ScheduleChannels.SCHEDULE_REST_DAY_CHANGED,
      payload,
    );
    // TODO: push admin global quand `emitToAdmins()` sera dispo dans AppGateway
  }
}
