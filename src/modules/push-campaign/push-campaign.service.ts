import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { CreateCampaignDto, SegmentPreviewDto } from './dto/create-campaign.dto';
import { CampaignQueryDto, TemplateQueryDto } from './dto/campaign-query.dto';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/create-template.dto';
import {
  CreateScheduledDto,
  UpdateScheduledDto,
} from './dto/create-scheduled.dto';
import {
  CreateSegmentDto,
  UpdateSegmentDto,
  SegmentFiltersDto,
} from './dto/create-segment.dto';
import { subDays } from 'date-fns';

@Injectable()
export class PushCampaignService {
  private readonly logger = new Logger(PushCampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPushService: ExpoPushService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMPAIGNS — CRUD + ENVOI
  // ═══════════════════════════════════════════════════════════════════════════

  async create(dto: CreateCampaignDto, userId: string) {
    const isScheduled = !!dto.scheduled_at;

    const campaign = await this.prisma.pushCampaign.create({
      data: {
        name: dto.name,
        title: dto.title,
        body: dto.body,
        data: dto.data ?? undefined,
        image_url: dto.image_url,
        target_type: dto.target_type,
        target_config: dto.target_config,
        status: isScheduled ? 'scheduled' : 'draft',
        scheduled_at: dto.scheduled_at ? new Date(dto.scheduled_at) : null,
        created_by: userId,
      },
    });

    // Envoi immédiat si pas planifié
    if (!isScheduled) {
      return this.sendCampaign(campaign.id);
    }

    return campaign;
  }

  async findAll(query: CampaignQueryDto) {
    const page = parseInt(query.page ?? '1', 10);
    const limit = parseInt(query.limit ?? '20', 10);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [items, total] = await Promise.all([
      this.prisma.pushCampaign.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.pushCampaign.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string) {
    const campaign = await this.prisma.pushCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campagne introuvable');
    return campaign;
  }

  async cancel(id: string) {
    const campaign = await this.findOne(id);
    if (campaign.status !== 'scheduled') {
      throw new NotFoundException('Seule une campagne planifiée peut être annulée');
    }
    return this.prisma.pushCampaign.update({
      where: { id },
      data: { status: 'draft' },
    });
  }

  async sendCampaign(id: string) {
    const campaign = await this.findOne(id);

    try {
      const tokens = await this.resolveTargetTokens(
        campaign.target_type,
        campaign.target_config as Record<string, any>,
      );

      if (tokens.length === 0) {
        return this.prisma.pushCampaign.update({
          where: { id },
          data: {
            status: 'sent',
            total_targeted: 0,
            total_sent: 0,
            sent_at: new Date(),
          },
        });
      }

      const result = await this.expoPushService.sendPushNotifications({
        tokens,
        title: campaign.title,
        body: campaign.body,
        data: (campaign.data as Record<string, any>) ?? {},
        sound: 'default',
        priority: 'high',
      });

      return this.prisma.pushCampaign.update({
        where: { id },
        data: {
          status: 'sent',
          total_targeted: tokens.length,
          total_sent: result.ticketsReceived ?? 0,
          total_failed: result.errorsCount ?? 0,
          sent_at: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(`Erreur envoi campagne ${id}: ${error.message}`);
      return this.prisma.pushCampaign.update({
        where: { id },
        data: { status: 'failed' },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════════════════════════

  async getStats() {
    const [totalCampaigns, totalSent, totalFailed, recentCampaigns] =
      await Promise.all([
        this.prisma.pushCampaign.count(),
        this.prisma.pushCampaign.aggregate({ _sum: { total_sent: true } }),
        this.prisma.pushCampaign.aggregate({ _sum: { total_failed: true } }),
        this.prisma.pushCampaign.findMany({
          orderBy: { created_at: 'desc' },
          take: 5,
          select: {
            id: true,
            name: true,
            status: true,
            total_targeted: true,
            total_sent: true,
            total_failed: true,
            sent_at: true,
            created_at: true,
          },
        }),
      ]);

    return {
      totalCampaigns,
      totalSent: totalSent._sum.total_sent ?? 0,
      totalFailed: totalFailed._sum.total_failed ?? 0,
      recentCampaigns,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEGMENTATION — requêtes DB directes (PAS de sync de tags)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Liste des segments disponibles avec compteurs live */
  async getSegments() {
    const now = new Date();

    const [
      allSubscribers,
      activeBuyers,
      inactive30d,
      newCustomers,
      loyalCustomers,
      bigSpenders,
      goldMembers,
      premiumMembers,
    ] = await Promise.all([
      this.countTokens({}),
      this.countActiveBuyers(7),
      this.countInactive(30),
      this.countNewCustomers(7),
      this.countByOrdersMin(5),
      this.countBigSpenders(50000),
      this.countByLoyalty('GOLD'),
      this.countByLoyalty('PREMIUM'),
    ]);

    // Villes dynamiques
    const cities = await this.getDistinctCities();

    const segments: any[] = [
      { key: 'all', label: 'Tous les abonnés', count: allSubscribers, description: 'Push actif', is_system: true },
      { key: 'active_buyers', label: 'Acheteurs actifs', count: activeBuyers, description: 'Commande < 7j', is_system: true },
      { key: 'inactive_30d', label: 'Inactifs 30j+', count: inactive30d, description: 'Réengagement', is_system: true },
      { key: 'new_customers', label: 'Nouveaux (7j)', count: newCustomers, description: 'Onboarding', is_system: true },
      { key: 'loyal_customers', label: 'Fidèles (5+ cmd)', count: loyalCustomers, description: 'Rétention', is_system: true },
      { key: 'big_spenders', label: 'Gros acheteurs', count: bigSpenders, description: '> 50 000 FCFA', is_system: true },
      { key: 'gold', label: 'Gold', count: goldMembers, description: 'Offres VIP', is_system: true },
      { key: 'premium', label: 'Premium', count: premiumMembers, description: 'Offres premium', is_system: true },
      ...cities.map((c) => ({
        key: `city_${c.city}`,
        label: c.city,
        count: c.count,
        description: 'Géo-ciblé',
        is_system: true,
      })),
    ];

    // ── Segments custom (depuis DB) ──
    const customSegments = await this.prisma.pushSegment.findMany({
      orderBy: { created_at: 'desc' },
    });

    for (const seg of customSegments) {
      const count = await this.countByCustomFilters(seg.filters as SegmentFiltersDto);
      segments.push({
        key: `custom_${seg.id}`,
        label: seg.name,
        count,
        description: seg.description ?? 'Segment personnalisé',
        is_system: false,
        id: seg.id,
      });
    }

    return segments;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEGMENTS CUSTOM — CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  async createSegment(dto: CreateSegmentDto, userId: string) {
    const segment = await this.prisma.pushSegment.create({
      data: {
        name: dto.name,
        description: dto.description,
        filters: dto.filters as any,
        created_by: userId,
      },
    });

    // Retourner avec le count live
    const count = await this.countByCustomFilters(dto.filters as SegmentFiltersDto);
    return { ...segment, count };
  }

  async findAllSegmentsCustom() {
    const segments = await this.prisma.pushSegment.findMany({
      where: { is_system: false },
      orderBy: { created_at: 'desc' },
    });

    const result: any[] = [];
    for (const seg of segments) {
      const count = await this.countByCustomFilters(seg.filters as SegmentFiltersDto);
      result.push({ ...seg, count });
    }
    return result;
  }

  async findOneSegment(id: string) {
    const segment = await this.prisma.pushSegment.findUnique({ where: { id } });
    if (!segment) throw new NotFoundException('Segment introuvable');
    const count = await this.countByCustomFilters(segment.filters as SegmentFiltersDto);
    return { ...segment, count };
  }

  async updateSegment(id: string, dto: UpdateSegmentDto) {
    await this.findOneSegment(id);
    const updated = await this.prisma.pushSegment.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.filters ? { filters: dto.filters as any } : {}),
      },
    });
    const count = await this.countByCustomFilters(updated.filters as SegmentFiltersDto);
    return { ...updated, count };
  }

  async deleteSegment(id: string) {
    const segment = await this.prisma.pushSegment.findUnique({ where: { id } });
    if (!segment) throw new NotFoundException('Segment introuvable');
    if (segment.is_system) throw new NotFoundException('Impossible de supprimer un segment système');
    return this.prisma.pushSegment.delete({ where: { id } });
  }

  /** Preview du nombre de destinataires pour un ciblage donné */
  async previewSegment(dto: SegmentPreviewDto) {
    const tokens = await this.resolveTargetTokens(dto.target_type, dto.target_config);
    return { count: tokens.length };
  }

  /** Résout les tokens Expo Push en fonction du ciblage */
  async resolveTargetTokens(
    targetType: string,
    targetConfig: Record<string, any>,
  ): Promise<string[]> {
    switch (targetType) {
      case 'all':
        return this.getAllTokens();

      case 'segment':
        return this.getTokensBySegment(targetConfig.segment);

      case 'filters':
        return this.getTokensByFilters(targetConfig);

      case 'ids':
        return this.getTokensByIds(targetConfig.ids ?? []);

      default:
        return [];
    }
  }

  // ── Tokens helpers ──────────────────────────────────────────────────────

  private async getAllTokens(): Promise<string[]> {
    const settings = await this.prisma.notificationSetting.findMany({
      where: {
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
      select: { expo_push_token: true },
    });
    return settings.map((s) => s.expo_push_token!).filter(Boolean);
  }

  private async getTokensBySegment(segment: string): Promise<string[]> {
    const customerIds = await this.resolveSegmentCustomerIds(segment);
    if (customerIds.length === 0) return [];
    return this.getTokensByIds(customerIds);
  }

  private async getTokensByFilters(
    filters: Record<string, any>,
  ): Promise<string[]> {
    const customerIds = await this.resolveFilterCustomerIds(filters);
    if (customerIds.length === 0) return [];
    return this.getTokensByIds(customerIds);
  }

  private async getTokensByIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const settings = await this.prisma.notificationSetting.findMany({
      where: {
        customer_id: { in: ids },
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
      select: { expo_push_token: true },
    });
    return settings.map((s) => s.expo_push_token!).filter(Boolean);
  }

  // ── Segment resolution ──────────────────────────────────────────────────

  private async resolveSegmentCustomerIds(segment: string): Promise<string[]> {
    const now = new Date();

    switch (segment) {
      case 'active_buyers': {
        const since = subDays(now, 7);
        const orders = await this.prisma.order.findMany({
          where: {
            status: 'COMPLETED',
            entity_status: 'ACTIVE',
            completed_at: { gte: since },
          },
          select: { customer_id: true },
          distinct: ['customer_id'],
        });
        return orders.map((o) => o.customer_id);
      }

      case 'inactive_30d': {
        // Clients avec push token mais pas de commande depuis 30j
        const since = subDays(now, 30);
        const activeCustomers = await this.prisma.order.findMany({
          where: {
            status: 'COMPLETED',
            entity_status: 'ACTIVE',
            completed_at: { gte: since },
          },
          select: { customer_id: true },
          distinct: ['customer_id'],
        });
        const activeIds = new Set(activeCustomers.map((o) => o.customer_id));

        const allWithToken = await this.prisma.notificationSetting.findMany({
          where: { push: true, active: true, expo_push_token: { not: null } },
          select: { customer_id: true },
        });
        return allWithToken
          .map((s) => s.customer_id)
          .filter((id) => !activeIds.has(id));
      }

      case 'new_customers': {
        const since = subDays(now, 7);
        const customers = await this.prisma.customer.findMany({
          where: { entity_status: 'ACTIVE', created_at: { gte: since } },
          select: { id: true },
        });
        return customers.map((c) => c.id);
      }

      case 'loyal_customers':
        return this.getCustomerIdsByOrdersMin(5);

      case 'big_spenders':
        return this.getCustomerIdsByTotalSpent(50000);

      case 'gold':
        return this.getCustomerIdsByLoyalty('GOLD');

      case 'premium':
        return this.getCustomerIdsByLoyalty('PREMIUM');

      default: {
        // city_<cityName>
        if (segment.startsWith('city_')) {
          const city = segment.replace('city_', '');
          return this.getCustomerIdsByCity(city);
        }
        // custom_<uuid> — segment custom sauvegardé en DB
        if (segment.startsWith('custom_')) {
          const segId = segment.replace('custom_', '');
          const customSeg = await this.prisma.pushSegment.findUnique({ where: { id: segId } });
          if (!customSeg) return [];
          return this.resolveCustomFiltersCustomerIds(customSeg.filters as SegmentFiltersDto);
        }
        return [];
      }
    }
  }

  private async resolveFilterCustomerIds(
    filters: Record<string, any>,
  ): Promise<string[]> {
    // filters: { field, operator, value }[]
    const filterList: { field: string; operator: string; value: any }[] =
      filters.filters ?? [];

    if (filterList.length === 0) return [];

    // Start with all active customers with push tokens
    let customerIds: Set<string> | null = null;

    for (const f of filterList) {
      let ids: string[] = [];

      switch (f.field) {
        case 'orders':
          ids = await this.getCustomerIdsByOrdersMin(Number(f.value));
          break;
        case 'total_spent':
          ids = await this.getCustomerIdsByTotalSpent(Number(f.value));
          break;
        case 'loyalty_level':
          ids = await this.getCustomerIdsByLoyalty(f.value);
          break;
        case 'city':
          ids = await this.getCustomerIdsByCity(f.value);
          break;
        default:
          continue;
      }

      const idSet = new Set(ids);
      if (customerIds === null) {
        customerIds = idSet;
      } else {
        // Intersection (AND logic)
        customerIds = new Set([...customerIds].filter((id) => idSet.has(id)));
      }
    }

    return customerIds ? Array.from(customerIds) : [];
  }

  // ── DB query helpers ────────────────────────────────────────────────────

  private async countTokens(extraWhere: any): Promise<number> {
    return this.prisma.notificationSetting.count({
      where: {
        push: true,
        active: true,
        expo_push_token: { not: null },
        ...extraWhere,
      },
    });
  }

  private async countActiveBuyers(days: number): Promise<number> {
    const since = subDays(new Date(), days);
    const orders = await this.prisma.order.findMany({
      where: {
        status: 'COMPLETED',
        entity_status: 'ACTIVE',
        completed_at: { gte: since },
      },
      select: { customer_id: true },
      distinct: ['customer_id'],
    });
    // Filter only those with push token
    const ids = orders.map((o) => o.customer_id);
    if (ids.length === 0) return 0;
    return this.prisma.notificationSetting.count({
      where: {
        customer_id: { in: ids },
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
    });
  }

  private async countInactive(days: number): Promise<number> {
    const since = subDays(new Date(), days);
    const activeCustomers = await this.prisma.order.findMany({
      where: {
        status: 'COMPLETED',
        entity_status: 'ACTIVE',
        completed_at: { gte: since },
      },
      select: { customer_id: true },
      distinct: ['customer_id'],
    });
    const activeIds = activeCustomers.map((o) => o.customer_id);

    return this.prisma.notificationSetting.count({
      where: {
        push: true,
        active: true,
        expo_push_token: { not: null },
        ...(activeIds.length > 0
          ? { customer_id: { notIn: activeIds } }
          : {}),
      },
    });
  }

  private async countNewCustomers(days: number): Promise<number> {
    const since = subDays(new Date(), days);
    const customers = await this.prisma.customer.findMany({
      where: { entity_status: 'ACTIVE', created_at: { gte: since } },
      select: { id: true },
    });
    const ids = customers.map((c) => c.id);
    if (ids.length === 0) return 0;
    return this.prisma.notificationSetting.count({
      where: {
        customer_id: { in: ids },
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
    });
  }

  private async countByOrdersMin(min: number): Promise<number> {
    const ids = await this.getCustomerIdsByOrdersMin(min);
    if (ids.length === 0) return 0;
    return this.prisma.notificationSetting.count({
      where: {
        customer_id: { in: ids },
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
    });
  }

  private async countBigSpenders(minAmount: number): Promise<number> {
    const ids = await this.getCustomerIdsByTotalSpent(minAmount);
    if (ids.length === 0) return 0;
    return this.prisma.notificationSetting.count({
      where: {
        customer_id: { in: ids },
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
    });
  }

  private async countByLoyalty(level: string): Promise<number> {
    const customers = await this.prisma.customer.findMany({
      where: { entity_status: 'ACTIVE', loyalty_level: level as any },
      select: { id: true },
    });
    const ids = customers.map((c) => c.id);
    if (ids.length === 0) return 0;
    return this.prisma.notificationSetting.count({
      where: {
        customer_id: { in: ids },
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
    });
  }

  private async getCustomerIdsByOrdersMin(min: number): Promise<string[]> {
    const result = await this.prisma.order.groupBy({
      by: ['customer_id'],
      where: { status: 'COMPLETED', entity_status: 'ACTIVE' },
      _count: { id: true },
      having: { id: { _count: { gte: min } } },
    });
    return result.map((r) => r.customer_id);
  }

  private async getCustomerIdsByTotalSpent(min: number): Promise<string[]> {
    const result = await this.prisma.order.groupBy({
      by: ['customer_id'],
      where: { status: 'COMPLETED', entity_status: 'ACTIVE' },
      _sum: { amount: true },
      having: { amount: { _sum: { gte: min } } },
    });
    return result.map((r) => r.customer_id);
  }

  private async getCustomerIdsByLoyalty(level: string): Promise<string[]> {
    const customers = await this.prisma.customer.findMany({
      where: { entity_status: 'ACTIVE', loyalty_level: level as any },
      select: { id: true },
    });
    return customers.map((c) => c.id);
  }

  private async getCustomerIdsByCity(city: string): Promise<string[]> {
    const addresses = await this.prisma.address.findMany({
      where: {
        city: { equals: city, mode: 'insensitive' },
        customer_id: { not: null },
      },
      select: { customer_id: true },
      distinct: ['customer_id'],
    });
    return addresses.map((a) => a.customer_id!).filter(Boolean);
  }

  private async getDistinctCities(): Promise<{ city: string; count: number }[]> {
    const addresses = await this.prisma.address.findMany({
      where: { city: { not: null }, customer_id: { not: null } },
      select: { city: true, customer_id: true },
    });

    // Group by city and count unique customers with push tokens
    const cityMap = new Map<string, Set<string>>();
    for (const a of addresses) {
      if (!a.city) continue;
      const city = a.city.trim();
      if (!cityMap.has(city)) cityMap.set(city, new Set());
      cityMap.get(city)!.add(a.customer_id!);
    }

    const result: { city: string; count: number }[] = [];
    for (const [city, customerIds] of cityMap) {
      if (customerIds.size < 1) continue;
      result.push({ city, count: customerIds.size });
    }
    return result.sort((a, b) => b.count - a.count);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEMPLATES — CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  async createTemplate(dto: CreateTemplateDto, userId: string) {
    return this.prisma.pushTemplate.create({
      data: {
        name: dto.name,
        title: dto.title,
        body: dto.body,
        data: dto.data ?? undefined,
        image_url: dto.image_url,
        created_by: userId,
      },
    });
  }

  async findAllTemplates(query: TemplateQueryDto) {
    const page = parseInt(query.page ?? '1', 10);
    const limit = parseInt(query.limit ?? '20', 10);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [items, total] = await Promise.all([
      this.prisma.pushTemplate.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.pushTemplate.count({ where }),
    ]);

    return { items, total, page, totalPages: Math.ceil(total / limit) };
  }

  async findOneTemplate(id: string) {
    const template = await this.prisma.pushTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Template introuvable');
    return template;
  }

  async updateTemplate(id: string, dto: UpdateTemplateDto) {
    await this.findOneTemplate(id);
    return this.prisma.pushTemplate.update({
      where: { id },
      data: { ...dto },
    });
  }

  async deleteTemplate(id: string) {
    await this.findOneTemplate(id);
    return this.prisma.pushTemplate.delete({ where: { id } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULED — CRUD (réutilise le modèle ScheduledNotification existant)
  // ═══════════════════════════════════════════════════════════════════════════

  async createScheduled(dto: CreateScheduledDto, userId: string) {
    const payload = {
      title: dto.title,
      body: dto.body,
      data: dto.data,
      image_url: dto.image_url,
    };

    const targeting = {
      type: dto.target_type,
      config: dto.target_config,
    };

    const nextRunAt = this.computeNextRun(dto);

    return this.prisma.scheduledNotification.create({
      data: {
        name: dto.name,
        channel: 'expo_push',
        payload,
        targeting,
        schedule_type: dto.schedule_type,
        cron_expression: dto.cron_expression,
        scheduled_at: dto.scheduled_at ? new Date(dto.scheduled_at) : null,
        timezone: dto.timezone ?? 'Africa/Abidjan',
        next_run_at: nextRunAt,
        created_by: userId,
      },
    });
  }

  async findAllScheduled() {
    return this.prisma.scheduledNotification.findMany({
      where: { channel: 'expo_push' },
      orderBy: { created_at: 'desc' },
    });
  }

  async findOneScheduled(id: string) {
    const scheduled = await this.prisma.scheduledNotification.findUnique({
      where: { id },
    });
    if (!scheduled) throw new NotFoundException('Notification planifiée introuvable');
    return scheduled;
  }

  async updateScheduled(id: string, dto: UpdateScheduledDto) {
    await this.findOneScheduled(id);

    const data: any = {};
    if (dto.name) data.name = dto.name;
    if (dto.target_type || dto.target_config) {
      const existing = await this.findOneScheduled(id);
      data.targeting = {
        type: dto.target_type ?? (existing.targeting as any)?.type,
        config: dto.target_config ?? (existing.targeting as any)?.config,
      };
    }
    if (dto.title || dto.body || dto.data || dto.image_url) {
      const existing = await this.findOneScheduled(id);
      const prevPayload = existing.payload as any;
      data.payload = {
        title: dto.title ?? prevPayload?.title,
        body: dto.body ?? prevPayload?.body,
        data: dto.data ?? prevPayload?.data,
        image_url: dto.image_url ?? prevPayload?.image_url,
      };
    }
    if (dto.schedule_type) data.schedule_type = dto.schedule_type;
    if (dto.cron_expression) data.cron_expression = dto.cron_expression;
    if (dto.scheduled_at) data.scheduled_at = new Date(dto.scheduled_at);
    if (dto.timezone) data.timezone = dto.timezone;

    return this.prisma.scheduledNotification.update({ where: { id }, data });
  }

  async deleteScheduled(id: string) {
    await this.findOneScheduled(id);
    return this.prisma.scheduledNotification.delete({ where: { id } });
  }

  async toggleScheduled(id: string) {
    const scheduled = await this.findOneScheduled(id);
    return this.prisma.scheduledNotification.update({
      where: { id },
      data: { active: !scheduled.active },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // USERS — Liste des abonnés push
  // ═══════════════════════════════════════════════════════════════════════════

  async getUsers(query: { page?: string; limit?: string; search?: string }) {
    const page = parseInt(query.page ?? '1', 10);
    const limit = parseInt(query.limit ?? '20', 10);
    const skip = (page - 1) * limit;

    const where: any = {
      push: true,
      active: true,
      expo_push_token: { not: null },
    };

    if (query.search) {
      where.customer = {
        OR: [
          { first_name: { contains: query.search, mode: 'insensitive' } },
          { last_name: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search } },
        ],
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.notificationSetting.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              phone: true,
              loyalty_level: true,
              created_at: true,
            },
          },
        },
        orderBy: { customer: { created_at: 'desc' } },
        skip,
        take: limit,
      }),
      this.prisma.notificationSetting.count({ where }),
    ]);

    return { items, total, page, totalPages: Math.ceil(total / limit) };
  }

  async getUserDetail(customerId: string) {
    const setting = await this.prisma.notificationSetting.findUnique({
      where: { customer_id: customerId },
      include: {
        customer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            loyalty_level: true,
            total_points: true,
            created_at: true,
            orders: {
              where: { status: 'COMPLETED', entity_status: 'ACTIVE' },
              select: { id: true, amount: true, completed_at: true },
              orderBy: { completed_at: 'desc' },
              take: 10,
            },
            addresses: {
              select: { city: true },
              take: 1,
              orderBy: { created_at: 'desc' },
            },
          },
        },
      },
    });
    if (!setting) throw new NotFoundException('Utilisateur introuvable');
    return setting;
  }

  // ── Custom segment filters resolution ──────────────────────────────────

  private async countByCustomFilters(filters: SegmentFiltersDto): Promise<number> {
    const ids = await this.resolveCustomFiltersCustomerIds(filters);
    if (ids.length === 0) return 0;
    return this.prisma.notificationSetting.count({
      where: {
        customer_id: { in: ids },
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
    });
  }

  private async resolveCustomFiltersCustomerIds(
    filters: SegmentFiltersDto,
  ): Promise<string[]> {
    let customerIds: Set<string> | null = null;

    const intersect = (ids: string[]) => {
      const idSet = new Set(ids);
      if (customerIds === null) {
        customerIds = idSet;
      } else {
        customerIds = new Set([...customerIds].filter((id) => idSet.has(id)));
      }
    };

    // name_contains (first_name OR last_name)
    if (filters.name_contains) {
      const customers = await this.prisma.customer.findMany({
        where: {
          entity_status: 'ACTIVE',
          OR: [
            { first_name: { contains: filters.name_contains, mode: 'insensitive' } },
            { last_name: { contains: filters.name_contains, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      intersect(customers.map((c) => c.id));
    }

    // phone_contains
    if (filters.phone_contains) {
      const customers = await this.prisma.customer.findMany({
        where: {
          entity_status: 'ACTIVE',
          phone: { contains: filters.phone_contains },
        },
        select: { id: true },
      });
      intersect(customers.map((c) => c.id));
    }

    // email_contains
    if (filters.email_contains) {
      const customers = await this.prisma.customer.findMany({
        where: {
          entity_status: 'ACTIVE',
          email: { contains: filters.email_contains, mode: 'insensitive' },
        },
        select: { id: true },
      });
      intersect(customers.map((c) => c.id));
    }

    // min_orders
    if (filters.min_orders !== undefined) {
      intersect(await this.getCustomerIdsByOrdersMin(filters.min_orders));
    }

    // max_orders
    if (filters.max_orders !== undefined) {
      const result = await this.prisma.order.groupBy({
        by: ['customer_id'],
        where: { status: 'COMPLETED', entity_status: 'ACTIVE' },
        _count: { id: true },
        having: { id: { _count: { lte: filters.max_orders } } },
      });
      intersect(result.map((r) => r.customer_id));
    }

    // min_spent
    if (filters.min_spent !== undefined) {
      intersect(await this.getCustomerIdsByTotalSpent(filters.min_spent));
    }

    // max_spent
    if (filters.max_spent !== undefined) {
      const result = await this.prisma.order.groupBy({
        by: ['customer_id'],
        where: { status: 'COMPLETED', entity_status: 'ACTIVE' },
        _sum: { amount: true },
        having: { amount: { _sum: { lte: filters.max_spent } } },
      });
      intersect(result.map((r) => r.customer_id));
    }

    // loyalty_level
    if (filters.loyalty_level) {
      intersect(await this.getCustomerIdsByLoyalty(filters.loyalty_level));
    }

    // city
    if (filters.city) {
      intersect(await this.getCustomerIdsByCity(filters.city));
    }

    // min_points
    if (filters.min_points !== undefined) {
      const customers = await this.prisma.customer.findMany({
        where: { entity_status: 'ACTIVE', total_points: { gte: filters.min_points } },
        select: { id: true },
      });
      intersect(customers.map((c) => c.id));
    }

    // max_points
    if (filters.max_points !== undefined) {
      const customers = await this.prisma.customer.findMany({
        where: { entity_status: 'ACTIVE', total_points: { lte: filters.max_points } },
        select: { id: true },
      });
      intersect(customers.map((c) => c.id));
    }

    // registered_after
    if (filters.registered_after) {
      const customers = await this.prisma.customer.findMany({
        where: { entity_status: 'ACTIVE', created_at: { gte: new Date(filters.registered_after) } },
        select: { id: true },
      });
      intersect(customers.map((c) => c.id));
    }

    // registered_before
    if (filters.registered_before) {
      const customers = await this.prisma.customer.findMany({
        where: { entity_status: 'ACTIVE', created_at: { lte: new Date(filters.registered_before) } },
        select: { id: true },
      });
      intersect(customers.map((c) => c.id));
    }

    // last_order_days — a commandé dans les X derniers jours
    if (filters.last_order_days !== undefined) {
      const since = subDays(new Date(), filters.last_order_days);
      const orders = await this.prisma.order.findMany({
        where: {
          status: 'COMPLETED',
          entity_status: 'ACTIVE',
          completed_at: { gte: since },
        },
        select: { customer_id: true },
        distinct: ['customer_id'],
      });
      intersect(orders.map((o) => o.customer_id));
    }

    // no_order_days — PAS de commande depuis X jours
    if (filters.no_order_days !== undefined) {
      const since = subDays(new Date(), filters.no_order_days);
      const activeCustomers = await this.prisma.order.findMany({
        where: {
          status: 'COMPLETED',
          entity_status: 'ACTIVE',
          completed_at: { gte: since },
        },
        select: { customer_id: true },
        distinct: ['customer_id'],
      });
      const activeIds = new Set(activeCustomers.map((o) => o.customer_id));
      const allWithToken = await this.prisma.notificationSetting.findMany({
        where: { push: true, active: true, expo_push_token: { not: null } },
        select: { customer_id: true },
      });
      const inactiveIds = allWithToken
        .map((s) => s.customer_id)
        .filter((id) => !activeIds.has(id));
      intersect(inactiveIds);
    }

    // Si aucun filtre n'a été appliqué, retourner tous
    if (customerIds === null) {
      const all = await this.prisma.notificationSetting.findMany({
        where: { push: true, active: true, expo_push_token: { not: null } },
        select: { customer_id: true },
      });
      return all.map((s) => s.customer_id);
    }

    return Array.from(customerIds);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private computeNextRun(dto: CreateScheduledDto): Date | null {
    if (dto.schedule_type === 'once' && dto.scheduled_at) {
      return new Date(dto.scheduled_at);
    }
    // For recurring, the CRON task will compute the next run
    if (dto.scheduled_at) return new Date(dto.scheduled_at);
    return new Date();
  }
}
