/**
 * Client HTTP pour l'API HubRise.
 *
 * Gère :
 * - Les appels authentifiés avec l'access_token (header X-Access-Token)
 * - La gestion du rate limiting (500 requêtes / 30 secondes)
 * - La pagination avec curseur
 * - Le parsing des réponses
 *
 * Documentation : https://developers.hubrise.com/api/general-concepts
 */

import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from 'src/modules/settings/settings.service';
import {
  HUBRISE_API_BASE_URL,
  HUBRISE_RATE_LIMIT,
} from '../constants/hubrise-endpoints.constant';

// Interface interne pour les options de requête
interface HubriseRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body?: Record<string, unknown>;
  /** Token d'accès spécifique (si différent du token global) */
  accessToken?: string;
  /** Paramètres de query string */
  params?: Record<string, string | number | undefined>;
}

@Injectable()
export class HubriseApiService {
  private readonly logger = new Logger(HubriseApiService.name);

  constructor(private readonly settingsService: SettingsService) {}

  // ─── Getters de configuration (async) ──────────────────────────────

  private async getHubriseConfig() {
    return this.settingsService.getManyOrEnv({
      hubrise_client_id: 'HUBRISE_CLIENT_ID',
      hubrise_client_secret: 'HUBRISE_CLIENT_SECRET',
      hubrise_access_token: 'HUBRISE_ACCESS_TOKEN',
      hubrise_webhook_secret: 'HUBRISE_WEBHOOK_SECRET',
      base_url: 'BASE_URL',
    });
  }

  async getClientId(): Promise<string> {
    const config = await this.getHubriseConfig();
    return config.hubrise_client_id || '';
  }

  async getClientSecret(): Promise<string> {
    const config = await this.getHubriseConfig();
    return config.hubrise_client_secret || '';
  }

  async getDefaultAccessToken(): Promise<string> {
    const config = await this.getHubriseConfig();
    return config.hubrise_access_token || '';
  }

  async getWebhookUrl(): Promise<string> {
    const config = await this.getHubriseConfig();
    const baseUrl = config.base_url || '';
    return `${baseUrl}/api/v1/hubrise/webhook`;
  }

  async getWebhookSecret(): Promise<string> {
    const config = await this.getHubriseConfig();
    return config.hubrise_webhook_secret || '';
  }

  // ─── Méthodes HTTP ───────────────────────────────────────────────────

  /**
   * Effectue une requête authentifiée vers l'API HubRise.
   * @param options - Options de la requête (method, url, body, accessToken)
   * @returns Réponse parsée en JSON
   */
  async request<T>(options: HubriseRequestOptions): Promise<T> {
    const { method, url, body, accessToken, params } = options;
    const token = accessToken || await this.getDefaultAccessToken();

    if (!token) {
      throw new Error('Aucun access_token HubRise configuré. Veuillez connecter votre compte HubRise.');
    }

    // Construire l'URL avec les query params
    const fullUrl = this.buildUrl(url, params);

    this.logger.debug(`[HubRise] ${method} ${fullUrl}`);

    try {
      const response = await fetch(fullUrl, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Token': token,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Vérifier le rate limiting (header X-RateLimit-Remaining)
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining && parseInt(remaining, 10) < 50) {
        this.logger.warn(
          `[HubRise] Rate limit proche : ${remaining} requêtes restantes sur ${HUBRISE_RATE_LIMIT.MAX_REQUESTS}`,
        );
      }

      // Gérer les erreurs HTTP
      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.error(
          `[HubRise] Erreur ${response.status} : ${errorBody}`,
        );
        throw new Error(
          `HubRise API erreur ${response.status}: ${errorBody}`,
        );
      }

      // 204 No Content → pas de body
      if (response.status === 204) {
        return {} as T;
      }

      return (await response.json()) as T;
    } catch (error) {
      this.logger.error(`[HubRise] Erreur de requête : ${error}`);
      throw error;
    }
  }

  /**
   * GET avec pagination automatique par curseur.
   * Récupère toutes les pages et concatène les résultats.
   *
   * @param url - URL de l'endpoint
   * @param accessToken - Token d'accès (optionnel)
   * @param maxPages - Nombre max de pages à récupérer (par défaut 10)
   */
  async fetchAllPages<T>(
    url: string,
    accessToken?: string,
    maxPages = 10,
  ): Promise<T[]> {
    const allResults: T[] = [];
    let cursor: string | undefined;
    let page = 0;

    do {
      const params: Record<string, string | number | undefined> = {};
      if (cursor) params.after = cursor;

      const response = await this.request<T[]>({
        method: 'GET',
        url,
        accessToken,
        params,
      });

      if (!Array.isArray(response) || response.length === 0) break;

      allResults.push(...response);

      // HubRise retourne le curseur dans les headers ou le dernier élément
      // On utilise l'ID du dernier élément comme curseur
      const lastItem = response[response.length - 1] as Record<string, unknown>;
      cursor = lastItem?.id as string | undefined;

      page++;
    } while (cursor && page < maxPages);

    return allResults;
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────

  /**
   * Construit l'URL complète avec les query params.
   */
  private buildUrl(
    url: string,
    params?: Record<string, string | number | undefined>,
  ): string {
    // Si l'URL ne commence pas par http, la préfixer avec la base URL
    const fullUrl = url.startsWith('http') ? url : `${HUBRISE_API_BASE_URL}${url}`;

    if (!params) return fullUrl;

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }

    const qs = searchParams.toString();
    return qs ? `${fullUrl}?${qs}` : fullUrl;
  }

  /**
   * Vérifie si la connexion HubRise est configurée.
   */
  async isConfigured(): Promise<boolean> {
    const config = await this.getHubriseConfig();
    return !!config.hubrise_client_id && !!config.hubrise_client_secret;
  }

  /**
   * Vérifie si un access_token est disponible.
   */
  async hasAccessToken(token?: string): Promise<boolean> {
    if (token) return true;
    const defaultToken = await this.getDefaultAccessToken();
    return !!defaultToken;
  }
}
