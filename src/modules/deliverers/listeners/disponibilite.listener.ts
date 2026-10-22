import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DelivererChannels } from '../enums/deliverer-channels';
import { DisponibiliteLivreurService } from '../services/disponibilite-livreur.service';

/**
 * Pont du bus interne vers la disponibilité du livreur.
 *
 * La déconnexion (`POST /auth/deliverer/logout`) est servie par le module
 * d'authentification, que le module des livreurs importe : il ne peut pas
 * appeler ce service directement. Il émet `DELIVERER_LOGGED_OUT` et attend
 * (`emitAsync`) la fin de ce traitement.
 */
@Injectable()
export class DisponibiliteListener {
  constructor(private readonly disponibilite: DisponibiliteLivreurService) {}

  @OnEvent(DelivererChannels.DELIVERER_LOGGED_OUT)
  async onDeconnexion(payload: { delivererId: string }) {
    await this.disponibilite.deconnecter(payload.delivererId);
  }
}
