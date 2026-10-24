import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DelivererChannels } from '../enums/deliverer-channels';
import type {
  DelivererAutoPausedPayload,
  DelivererLocationUpdatedPayload,
  DelivererQueueChangedPayload,
  DelivererSignalPayload,
} from '../events/deliverer.event';
import { MinuteurEnLigneService } from '../services/minuteur-en-ligne.service';

/**
 * Pont du bus interne vers le minuteur « en ligne » (demande du 24/10).
 *
 *  - signes de vie : requête authentifiée (`DELIVERER_SIGNAL`) et position
 *    (`DELIVERER_LOCATION_UPDATED`, même en arrière-plan), là où
 *    `dernier_signal_at` est écrit ;
 *  - changements d'état dans la file : pause, reprise, entrée dans la file,
 *    déconnexion, mise hors service (`DELIVERER_QUEUE_CHANGED`) et pause
 *    automatique (`DELIVERER_AUTO_PAUSED`), pour arrêter ou relancer le
 *    compte à l'instant exact.
 *
 * Rien n'est attendu : le minuteur ne retarde ni ne fait échouer la requête.
 */
@Injectable()
export class MinuteurEnLigneListener {
  constructor(private readonly minuteur: MinuteurEnLigneService) {}

  @OnEvent(DelivererChannels.DELIVERER_SIGNAL)
  onSignal(payload: DelivererSignalPayload) {
    void this.minuteur.noterSignal(payload.delivererId, new Date(payload.a), payload.etat);
  }

  @OnEvent(DelivererChannels.DELIVERER_LOCATION_UPDATED)
  onPosition(payload: DelivererLocationUpdatedPayload) {
    void this.minuteur.noterSignal(payload.delivererId, new Date(payload.ts));
  }

  @OnEvent(DelivererChannels.DELIVERER_QUEUE_CHANGED)
  onFile(payload: DelivererQueueChangedPayload) {
    void this.minuteur.noterChangement(payload.delivererId);
  }

  @OnEvent(DelivererChannels.DELIVERER_AUTO_PAUSED)
  onPauseAuto(payload: DelivererAutoPausedPayload) {
    void this.minuteur.noterChangement(payload.delivererId);
  }
}
