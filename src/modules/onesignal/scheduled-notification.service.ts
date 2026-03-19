import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateScheduledNotificationDto, ScheduleType } from './dto/create-scheduled-notification.dto';
import { UpdateScheduledNotificationDto } from './dto/update-scheduled-notification.dto';
import { CronExpressionParser } from 'cron-parser';

@Injectable()
export class ScheduledNotificationService {
  private readonly logger = new Logger(ScheduledNotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(dto: CreateScheduledNotificationDto, userId: string) {
    const nextRunAt = this.computeNextRun(dto);

    const record = await this.prisma.scheduledNotification.create({
      data: {
        name: dto.name,
        channel: dto.channel ?? 'push',
        payload: dto.payload as any,
        targeting: dto.targeting as any,
        schedule_type: dto.schedule_type,
        cron_expression: dto.cron_expression ?? null,
        scheduled_at: dto.scheduled_at ? new Date(dto.scheduled_at) : null,
        timezone: dto.timezone ?? 'Africa/Abidjan',
        active: dto.active ?? true,
        next_run_at: nextRunAt,
        created_by: userId,
      },
    });

    this.logger.log(
      `Notification planifiée créée: "${record.name}" (${record.schedule_type}) — prochain envoi: ${nextRunAt?.toISOString() ?? 'N/A'}`,
    );

    return record;
  }

  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.scheduledNotification.findMany({
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.scheduledNotification.count(),
    ]);
    return { items, total, page, limit };
  }

  async findOne(id: string) {
    const record = await this.prisma.scheduledNotification.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Notification planifiée ${id} introuvable`);
    return record;
  }

  async update(id: string, dto: UpdateScheduledNotificationDto) {
    await this.findOne(id); // Verify exists

    const data: Record<string, unknown> = { ...dto, updated_at: new Date() };

    // Recalculate next_run_at if schedule changed
    if (dto.schedule_type || dto.cron_expression !== undefined || dto.scheduled_at !== undefined) {
      const current = await this.findOne(id);
      const merged = {
        schedule_type: (dto.schedule_type ?? current.schedule_type) as ScheduleType,
        cron_expression: dto.cron_expression ?? current.cron_expression,
        scheduled_at: dto.scheduled_at ?? current.scheduled_at?.toISOString(),
        timezone: dto.timezone ?? current.timezone,
      };
      data.next_run_at = this.computeNextRun(merged);
    }

    if (dto.scheduled_at) data.scheduled_at = new Date(dto.scheduled_at);
    // Remove raw string from data to avoid Prisma type errors
    if (typeof data.scheduled_at === 'string') {
      data.scheduled_at = new Date(data.scheduled_at as string);
    }

    return this.prisma.scheduledNotification.update({
      where: { id },
      data: data as any,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.scheduledNotification.delete({ where: { id } });
  }

  async toggleActive(id: string, active: boolean) {
    const record = await this.findOne(id);

    const data: Record<string, unknown> = { active, updated_at: new Date() };

    // If reactivating, recalculate next_run_at
    if (active && !record.active) {
      data.next_run_at = this.computeNextRun({
        schedule_type: record.schedule_type as ScheduleType,
        cron_expression: record.cron_expression,
        scheduled_at: record.scheduled_at?.toISOString(),
        timezone: record.timezone,
      });
    }

    return this.prisma.scheduledNotification.update({
      where: { id },
      data: data as any,
    });
  }

  // ── Scheduler helpers ─────────────────────────────────────────────────────

  /**
   * Récupère toutes les notifications actives dont next_run_at <= maintenant
   */
  async findDueNotifications() {
    return this.prisma.scheduledNotification.findMany({
      where: {
        active: true,
        next_run_at: { lte: new Date() },
      },
    });
  }

  /**
   * Après l'envoi : incrémenter send_count, mettre à jour last_sent_at,
   * calculer le prochain next_run_at (ou désactiver si c'est un envoi unique).
   */
  async markAsSent(id: string) {
    const record = await this.findOne(id);

    const data: Record<string, unknown> = {
      send_count: { increment: 1 },
      last_sent_at: new Date(),
      updated_at: new Date(),
    };

    if (record.schedule_type === 'once') {
      // One-time: désactiver après envoi
      data.active = false;
      data.next_run_at = null;
    } else {
      // Recurring: calculer le prochain envoi
      data.next_run_at = this.computeNextRun({
        schedule_type: record.schedule_type as ScheduleType,
        cron_expression: record.cron_expression,
        scheduled_at: null,
        timezone: record.timezone,
      });
    }

    return this.prisma.scheduledNotification.update({
      where: { id },
      data: data as any,
    });
  }

  // ── CRON helpers ──────────────────────────────────────────────────────────

  /**
   * Calcule la prochaine date d'exécution en fonction du schedule_type.
   *
   * Presets CRON :
   *  - daily:   "0 9 * * *"      → tous les jours à 9h
   *  - weekly:  "0 9 * * 1"      → tous les lundis à 9h
   *  - monthly: "0 9 1 * *"      → le 1er du mois à 9h
   *  - custom:  utilise cron_expression fourni par l'utilisateur
   *  - once:    retourne scheduled_at
   */
  computeNextRun(params: {
    schedule_type: ScheduleType;
    cron_expression?: string | null;
    scheduled_at?: string | null;
    timezone?: string | null;
  }): Date | null {
    const { schedule_type, cron_expression, scheduled_at, timezone } = params;
    const tz = timezone ?? 'Africa/Abidjan';

    if (schedule_type === 'once') {
      return scheduled_at ? new Date(scheduled_at) : null;
    }

    let cronExpr: string;

    switch (schedule_type) {
      case 'daily':
        cronExpr = cron_expression ?? '0 9 * * *';
        break;
      case 'weekly':
        cronExpr = cron_expression ?? '0 9 * * 1';
        break;
      case 'monthly':
        cronExpr = cron_expression ?? '0 9 1 * *';
        break;
      case 'custom':
        if (!cron_expression) {
          this.logger.warn('schedule_type=custom mais pas de cron_expression fourni');
          return null;
        }
        cronExpr = cron_expression;
        break;
      default:
        return null;
    }

    try {
      const interval = CronExpressionParser.parse(cronExpr, { tz });
      return interval.next().toDate();
    } catch (error) {
      this.logger.error(`Expression CRON invalide "${cronExpr}": ${error.message}`);
      return null;
    }
  }
}
