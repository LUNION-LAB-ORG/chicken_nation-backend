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

  /** Empêche deux ticks de cron de se chevaucher dans le même process */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPushService: ExpoPushService,
    private readonly pushCampaignService: PushCampaignService,
  ) {}

  @Cron('* * * * *')
  async processScheduledNotifications() {
    // Permet de désigner UN seul backend comme cron worker en prod.
    // Mettre DISABLE_PUSH_CRON=true sur les autres instances.
    if (process.env.DISABLE_PUSH_CRON === 'true') return;
    if (this.running) return;
    this.running = true;

    try {
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
        `${dueNotifications.length} notification(s) planifiée(s) à évaluer`,
      );

      for (const notification of dueNotifications) {
        try {
          // Claim atomique : on avance next_run_at AVANT d'envoyer.
          // updateMany conditionné sur l'ancienne valeur = compare-and-swap
          // Postgres → si une autre instance/tick a déjà claim, count=0 et on skip.
          const plannedNext = this.computeNextRun(notification);
          const claim = await this.prisma.scheduledNotification.updateMany({
            where: {
              id: notification.id,
              active: true,
              next_run_at: notification.next_run_at,
            },
            data: {
              next_run_at: plannedNext,
              ...(notification.schedule_type === 'once' ? { active: false } : {}),
            },
          });

          if (claim.count === 0) {
            this.logger.warn(
              `"${notification.name}" déjà claim par une autre exécution — skip`,
            );
            continue;
          }

          await this.processOne(notification, now);
        } catch (error) {
          this.logger.error(
            `Erreur traitement notification ${notification.id}: ${error.message}`,
          );
        }
      }
    } finally {
      this.running = false;
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

    // next_run_at + active déjà mis à jour atomiquement au moment du claim.
    // Ici on ne fait que le bookkeeping post-envoi.
    await this.prisma.scheduledNotification.update({
      where: { id: notification.id },
      data: {
        last_sent_at: now,
        send_count: { increment: 1 },
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
    if (notification.schedule_type === 'once') return null;

    // Utiliser le cron_expression pour calculer le vrai prochain run
    if (notification.cron_expression) {
      try {
        const { CronExpressionParser } = require('cron-parser');
        const interval = CronExpressionParser.parse(notification.cron_expression, {
          tz: notification.timezone ?? 'Africa/Abidjan',
        });
        return interval.next().toDate();
      } catch (e) {
        this.logger.warn(`Impossible de parser le cron "${notification.cron_expression}": ${e.message}`);
      }
    }

    // Fallback si pas de cron_expression
    const now = new Date();
    switch (notification.schedule_type) {
      case 'daily':
        return addDays(now, 1);
      case 'weekly':
        return addWeeks(now, 1);
      case 'monthly':
        return addMonths(now, 1);
      default:
        return null;
    }
  }
}
