import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { OnesignalService } from '../onesignal.service';
import { ScheduledNotificationService } from '../scheduled-notification.service';

/**
 * CRON — Exécution des notifications planifiées / récurrentes (OneSignal)
 *
 * Tourne toutes les minutes et vérifie si des notifications sont "dues"
 * (next_run_at <= maintenant && active = true && channel != 'expo_push').
 *
 * Pour chaque notification due :
 *  1. Construit le payload OneSignal à partir du contenu + ciblage sauvegardés
 *  2. Envoie via OneSignal API
 *  3. Crée un PushCampaign pour l'historique et les stats
 *  4. Met à jour : send_count++, last_sent_at, next_run_at (ou désactive si once)
 */
@Injectable()
export class OnesignalScheduledTask {
  private readonly logger = new Logger(OnesignalScheduledTask.name);

  /** Verrou pour éviter les exécutions concurrentes */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly onesignalService: OnesignalService,
    private readonly scheduledService: ScheduledNotificationService,
  ) {}

  // Toutes les minutes
  @Cron('* * * * *')
  async processScheduled() {
    if (this.running) return;
    this.running = true;

    try {
      const allDue = await this.scheduledService.findDueNotifications();
      // Filtrer uniquement les notifications OneSignal (pas expo_push, géré par PushScheduledTask)
      const dueNotifications = allDue.filter((n) => n.channel !== 'expo_push');

      if (dueNotifications.length === 0) return;

      this.logger.log(
        `📬 ${dueNotifications.length} notification(s) OneSignal planifiée(s) à envoyer`,
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
          const result = await this.onesignalService.createMessage(onesignalPayload as any);
          const recipients = (result as any)?.recipients ?? 0;

          // Créer un PushCampaign pour l'historique
          const title = (payload?.title as string) ?? (payload?.headings as any)?.en ?? notif.name;
          const body = (payload?.body as string) ?? (payload?.contents as any)?.en ?? '';

          await this.prisma.pushCampaign.create({
            data: {
              name: `[OneSignal] ${notif.name}`,
              title,
              body,
              target_type: targeting.type === 'segments' ? 'all' : targeting.type ?? 'all',
              target_config: (notif.targeting as any) ?? {},
              status: 'sent',
              total_targeted: recipients,
              total_sent: recipients,
              total_failed: 0,
              sent_at: new Date(),
              created_by: notif.created_by,
            },
          });

          // Marquer comme envoyé (incrémente send_count, calcule prochain next_run_at)
          await this.scheduledService.markAsSent(notif.id);

          this.logger.log(
            `✅ "${notif.name}" envoyée (envoi #${notif.send_count + 1}, ${recipients} destinataires) — type: ${notif.schedule_type}`,
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
