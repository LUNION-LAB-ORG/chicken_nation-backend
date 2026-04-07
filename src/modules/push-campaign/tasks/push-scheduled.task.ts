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
 * Supporte les variables dynamiques {{first_name}}, {{last_name}}, etc.
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
      `${dueNotifications.length} notification(s) planifiée(s) à envoyer`,
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

  private async processOne(notification: any, now: Date) {
    const payload = notification.payload as any;
    const targeting = notification.targeting as any;

    // Normaliser le targeting : "segments" (OneSignal) → "all"
    const targetType = targeting?.type === 'segments' ? 'all'
      : (targeting?.type === 'segment' && (!targeting?.config?.segment || targeting?.config?.segment === 'all')) ? 'all'
      : targeting?.type ?? 'all';
    const targetConfig = targeting?.config ?? {};

    const title = payload?.title ?? notification.name;
    const body = payload?.body ?? '';
    const hasVars = /\{\{[a-z_]+\}\}/.test(title) || /\{\{[a-z_]+\}\}/.test(body);

    let totalSent = 0;
    let totalFailed = 0;
    let totalTargeted = 0;

    if (hasVars) {
      // Personalized send — resolve variables per customer
      const customerSettings = await this.resolveTargetCustomerSettings(
        targetType,
        targetConfig,
      );

      if (customerSettings.length > 0) {
        const customerIds = customerSettings.map((s) => s.customer_id);
        const customers = await this.prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            loyalty_level: true,
            total_points: true,
            addresses: { select: { city: true }, take: 1, orderBy: { created_at: 'desc' } },
          },
        });
        const customerMap = new Map(customers.map((c) => [c.id, c]));

        const messages = customerSettings.map((setting) => {
          const customer = customerMap.get(setting.customer_id);
          const vars: Record<string, string> = {
            first_name: customer?.first_name ?? '',
            last_name: customer?.last_name ?? '',
            phone: customer?.phone ?? '',
            city: customer?.addresses?.[0]?.city ?? '',
            loyalty_level: customer?.loyalty_level ?? '',
            total_points: String(customer?.total_points ?? 0),
          };
          return {
            token: setting.expo_push_token!,
            title: this.resolveText(title, vars),
            body: this.resolveText(body, vars),
            data: payload?.data ?? {},
          };
        });

        totalTargeted = messages.length;
        const result = await this.expoPushService.sendPersonalizedPushNotifications(messages);
        totalSent = result.ticketsReceived ?? 0;
        totalFailed = result.errorsCount ?? 0;
      }
    } else {
      // Standard batch send
      const tokens = await this.pushCampaignService.resolveTargetTokens(
        targetType,
        targetConfig,
      );
      totalTargeted = tokens.length;

      if (tokens.length > 0) {
        const result = await this.expoPushService.sendPushNotifications({
          tokens,
          title,
          body,
          data: payload?.data ?? {},
          sound: 'default',
          priority: 'high',
        });
        totalSent = result.ticketsReceived ?? 0;
        totalFailed = result.errorsCount ?? 0;
      }
    }

    // Créer un PushCampaign pour l'historique
    await this.prisma.pushCampaign.create({
      data: {
        name: `[Auto] ${notification.name}`,
        title,
        body,
        data: payload?.data ?? undefined,
        image_url: payload?.image_url,
        target_type: targeting?.type ?? 'all',
        target_config: targeting?.config ?? {},
        status: 'sent',
        total_targeted: totalTargeted,
        total_sent: totalSent,
        total_failed: totalFailed,
        sent_at: now,
        created_by: notification.created_by,
      },
    });

    // Mettre à jour la notification planifiée
    const nextRun = this.computeNextRun(notification);

    await this.prisma.scheduledNotification.update({
      where: { id: notification.id },
      data: {
        last_sent_at: now,
        send_count: { increment: 1 },
        next_run_at: nextRun,
        ...(notification.schedule_type === 'once' ? { active: false } : {}),
      },
    });

    this.logger.log(
      `"${notification.name}" envoyé → ${totalSent} push, ${totalFailed} erreurs (${totalTargeted} ciblés)`,
    );
  }

  private resolveText(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => vars[key] ?? '');
  }

  private async resolveTargetCustomerSettings(
    targetType: string,
    targetConfig: Record<string, any>,
  ) {
    const where: any = {
      push: true,
      active: true,
      expo_push_token: { not: null },
    };

    if (targetType === 'ids' && targetConfig.ids) {
      where.customer_id = { in: targetConfig.ids };
    } else if (targetType === 'segment' && targetConfig.segment) {
      const ids = await (this.pushCampaignService as any).resolveSegmentCustomerIds(targetConfig.segment);
      if (ids.length === 0) return [];
      where.customer_id = { in: ids };
    } else if (targetType === 'filters') {
      const ids = await (this.pushCampaignService as any).resolveFilterCustomerIds(targetConfig);
      if (ids.length === 0) return [];
      where.customer_id = { in: ids };
    }

    return this.prisma.notificationSetting.findMany({
      where,
      select: { customer_id: true, expo_push_token: true },
    });
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
        return addDays(now, 1);
      default:
        return null;
    }
  }
}
