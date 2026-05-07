import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { DelivererEvent } from '../events/deliverer.event';
import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';
import { DelivererPushService } from './deliverer-push.service';

/**
 * Service des règles de file d'attente livreur (Phase P5).
 *
 * Consommé par le module `course` aux points clés du cycle de vie d'une offre :
 *
 *   | Événement métier        | Effet queue                                 |
 *   |-------------------------|---------------------------------------------|
 *   | `onAccept(id)`          | Sortie queue (`last_available_at = null`)    |
 *   | `onComplete(id)`        | Retour queue (`last_available_at = now`)     |
 *   | `onRefuse(id)`          | Pénalité positions + historique + auto-pause |
 *   | `onOfferExpired(id)`    | Idem refus (traité comme refus silencieux)   |
 *
 * L'auto-pause est déclenchée automatiquement au N-ième refus dans la fenêtre
 * glissante `auto_pause_refusals_window_min`. Paramètres tous configurables
 * via le backoffice (section "File d'attente & pénalités").
 */
@Injectable()
export class DelivererQueueService {
  private readonly logger = new Logger(DelivererQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: DelivererScoringSettingsHelper,
    private readonly delivererEvent: DelivererEvent,
    // P-push livreur : push CRITIQUE quand auto-pause déclenchée
    private readonly pushService: DelivererPushService,
  ) {}

  /** Livreur accepte une course → sort immédiatement de la queue FIFO. */
  async onAccept(delivererId: string): Promise<void> {
    await this.prisma.deliverer.update({
      where: { id: delivererId },
      data: { last_available_at: null },
    });
    this.logger.debug(`Deliverer ${delivererId.slice(0, 8)} accepted → queue exit`);
  }

  /**
   * Course terminée (toutes deliveries DELIVERED / FAILED / CANCELLED).
   * Remet le livreur en queue SEULEMENT s'il n'est ni en pause ni en auto-pause
   * (ne pas contourner la volonté du livreur ou la sanction).
   */
  async onComplete(delivererId: string): Promise<void> {
    const now = new Date();
    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: { pause_until: true, auto_pause_until: true },
    });
    if (!deliverer) return;

    const inPause = deliverer.pause_until !== null && deliverer.pause_until > now;
    const inAutoPause =
      deliverer.auto_pause_until !== null && deliverer.auto_pause_until > now;

    if (inPause || inAutoPause) {
      this.logger.debug(
        `Deliverer ${delivererId.slice(0, 8)} completed en pause/auto-pause → pas de remise en queue`,
      );
      return;
    }

    await this.prisma.deliverer.update({
      where: { id: delivererId },
      data: { last_available_at: now },
    });
    this.logger.debug(`Deliverer ${delivererId.slice(0, 8)} completed → requeue`);
  }

  /** Livreur refuse explicitement une offre. */
  async onRefuse(delivererId: string): Promise<{ autoPaused: boolean }> {
    return this.applyRefusalPenalty(delivererId, 'refused');
  }

  /** Offre expirée sans réponse (ignore silencieux — traité comme refus). */
  async onOfferExpired(delivererId: string): Promise<{ autoPaused: boolean }> {
    return this.applyRefusalPenalty(delivererId, 'expired');
  }

  // ============================================================
  // HELPER PRIVÉ — applique pénalité + check auto-pause
  // ============================================================

  private async applyRefusalPenalty(
    delivererId: string,
    reason: 'refused' | 'expired',
  ): Promise<{ autoPaused: boolean }> {
    const settings = await this.settings.load();
    const now = new Date();

    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: {
        recent_refusals: true,
        queue_penalty_positions: true,
      },
    });
    if (!deliverer) return { autoPaused: false };

    // Fenêtre glissante : on ne garde que les refus < `autoPauseRefusalsWindowMin` min
    const windowStartMs =
      now.getTime() - settings.autoPauseRefusalsWindowMin * 60_000;
    const previousRefusals = this.parseRefusalTimestamps(deliverer.recent_refusals);
    const recentInWindow = previousRefusals.filter(
      (t) => t.getTime() > windowStartMs,
    );
    const updatedRefusals = [...recentInWindow, now];
    const shouldAutoPause =
      updatedRefusals.length >= settings.autoPauseRefusalsThreshold;

    const penaltyUntil = new Date(
      now.getTime() + settings.refusePenaltyDurationMin * 60_000,
    );
    const newPenaltyPositions =
      (deliverer.queue_penalty_positions ?? 0) + settings.refusePenaltyPositions;

    const data: Prisma.DelivererUpdateInput = {
      recent_refusals: updatedRefusals.map((d) => d.toISOString()),
      queue_penalty_positions: newPenaltyPositions,
      queue_penalty_until: penaltyUntil,
    };

    const autoPauseUntil = shouldAutoPause
      ? new Date(now.getTime() + settings.autoPauseDurationMin * 60_000)
      : null;

    if (autoPauseUntil) {
      data.auto_pause_until = autoPauseUntil;
      // Sortie queue immédiate quand auto-pause déclenchée
      data.last_available_at = null;
    }

    await this.prisma.deliverer.update({ where: { id: delivererId }, data });

    if (autoPauseUntil) {
      this.logger.warn(
        `Deliverer ${delivererId.slice(0, 8)} AUTO-PAUSE (${updatedRefusals.length} refus/${reason} en ${settings.autoPauseRefusalsWindowMin} min) jusqu'à ${autoPauseUntil.toISOString()}`,
      );

      // P6b : notif WS pour informer le livreur mobile + backoffice.
      // Fire-and-forget : un échec d'émission ne doit pas empêcher la sanction.
      try {
        await this.delivererEvent.autoPaused({
          delivererId,
          autoPauseUntil: autoPauseUntil.toISOString(),
          refusalCount: updatedRefusals.length,
          windowMinutes: settings.autoPauseRefusalsWindowMin,
        });
      } catch (err) {
        this.logger.warn(
          `Emit autoPaused event failed for ${delivererId.slice(0, 8)}: ${(err as Error).message}`,
        );
      }

      // P-push livreur : alerte CRITIQUE pour signaler la pause forcée.
      // Le livreur doit savoir POURQUOI il ne reçoit plus d'offres.
      this.pushService.notifyAutoPaused({
        delivererId,
        refusalCount: updatedRefusals.length,
        windowMinutes: settings.autoPauseRefusalsWindowMin,
        durationMinutes: settings.autoPauseDurationMin,
      });
    } else {
      this.logger.log(
        `Deliverer ${delivererId.slice(0, 8)} pénalité (${reason}) : +${settings.refusePenaltyPositions} positions pendant ${settings.refusePenaltyDurationMin} min (${updatedRefusals.length}/${settings.autoPauseRefusalsThreshold} refus fenêtre)`,
      );
    }

    return { autoPaused: shouldAutoPause };
  }

  private parseRefusalTimestamps(raw: unknown): Date[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is string => typeof s === 'string')
      .map((s) => new Date(s))
      .filter((d) => !isNaN(d.getTime()));
  }
}
