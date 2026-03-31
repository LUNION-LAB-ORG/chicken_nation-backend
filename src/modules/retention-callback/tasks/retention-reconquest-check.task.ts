import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RetentionCallbackService } from '../retention-callback.service';

@Injectable()
export class RetentionReconquestCheckTask {
  private readonly logger = new Logger(RetentionReconquestCheckTask.name);
  private running = false;

  constructor(private readonly callbackService: RetentionCallbackService) {}

  // Toutes les 2 heures
  @Cron('0 */2 * * *')
  async checkReconquest() {
    if (this.running) return;
    this.running = true;

    try {
      this.logger.log('Vérification auto-reconquête en cours...');
      const result = await this.callbackService.checkAutoReconquest();
      this.logger.log(`Auto-reconquête: ${result.checked} vérifiés, ${result.reconquered} reconquis`);
    } catch (error) {
      this.logger.error(`Erreur auto-reconquête: ${error.message}`, error.stack);
    } finally {
      this.running = false;
    }
  }
}
