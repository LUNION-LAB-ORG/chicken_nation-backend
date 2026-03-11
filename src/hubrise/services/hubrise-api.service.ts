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
import { ConfigService } from '@nestjs/config';
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

  constructor(private readonly configService: ConfigService) {}

  // ─── Getters de configuration ────────────────────────────────────────

  /** Client ID de l'application HubRise */
  get clientId(): string {
    return this.configService.get<string>('HUBRISE_CLIENT_ID', '');
  }

  /** Client Secret de l'application HubRise */
  get clientSecret(): string {
    return this.configService.get<string>('HUBRISE_CLIENT_SECRET', '');
  }

  /** Access Token global (si configuré via env) */
  get defaultAccessToken(): string {
    return this.configService.get<string>('HUBRISE_ACCESS_TOKEN', '');
  }

  /** URL de callback pour les webhooks */
  get webhookUrl(): string {
    const baseUrl = this.configService.get<string>('BASE_URL', '');
    return `${baseUrl}/api/v1/hubrise/webhook`;
  }

  /** Secret HMAC pour la vérification des callbacks */
  get webhookSecret(): string {
    return this.configService.get<string>('HUBRISE_WEBHOOK_SECRET', '');
  }

  // ─── Méthodes HTTP ───────────────────────────────────────────────────

  /**
   * Effectue une requête authentifiée vers l'API HubRise.
   * @param options - Options de la requête (method, url, body, accessToken)
   * @returns Réponse parsée en JSON
   */
  async request<T>(options: HubriseRequestOptions): Promise<T> {
    const { method, url, body, accessToken, params } = options;
    const token = accessToken || this.defaultAccessToken;

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
  isConfigured(): boolean {
    return !!this.clientId && !!this.clientSecret;
  }

  /**
   * Vérifie si un access_token est disponible.
   */
  hasAccessToken(token?: string): boolean {
    return !!(token || this.defaultAccessToken);
  }
}
