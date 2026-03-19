import { Injectable, Logger, BadRequestException, HttpException } from '@nestjs/common';
import { SettingsService } from 'src/modules/settings/settings.service';
import { randomUUID } from 'crypto';
import { CreateMessageDto } from './dto/create-message.dto';
import { ViewMessagesQueryDto, ViewTemplatesQueryDto, ViewSegmentsQueryDto } from './dto/view-messages-query.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';

const ONESIGNAL_API_BASE = 'https://api.onesignal.com';

interface OnesignalConfig {
  appId: string;
  apiKey: string;
}

@Injectable()
export class OnesignalService {
  private readonly logger = new Logger(OnesignalService.name);

  constructor(private readonly settingsService: SettingsService) {}

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

  async createMessage(dto: CreateMessageDto) {
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

  async createTemplate(dto: CreateTemplateDto) {
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

  async updateTemplate(templateId: string, dto: UpdateTemplateDto) {
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

  async createSegment(dto: CreateSegmentDto) {
    const { appId } = await this.getConfig();
    return this.request('POST', `/apps/${appId}/segments`, { ...dto });
  }

  async updateSegment(segmentId: string, dto: UpdateSegmentDto) {
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
}
