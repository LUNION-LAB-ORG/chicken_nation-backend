import { Injectable } from '@nestjs/common';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { DelivererChannels } from '../enums/deliverer-channels';
import {
  DelivererAutoPausedPayload,
  DelivererOperationalChangedPayload,
  DelivererQueueChangedPayload,
} from '../events/deliverer.event';

/**
 * Wrapper WebSocket pour les événements livreur.
 * Responsabilités :
 *  - émettre au livreur concerné (room `deliverer_{id}`)
 *  - émettre au backoffice (pour rafraîchir la liste admin)
 *  - émettre au restaurant affecté si applicable
 */
@Injectable()
export class DeliverersWebSocketService {
  constructor(private readonly appGateway: AppGateway) {}

  emitOperationalChanged(payload: DelivererOperationalChangedPayload) {
    const { deliverer, previousStatus, is_operational, reason } = payload;

    const wsPayload = {
      deliverer,
      previousStatus,
      is_operational,
      reason,
      message: this.buildMessage(payload),
    };

    // 1. Livreur concerné → met à jour son état côté mobile (enable/disable du dashboard)
    this.appGateway.emitToDeliverer(
      deliverer.id,
      DelivererChannels.DELIVERER_OPERATIONAL_CHANGED,
      wsPayload,
    );

    // 2. Backoffice → rafraîchit la liste admin
    this.appGateway.emitToBackoffice(
      DelivererChannels.DELIVERER_OPERATIONAL_CHANGED,
      wsPayload,
    );

    // 3. Restaurant affecté → rafraîchit la liste locale des livreurs
    if (deliverer.restaurant_id) {
      this.appGateway.emitToRestaurant(
        deliverer.restaurant_id,
        DelivererChannels.DELIVERER_OPERATIONAL_CHANGED,
        wsPayload,
      );
    }
  }

  emitRefresh() {
    this.appGateway.emitToBackoffice(DelivererChannels.DELIVERER_REFRESH, {
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * P6b : notifie le livreur mobile qu'il a été mis en auto-pause (3 refus / 15 min).
   * Message prêt à afficher côté app. Notifie aussi le backoffice pour visualisation.
   */
  emitAutoPaused(payload: DelivererAutoPausedPayload) {
    const message =
      `Vous avez été mis en pause automatique pendant une période (${payload.refusalCount} refus ` +
      `en ${payload.windowMinutes} min). Reprise à ${new Date(payload.autoPauseUntil).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`;

    const wsPayload = { ...payload, message };

    this.appGateway.emitToDeliverer(
      payload.delivererId,
      DelivererChannels.DELIVERER_AUTO_PAUSED,
      wsPayload,
    );
    this.appGateway.emitToBackoffice(
      DelivererChannels.DELIVERER_AUTO_PAUSED,
      wsPayload,
    );
  }

  /**
   * Notifie tous les livreurs du restaurant que la file FIFO a changé.
   * Chaque livreur reçoit `deliverer:queue:changed` → invalide son cache `scoring-info`
   * → re-fetch le rang mis à jour via REST.
   */
  emitQueueChanged(payload: DelivererQueueChangedPayload) {
    const wsPayload = { delivererId: payload.delivererId, timestamp: new Date().toISOString() };

    // Backoffice : rafraîchit le tableau de bord (positions/queue)
    this.appGateway.emitToBackoffice(DelivererChannels.DELIVERER_QUEUE_CHANGED, wsPayload);

    // Restaurant : notifie tous les livreurs de ce restaurant (via room `restaurant_{id}`)
    if (payload.restaurantId) {
      this.appGateway.emitToRestaurant(
        payload.restaurantId,
        DelivererChannels.DELIVERER_QUEUE_CHANGED,
        wsPayload,
      );
    }
  }

  private buildMessage(payload: DelivererOperationalChangedPayload): string {
    const { deliverer, is_operational, reason } = payload;

    if (is_operational) {
      return 'Votre compte a été validé. Vous pouvez désormais recevoir des courses.';
    }
    if (deliverer.status === 'REJECTED') {
      return `Votre compte a été refusé${reason ? `. Motif : ${reason}` : ''}.`;
    }
    if (deliverer.status === 'SUSPENDED') {
      return `Votre compte a été suspendu${reason ? `. Motif : ${reason}` : ''}.`;
    }
    if (deliverer.status === 'PENDING_VALIDATION') {
      return 'Votre compte est en attente de validation par l\'administrateur.';
    }
    return 'Votre statut a été mis à jour.';
  }
}
