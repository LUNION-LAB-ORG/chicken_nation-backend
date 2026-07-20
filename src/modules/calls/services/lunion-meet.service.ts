import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { SettingsService } from 'src/modules/settings/settings.service';

interface LunionRoom {
  id: string;
  slug: string;
  name: string;
  ownerId?: string;
}

interface LunionToken {
  token: string;
  url: string;
  room: string;
  identity: string;
  expiresAt?: string;
}

/**
 * Wrapper REST de l'API Lunion Meet (https://meet.lunion-lab.com/api/v1).
 * La clé API serveur (`lk_xxx.secret`) reste STRICTEMENT backend — elle n'est
 * jamais renvoyée au client. Le client ne reçoit qu'un token participant à TTL court.
 */
@Injectable()
export class LunionMeetService {
  private readonly logger = new Logger(LunionMeetService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  private baseUrl(): string {
    return this.config.get<string>('LUNION_API_URL', 'https://meet.lunion-lab.com/api/v1');
  }

  private async apiKey(): Promise<string> {
    // env-first, avec surcharge possible via Setting `calls.lunion_api_key`.
    const key = await this.settings.getOrEnvSafe('calls.lunion_api_key', 'LUNION_API_KEY', '');
    if (!key) {
      throw new HttpException(
        "Service d'appel non configuré (LUNION_API_KEY manquante)",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return key;
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const key = await this.apiKey();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      this.logger.error(`Lunion ${method} ${path} injoignable: ${(e as Error).message}`);
      throw new HttpException('Service Lunion Meet injoignable', HttpStatus.BAD_GATEWAY);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`Lunion ${method} ${path} → ${res.status} ${text}`);
      throw new HttpException(`Lunion Meet: ${res.status}`, HttpStatus.BAD_GATEWAY);
    }
    return (await res.json()) as T;
  }

  /** Crée une room d'appel. */
  async createRoom(name: string, description?: string): Promise<LunionRoom> {
    return this.request<LunionRoom>('/sdk/rooms', 'POST', { name, description });
  }

  /**
   * Génère un token participant pour une room (audio : micro + écoute).
   * @param ttlSeconds durée de vie du token (60–86400). Défaut 1h.
   */
  async createToken(
    slug: string,
    identity: string,
    name?: string,
    ttlSeconds = 3600,
  ): Promise<LunionToken> {
    return this.request<LunionToken>(`/sdk/rooms/${slug}/token`, 'POST', {
      identity,
      name,
      ttlSeconds,
      grants: { canPublish: true, canSubscribe: true, canPublishData: true },
    });
  }

  /** Supprime une room (best-effort, en fin d'appel — n'échoue jamais l'appelant). */
  async deleteRoom(slug: string): Promise<void> {
    try {
      await this.request(`/sdk/rooms/${slug}`, 'DELETE');
    } catch (e) {
      this.logger.warn(`Suppression room ${slug} ignorée: ${(e as Error).message}`);
    }
  }

  /**
   * Vérifie la signature HMAC-SHA256 d'un webhook Lunion.
   * Si aucun secret n'est configuré, on n'impose pas la vérification (retourne true).
   */
  async verifyWebhook(rawBody: Buffer | string, signature?: string): Promise<boolean> {
    const secret = await this.settings.getOrEnvSafe(
      'calls.lunion_webhook_secret',
      'LUNION_WEBHOOK_SECRET',
      '',
    );
    if (!secret) return true;
    if (!signature) return false;
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
