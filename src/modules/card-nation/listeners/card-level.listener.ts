import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LoyaltyLevel } from '@prisma/client';
import { CardNotificationService } from '../services/card-notification.service';
import { CardRequestService } from '../services/card-request.service';

/**
 * Payload minimal de l'événement `loyalty.levelUp` (émis par loyalty.service).
 * Typé localement pour NE PAS importer le module fidelity → évite tout cycle
 * de modules fidelity <-> card-nation (couplage uniquement via l'event bus).
 */
interface LevelUpEventPayload {
  customer: { id: string };
  new_level: LoyaltyLevel;
  bonus_points?: number;
}

/**
 * Écoute la montée de niveau de fidélité pour régénérer l'image de la carte
 * ACTIVE du client (nouveau thème couleur) et le notifier. Entièrement
 * BEST-EFFORT : un échec est loggé et n'impacte jamais le flux fidélité.
 */
@Injectable()
export class CardLevelListener {
  private readonly logger = new Logger(CardLevelListener.name);

  constructor(
    private readonly cardRequestService: CardRequestService,
    private readonly cardNotificationService: CardNotificationService,
  ) {}

  @OnEvent('loyalty.levelUp')
  async handleLevelUp(payload: LevelUpEventPayload) {
    const customerId = payload?.customer?.id;
    if (!customerId) return;

    try {
      const card = await this.cardRequestService.regenerateActiveCard(customerId, payload.new_level);
      // Pas de carte active → rien à régénérer, rien à notifier côté carte.
      if (!card) return;

      await this.cardNotificationService.notifyCardLevelChanged(customerId, card.level);
    } catch (error) {
      this.logger.warn(
        `Régénération/notif carte au level-up (client ${customerId}) échouée (best-effort) : ${(error as Error)?.message}`,
      );
    }
  }
}
