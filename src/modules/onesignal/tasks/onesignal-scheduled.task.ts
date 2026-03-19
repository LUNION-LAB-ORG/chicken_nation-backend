import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnesignalService } from '../onesignal.service';
import { ScheduledNotificationService } from '../scheduled-notification.service';

/**
 * CRON — Exécution des notifications planifiées / récurrentes
 *
 * Tourne toutes les minutes et vérifie si des notifications sont "dues"
 * (next_run_at <= maintenant && active = true).
 *
 * Pour chaque notification due :
 *  1. Construit le payload OneSignal à partir du contenu + ciblage sauvegardés
 *  2. Envoie via OneSignal API
 *  3. Met à jour : send_count++, last_sent_at, next_run_at (ou désactive si once)
 */
@Injectable()
export class OnesignalScheduledTask {
  private readonly logger = new Logger(OnesignalScheduledTask.name);

  /** Verrou pour éviter les exécutions concurrentes */
  private running = false;

  constructor(
    private readonly onesignalService: OnesignalService,
    private readonly scheduledService: ScheduledNotificationService,
  ) {}

  // Toutes les minutes
  @Cron('* * * * *')
  async processScheduled() {
    if (this.running) return;
    this.running = true;

    try {
      const dueNotifications = await this.scheduledService.findDueNotifications();

      if (dueNotifications.length === 0) return;

      this.logger.log(
        `📬 ${dueNotifications.length} notification(s) planifiée(s) à envoyer`,
      );

      for (const notif of dueNotifications) {
        try {
          // Construire le payload OneSignal
          const payload = notif.payload as Record<string, unknown>;
          const targeting = notif.targeting as {
            type: string;
            segments?: string[];
            filters?: Record<string, unknown>[];
            aliases?: Record<string, string[]>;
          };

          const onesignalPayload: Record<string, unknown> = {
            ...payload,
            target_channel: notif.channel,
          };

          // Ajouter le ciblage
          switch (targeting.type) {
            case 'segments':
              onesignalPayload.included_segments = targeting.segments ?? [
                'Subscribed Users',
              ];
              break;
            case 'filters':
              onesignalPayload.filters = targeting.filters ?? [];
              break;
            case 'aliases':
              onesignalPayload.include_aliases = targeting.aliases ?? {};
              break;
            default:
              onesignalPayload.included_segments = ['Subscribed Users'];
          }

          // Envoyer via OneSignal
          await this.onesignalService.createMessage(onesignalPayload as any);

          // Marquer comme envoyé (incrémente send_count, calcule prochain next_run_at)
          await this.scheduledService.markAsSent(notif.id);

          this.logger.log(
            `✅ "${notif.name}" envoyée (envoi #${notif.send_count + 1}) — type: ${notif.schedule_type}`,
          );
        } catch (error) {
          this.logger.error(
            `❌ Erreur envoi "${notif.name}" (${notif.id}): ${error.message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Erreur critique processScheduled: ${error.message}`,
        error.stack,
      );
    } finally {
      this.running = false;
    }
  }
}
