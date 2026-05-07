import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Deliverer, DelivererStatus } from '@prisma/client';

import { DelivererChannels } from '../enums/deliverer-channels';

export interface DelivererOperationalChangedPayload {
  deliverer: Omit<Deliverer, 'password' | 'refresh_token'>;
  previousStatus: DelivererStatus;
  is_operational: boolean;
  reason?: string;
}

export interface DelivererAutoPausedPayload {
  delivererId: string;
  /** Timestamp ISO jusqu'auquel l'auto-pause est active. */
  autoPauseUntil: string;
  /** Nombre de refus accumulés qui ont déclenché la pause. */
  refusalCount: number;
  /** Fenêtre glissante configurée en minutes (pour message contextuel). */
  windowMinutes: number;
}

export interface DelivererPendingValidationPayload {
  /** Le livreur fraîchement créé (sans champs sensibles). */
  deliverer: Omit<Deliverer, 'password' | 'refresh_token'>;
}

export interface DelivererQueueChangedPayload {
  /** Livreur dont l'état dans la file a changé (pause / reprise / dispo / indisponible). */
  delivererId: string;
  /** Restaurant de rattachement — permet de notifier tous les livreurs du même restaurant. */
  restaurantId: string | null;
}

/**
 * Émetteur d'événements internes pour le cycle de vie du livreur.
 * Les listeners (WebSocket / notifications) sont déclarés en Phase 4.
 */
@Injectable()
export class DelivererEvent {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  async operationalChanged(payload: DelivererOperationalChangedPayload) {
    this.eventEmitter.emit(DelivererChannels.DELIVERER_OPERATIONAL_CHANGED, payload);
  }

  async refreshList() {
    this.eventEmitter.emit(DelivererChannels.DELIVERER_REFRESH, {
      timestamp: new Date().toISOString(),
    });
  }

  /** P6b : livreur mis en auto-pause suite à des refus répétés. */
  async autoPaused(payload: DelivererAutoPausedPayload) {
    this.eventEmitter.emit(DelivererChannels.DELIVERER_AUTO_PAUSED, payload);
  }

  /** I-admin : nouveau livreur a complété son inscription. */
  async pendingValidation(payload: DelivererPendingValidationPayload) {
    this.eventEmitter.emit(DelivererChannels.DELIVERER_PENDING_VALIDATION, payload);
  }

  /**
   * Émis à chaque changement d'état dans la file FIFO (pause, reprise, disponible,
   * indisponible). Tous les livreurs du même restaurant recalculent leur rang en temps réel.
   */
  queueChanged(delivererId: string, restaurantId: string | null) {
    this.eventEmitter.emit(DelivererChannels.DELIVERER_QUEUE_CHANGED, {
      delivererId,
      restaurantId,
    } satisfies DelivererQueueChangedPayload);
  }
}
