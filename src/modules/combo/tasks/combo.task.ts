import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ComboService } from '../services/combo.service';

/**
 * CRON — cycle de vie du COMBO MYSTÈRE. Tourne chaque minute : ouvre les parties
 * programmées, ferme celles dont la fenêtre est passée, puis RÈGLE les clôturées
 * (tirage au sort + récompenses).
 *
 * Double backend : chaque transition/règlement est idempotent (updateMany
 * conditionné par le statut + claim atomique CLOSED→SETTLED + UNIQUE ComboWinner).
 * Poser `DISABLE_COMBO_CRON=true` sur les instances non-worker.
 */
@Injectable()
export class ComboTask {
  private readonly logger = new Logger(ComboTask.name);
  private running = false;

  constructor(private readonly comboService: ComboService) {}

  @Cron('* * * * *')
  async processLifecycle() {
    if (process.env.DISABLE_COMBO_CRON === 'true') return;
    if (this.running) return;
    this.running = true;
    try {
      await this.comboService.processLifecycle();
    } catch (e) {
      this.logger.error(`Cycle de vie Combo échoué: ${(e as Error)?.message}`);
    } finally {
      this.running = false;
    }
  }
}
