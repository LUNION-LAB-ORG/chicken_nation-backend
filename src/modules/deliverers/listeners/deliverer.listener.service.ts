import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Deliverer } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { DelivererChannels } from '../enums/deliverer-channels';
import {
  DelivererAutoPausedPayload,
  DelivererLocationUpdatedPayload,
  DelivererOperationalChangedPayload,
  DelivererPendingValidationPayload,
  DelivererQueueChangedPayload,
} from '../events/deliverer.event';
import { DelivererAdminNotificationService } from '../services/deliverer-admin-notification.service';
import { DeliverersWebSocketService } from '../websockets/deliverers-websocket.service';

/**
 * Relaye les événements internes (EventEmitter2) vers les WebSocket sockets
 * et déclenche les notifications email aux admins.
 * Ce fichier est le pont event-bus ↔ socket.io / email, comme OrderListenerService.
 */
@Injectable()
export class DelivererListenerService {
  constructor(
    private readonly wsService: DeliverersWebSocketService,
    private readonly adminNotif: DelivererAdminNotificationService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent(DelivererChannels.DELIVERER_OPERATIONAL_CHANGED)
  async onOperationalChanged(payload: DelivererOperationalChangedPayload) {
    this.wsService.emitOperationalChanged(payload);
  }

  @OnEvent(DelivererChannels.DELIVERER_AUTO_PAUSED)
  async onAutoPaused(payload: DelivererAutoPausedPayload) {
    this.wsService.emitAutoPaused(payload);

    // I-admin : email aux admins quand un livreur est auto-suspendu pour
    // refus répétés. Re-fetch le livreur (le payload n'a que l'ID).
    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: payload.delivererId },
    });
    if (deliverer) {
      void this.adminNotif.notifyDelivererAutoPaused({
        deliverer,
        refusalCount: payload.refusalCount,
        pauseDurationMinutes: payload.windowMinutes,
      });
    }
  }

  @OnEvent(DelivererChannels.DELIVERER_PENDING_VALIDATION)
  async onPendingValidation(payload: DelivererPendingValidationPayload) {
    // Email aux admins → fire-and-forget (le service log les erreurs).
    void this.adminNotif.notifyNewDelivererPending(payload.deliverer as Deliverer);
  }

  @OnEvent(DelivererChannels.DELIVERER_QUEUE_CHANGED)
  onQueueChanged(payload: DelivererQueueChangedPayload) {
    this.wsService.emitQueueChanged(payload);
  }

  /**
   * Relaie chaque position GPS vers le STAFF (carte temps réel des livreurs).
   * HAUTE FRÉQUENCE (~5-8s par livreur) → délégation directe au WS service,
   * SANS aucun accès BDD (le `restaurantId` est déjà dans le payload). Le module
   * course possède son propre @OnEvent sur ce même event pour relayer la
   * position au client de la course active : les deux listeners coexistent.
   */
  @OnEvent(DelivererChannels.DELIVERER_LOCATION_UPDATED)
  onLocationUpdated(payload: DelivererLocationUpdatedPayload) {
    this.wsService.emitLocationLive(payload);
  }
}
