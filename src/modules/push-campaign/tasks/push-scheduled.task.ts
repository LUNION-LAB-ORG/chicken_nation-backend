import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { PushCampaignService } from '../push-campaign.service';
import { addDays, addMonths, addWeeks } from 'date-fns';

/**
 * CRON — Exécute les notifications planifiées via Expo Push
 *
 * Tourne chaque minute, vérifie les ScheduledNotification dont :
 *   - channel = 'expo_push'
 *   - active = true
 *   - next_run_at <= now
 *
 * Pour chaque notification due :
 *   1. Résout les tokens via PushCampaignService.resolveTargetTokens()
 *   2. Envoie via ExpoPushService
 *   3. Crée un PushCampaign pour l'historique
 *   4. Met à jour next_run_at / send_count / last_sent_at
 */
@Injectable()
export class PushScheduledTask {
  private readonly logger = new Logger(PushScheduledTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPushService: ExpoPushService,
    private readonly pushCampaignService: PushCampaignService,
  ) {}

  @Cron('* * * * *')
  async processScheduledNotifications() {
    const now = new Date();

    const dueNotifications = await this.prisma.scheduledNotification.findMany({
      where: {
        channel: 'expo_push',
        active: true,
        next_run_at: { lte: now },
      },
    });

    if (dueNotifications.length === 0) return;

    this.logger.log(
      `📬 ${dueNotifications.length} notification(s) planifiée(s) à envoyer`,
    );

    for (const notification of dueNotifications) {
      try {
        await this.processOne(notification, now);
      } catch (error) {
        this.logger.error(
          `Erreur traitement notification ${notification.id}: ${error.message}`,
        );
      }
    }
  }

  private async processOne(
    notification: any,
    now: Date,
  ) {
    const payload = notification.payload as any;
    const targeting = notification.targeting as any;

    // 1. Résoudre les tokens
    const tokens = await this.pushCampaignService.resolveTargetTokens(
      targeting?.type ?? 'all',
      targeting?.config ?? {},
    );

    let totalSent = 0;
    let totalFailed = 0;

    // 2. Envoyer via Expo Push
    if (tokens.length > 0) {
      const result = await this.expoPushService.sendPushNotifications({
        tokens,
        title: payload?.title ?? notification.name,
        body: payload?.body ?? '',
        data: payload?.data ?? {},
        sound: 'default',
        priority: 'high',
      });
      totalSent = result.ticketsReceived ?? 0;
      totalFailed = result.errorsCount ?? 0;
    }

    // 3. Créer un PushCampaign pour l'historique
    await this.prisma.pushCampaign.create({
      data: {
        name: `[Auto] ${notification.name}`,
        title: payload?.title ?? notification.name,
        body: payload?.body ?? '',
        data: payload?.data ?? undefined,
        image_url: payload?.image_url,
        target_type: targeting?.type ?? 'all',
        target_config: targeting?.config ?? {},
        status: 'sent',
        total_targeted: tokens.length,
        total_sent: totalSent,
        total_failed: totalFailed,
        sent_at: now,
        created_by: notification.created_by,
      },
    });

    // 4. Mettre à jour la notification planifiée
    const nextRun = this.computeNextRun(notification);

    await this.prisma.scheduledNotification.update({
      where: { id: notification.id },
      data: {
        last_sent_at: now,
        send_count: { increment: 1 },
        next_run_at: nextRun,
        // Désactiver les one-shot après envoi
        ...(notification.schedule_type === 'once' ? { active: false } : {}),
      },
    });

    this.logger.log(
      `✅ "${notification.name}" envoyé → ${totalSent} push, ${totalFailed} erreurs (${tokens.length} ciblés)`,
    );
  }

  private computeNextRun(notification: any): Date | null {
    const now = new Date();

    switch (notification.schedule_type) {
      case 'once':
        return null;
      case 'daily':
        return addDays(now, 1);
      case 'weekly':
        return addWeeks(now, 1);
      case 'monthly':
        return addMonths(now, 1);
      case 'custom':
        // Pour les CRON custom, on calcule simplement +1 jour
        // Le CRON tourne chaque minute donc il détectera le bon moment
        return addDays(now, 1);
      default:
        return null;
    }
  }
}
