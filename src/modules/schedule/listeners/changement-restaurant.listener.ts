import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import type { DelivererRestaurantChangedPayload } from 'src/modules/deliverers/events/deliverer.event';

import { DeplacementPlanning, SchedulePlanningService } from '../services/schedule-planning.service';

/**
 * Livreur rattaché à un autre restaurant (demande du 09/11, « changer en un
 * geste ») : ses plannings suivent (`deplacerLivreur`). Le module des
 * livreurs ne peut pas importer celui du planning (qui l'importe) : il émet
 * l'événement et attend cette réponse.
 */
@Injectable()
export class ChangementRestaurantListener {
  constructor(private readonly planning: SchedulePlanningService) {}

  @OnEvent(DelivererChannels.DELIVERER_RESTAURANT_CHANGED)
  async onRestaurantChange(payload: DelivererRestaurantChangedPayload): Promise<DeplacementPlanning> {
    return this.planning.deplacerLivreur({
      delivererId: payload.delivererId,
      ancienRestaurantId: payload.ancienRestaurantId,
      nouveauRestaurantId: payload.nouveauRestaurantId,
    });
  }
}
