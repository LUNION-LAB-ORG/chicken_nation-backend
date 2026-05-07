import { Injectable, Logger, BadRequestException, HttpException } from '@nestjs/common';
import { SettingsService } from 'src/modules/settings/settings.service';
import { randomUUID } from 'crypto';
import { CreateOneSignalMessageDto } from './dto/create-message.dto';
import { ViewMessagesQueryDto, ViewTemplatesQueryDto, ViewSegmentsQueryDto } from './dto/view-messages-query.dto';
import { CreateOneSignalTemplateDto } from './dto/create-template.dto';
import { UpdateOneSignalTemplateDto } from './dto/update-template.dto';
import { CreateOneSignalSegmentDto } from './dto/create-segment.dto';
import { UpdateOneSignalSegmentDto } from './dto/update-segment.dto';
import { UpdateOneSignalUserDto } from './dto/update-user.dto';
import { CreateAliasDto } from './dto/create-alias.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { PrismaService } from 'src/database/services/prisma.service';

const ONESIGNAL_API_BASE = 'https://api.onesignal.com';

interface OnesignalConfig {
  appId: string;
  apiKey: string;
}

@Injectable()
export class OnesignalService {
  private readonly logger = new Logger(OnesignalService.name);

  constructor(
    private readonly settingsService: SettingsService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Configuration ──

  private async getConfig(): Promise<OnesignalConfig> {
    const config = await this.settingsService.getManyOrEnv({
      onesignal_app_id: 'ONESIGNAL_APP_ID',
      onesignal_api_key: 'ONESIGNAL_API_KEY',
    });

    const appId = config.onesignal_app_id;
    const apiKey = config.onesignal_api_key;

    if (!appId || !apiKey) {
      throw new BadRequestException(
        'OneSignal non configuré. Veuillez renseigner onesignal_app_id et onesignal_api_key dans les paramètres.',
      );
    }

    return { appId, apiKey };
  }

  // ── HTTP Wrapper ──

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    retryCount = 0,
    authMode: 'key' | 'bearer' = 'key',
  ): Promise<T> {
    const { apiKey } = await this.getConfig();

    const url = `${ONESIGNAL_API_BASE}${path}`;
    const headers: Record<string, string> = {
      'Authorization': authMode === 'bearer' ? `Bearer ${apiKey}` : `Key ${apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    };

    const options: RequestInit = { method, headers };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    this.logger.debug(`OneSignal ${method} ${path} [auth=${authMode}, key=${apiKey.substring(0, 15)}...]`);

    const response = await fetch(url, options);

    // Rate limit handling
    if (response.status === 429 && retryCount < 3) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (retryCount + 1) * 2000;
      this.logger.warn(`OneSignal rate limited. Retrying in ${waitMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.request<T>(method, path, body, retryCount + 1, authMode);
    }

    const data = response.status === 204 ? {} : await response.json();

    if (!response.ok) {
      const errorMessage = data?.errors
        ? Array.isArray(data.errors)
          ? data.errors.map((e: unknown) => (typeof e === 'string' ? e : JSON.stringify(e))).join(', ')
          : JSON.stringify(data.errors)
        : data?.title
          ? JSON.stringify({ title: data.title, code: data.code })
          : `OneSignal API error ${response.status}`;

      // 404 est attendu (user not found) — debug level
      // 409 — on log le body complet pour diagnostiquer
      if (response.status === 404) {
        this.logger.debug(`OneSignal ${method} ${path} → 404: ${errorMessage}`);
      } else if (response.status === 409) {
        this.logger.warn(`OneSignal ${method} ${path} → 409: ${JSON.stringify(data)}`);
      } else {
        this.logger.error(`OneSignal ${method} ${path} → ${response.status}: ${errorMessage}`);
      }

      throw new HttpException(
        { message: errorMessage, onesignal_status: response.status },
        response.status >= 500 ? 502 : response.status,
      );
    }

    return data as T;
  }

  // ── Messages ──

  async createMessage(dto: CreateOneSignalMessageDto) {
    const { appId } = await this.getConfig();
    const body: Record<string, unknown> = {
      app_id: appId,
      idempotency_key: randomUUID(),
      ...dto,
    };
    return this.request('POST', '/notifications', body);
  }

  async viewMessages(query: ViewMessagesQueryDto) {
    const { appId } = await this.getConfig();
    const params = new URLSearchParams({ app_id: appId });
    if (query.limit) params.append('limit', String(query.limit));
    if (query.offset) params.append('offset', String(query.offset));
    if (query.kind !== undefined) params.append('kind', String(query.kind));
    if (query.template_id) params.append('template_id', query.template_id);
    return this.request('GET', `/notifications?${params}`);
  }

  async viewMessage(messageId: string) {
    const { appId } = await this.getConfig();
    return this.request('GET', `/notifications/${messageId}?app_id=${appId}`);
  }

  async cancelMessage(messageId: string) {
    const { appId } = await this.getConfig();
    return this.request('DELETE', `/notifications/${messageId}?app_id=${appId}`);
  }

  async messageHistory(messageId: string, events: 'sent' | 'clicked') {
    const { appId } = await this.getConfig();
    return this.request('POST', `/notifications/${messageId}/history`, {
      app_id: appId,
      events,
    });
  }

  // ── Templates ──

  async createTemplate(dto: CreateOneSignalTemplateDto) {
    const { appId } = await this.getConfig();
    return this.request('POST', '/templates', { app_id: appId, ...dto });
  }

  async viewTemplates(query: ViewTemplatesQueryDto) {
    const { appId } = await this.getConfig();
    const params = new URLSearchParams({ app_id: appId });
    if (query.limit) params.append('limit', String(query.limit));
    if (query.offset) params.append('offset', String(query.offset));
    if (query.channel) params.append('channel', query.channel);
    return this.request('GET', `/templates?${params}`);
  }

  async viewTemplate(templateId: string) {
    const { appId } = await this.getConfig();
    return this.request('GET', `/templates/${templateId}?app_id=${appId}`);
  }

  async updateTemplate(templateId: string, dto: UpdateOneSignalTemplateDto) {
    const { appId } = await this.getConfig();
    return this.request('PATCH', `/templates/${templateId}?app_id=${appId}`, { ...dto });
  }

  async deleteTemplate(templateId: string) {
    const { appId } = await this.getConfig();
    return this.request('DELETE', `/templates/${templateId}?app_id=${appId}`);
  }

  // ── Segments ──

  async viewSegments(query: ViewSegmentsQueryDto) {
    const { appId } = await this.getConfig();
    const params = new URLSearchParams();
    if (query.limit) params.append('limit', String(query.limit));
    if (query.offset) params.append('offset', String(query.offset));
    const qs = params.toString() ? `?${params}` : '';
    return this.request('GET', `/apps/${appId}/segments${qs}`);
  }

  async createSegment(dto: CreateOneSignalSegmentDto) {
    const { appId } = await this.getConfig();
    return this.request('POST', `/apps/${appId}/segments`, { ...dto });
  }

  async updateSegment(segmentId: string, dto: UpdateOneSignalSegmentDto) {
    const { appId } = await this.getConfig();
    return this.request('PATCH', `/apps/${appId}/segments/${segmentId}`, { ...dto });
  }

  async deleteSegment(segmentId: string) {
    const { appId } = await this.getConfig();
    return this.request('DELETE', `/apps/${appId}/segments/${segmentId}`);
  }

  // ── Tags (User Data) ──

  /**
   * Met à jour les tags d'un utilisateur OneSignal via external_id.
   * Utilise PATCH avec Bearer auth (API Users v2).
   */
  async updateUserTags(
    externalId: string,
    tags: Record<string, string | number | boolean>,
  ): Promise<unknown> {
    const { appId } = await this.getConfig();
    return this.request(
      'PATCH',
      `/apps/${appId}/users/by/external_id/${externalId}`,
      { properties: { tags } },
      0,
      'bearer',
    );
  }

  // ── Users ──

  /**
   * Liste des utilisateurs OneSignal depuis la DB locale (customers avec onesignal_id).
   * Enrichi avec les données DB (nom, téléphone, ville, etc.).
   */
  async listUsers(query: { page?: number; limit?: number; search?: string }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      notification_settings: {
        onesignal_id: { not: null },
        active: true,
      },
    };

    if (query.search) {
      where.OR = [
        { first_name: { contains: query.search, mode: 'insensitive' } },
        { last_name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        select: {
          id: true,
          first_name: true,
          last_name: true,
          phone: true,
          email: true,
          loyalty_level: true,
          created_at: true,
          updated_at: true,
          addresses: {
            select: { city: true },
            take: 1,
          },
          notification_settings: {
            select: {
              onesignal_id: true,
              onesignal_subscription_id: true,
              push: true,
              promotions: true,
              system: true,
              active: true,
            },
          },
          _count: {
            select: { orders: true },
          },
        },
        orderBy: { updated_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return {
      items: items.map((c) => ({
        id: c.id,
        first_name: c.first_name,
        last_name: c.last_name,
        phone: c.phone,
        email: c.email,
        loyalty_level: c.loyalty_level,
        city: c.addresses[0]?.city ?? null,
        orders_count: c._count.orders,
        onesignal_id: c.notification_settings?.onesignal_id ?? null,
        onesignal_subscription_id: c.notification_settings?.onesignal_subscription_id ?? null,
        push_enabled: c.notification_settings?.push ?? false,
        promotions_enabled: c.notification_settings?.promotions ?? false,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Détail complet d'un utilisateur OneSignal via external_id (= customer.id).
   * Retourne : properties, subscriptions, identities/aliases.
   */
  async viewUser(externalId: string) {
    const { appId } = await this.getConfig();
    return this.request(
      'GET',
      `/apps/${appId}/users/by/external_id/${externalId}`,
      undefined,
      0,
      'bearer',
    );
  }

  /**
   * Mettre à jour un utilisateur OneSignal (tags, properties).
   */
  async updateUser(externalId: string, dto: UpdateOneSignalUserDto) {
    const { appId } = await this.getConfig();
    const body: Record<string, unknown> = {};

    if (dto.properties || dto.tags) {
      body.properties = { ...(dto.properties ?? {}) };
      if (dto.tags) {
        (body.properties as Record<string, unknown>).tags = dto.tags;
      }
    }

    return this.request(
      'PATCH',
      `/apps/${appId}/users/by/external_id/${externalId}`,
      body,
      0,
      'bearer',
    );
  }

  /**
   * Supprimer un utilisateur OneSignal.
   */
  async deleteUser(externalId: string) {
    const { appId } = await this.getConfig();
    return this.request(
      'DELETE',
      `/apps/${appId}/users/by/external_id/${externalId}`,
      undefined,
      0,
      'bearer',
    );
  }

  // ── Aliases ──

  /**
   * Voir les aliases/identities d'un utilisateur.
   */
  async fetchAliases(externalId: string) {
    const { appId } = await this.getConfig();
    return this.request(
      'GET',
      `/apps/${appId}/users/by/external_id/${externalId}/identity`,
      undefined,
      0,
      'bearer',
    );
  }

  /**
   * Ajouter un alias/identity à un utilisateur.
   */
  async createAlias(externalId: string, dto: CreateAliasDto) {
    const { appId } = await this.getConfig();
    return this.request(
      'PATCH',
      `/apps/${appId}/users/by/external_id/${externalId}/identity`,
      { identity: dto.identity },
      0,
      'bearer',
    );
  }

  /**
   * Supprimer un alias d'un utilisateur.
   */
  async deleteAlias(externalId: string, aliasLabel: string) {
    const { appId } = await this.getConfig();
    return this.request(
      'DELETE',
      `/apps/${appId}/users/by/external_id/${externalId}/identity/${aliasLabel}`,
      undefined,
      0,
      'bearer',
    );
  }

  // ── Subscriptions ──

  /**
   * Mettre à jour une subscription (activer/désactiver, changer token).
   */
  async updateSubscription(subscriptionId: string, dto: UpdateSubscriptionDto) {
    const { appId } = await this.getConfig();
    const body: Record<string, unknown> = {};
    if (dto.enabled !== undefined) body.enabled = dto.enabled;
    if (dto.token !== undefined) body.token = dto.token;
    if (dto.notification_types !== undefined) body.notification_types = dto.notification_types;

    return this.request(
      'PATCH',
      `/apps/${appId}/subscriptions/${subscriptionId}`,
      { subscription: body },
      0,
      'bearer',
    );
  }

  /**
   * Supprimer une subscription.
   */
  async deleteSubscription(subscriptionId: string) {
    const { appId } = await this.getConfig();
    return this.request(
      'DELETE',
      `/apps/${appId}/subscriptions/${subscriptionId}`,
      undefined,
      0,
      'bearer',
    );
  }

  // ── Analytics ──

  /**
   * Voir les outcomes (résultats des campagnes).
   */
  async viewOutcomes(params: {
    outcome_names: string;
    outcome_time_range?: string;
    outcome_platforms?: string;
    outcome_attribution?: string;
  }) {
    const { appId } = await this.getConfig();
    const qs = new URLSearchParams();
    qs.append('outcome_names', params.outcome_names);
    if (params.outcome_time_range) qs.append('outcome_time_range', params.outcome_time_range);
    if (params.outcome_platforms) qs.append('outcome_platforms', params.outcome_platforms);
    if (params.outcome_attribution) qs.append('outcome_attribution', params.outcome_attribution);
    return this.request('GET', `/apps/${appId}/outcomes?${qs}`);
  }

  /**
   * Export CSV des joueurs/users.
   */
  async exportCsvPlayers(extraFields?: string[], segmentName?: string) {
    const { appId } = await this.getConfig();
    const body: Record<string, unknown> = {};
    if (extraFields?.length) body.extra_fields = extraFields;
    if (segmentName) body.segment_name = segmentName;
    return this.request('POST', `/players/csv_export?app_id=${appId}`, body);
  }
}
