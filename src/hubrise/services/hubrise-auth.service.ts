/**
 * Service d'authentification OAuth 2.0 HubRise.
 *
 * Flux OAuth :
 * 1. L'utilisateur est redirigé vers HubRise pour autoriser l'application
 * 2. HubRise redirige vers notre callback avec un `code` d'autorisation
 * 3. On échange ce `code` contre un `access_token`
 * 4. Le token est stocké en base (Restaurant.hubrise_access_token)
 *
 * Documentation : https://developers.hubrise.com/api/authentication
 *
 * ⚠️ Scopes disponibles (format HubRise) :
 * location[resource.access_right, ...] — permissions à l'intérieur des crochets
 * Exemple : location[orders.write,customer_list.write,catalog.read]
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/database/services/prisma.service';
import { HUBRISE_OAUTH } from '../constants/hubrise-endpoints.constant';

// Scopes demandés — format HubRise : location[resource.access, ...]
// write inclut read — une seule permission par resource type
const HUBRISE_SCOPES =
  'location[orders.write,customer_list.write,catalog.read]';

// Réponse du token OAuth HubRise
interface HubriseTokenResponse {
  access_token: string;
  /** ID du compte HubRise */
  account_id?: string;
  /** ID du location HubRise connecté */
  location_id?: string;
  /** Nom du location */
  location_name?: string;
  /** ID de la liste de clients */
  customer_list_id?: string;
  /** ID du catalogue */
  catalog_id?: string;
}

@Injectable()
export class HubriseAuthService {
  private readonly logger = new Logger(HubriseAuthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Génère l'URL d'autorisation OAuth HubRise.
   * L'utilisateur sera redirigé vers cette URL pour connecter son compte.
   *
   * @param restaurantId - ID du restaurant CN (passé dans le state pour le récupérer au callback)
   * @returns URL complète d'autorisation HubRise
   */
  getAuthorizationUrl(restaurantId: string): string {
    const clientId = this.configService.get<string>('HUBRISE_CLIENT_ID');
    const redirectUri = this.getRedirectUri();

    if (!clientId) {
      throw new Error('HUBRISE_CLIENT_ID non configuré dans les variables d\'environnement.');
    }

    // Construction manuelle de l'URL pour éviter l'encodage des crochets []
    // URLSearchParams encode [] en %5B%5D, ce que HubRise n'accepte pas
    const params = [
      `redirect_uri=${encodeURIComponent(redirectUri)}`,
      `client_id=${encodeURIComponent(clientId)}`,
      `scope=${HUBRISE_SCOPES}`,
      `state=${encodeURIComponent(restaurantId)}`,
    ].join('&');

    return `${HUBRISE_OAUTH.AUTHORIZE}?${params}`;
  }

  /**
   * Échange le code d'autorisation contre un access_token.
   * Appelé lors du callback OAuth après que l'utilisateur a autorisé l'app.
   *
   * @param code - Code d'autorisation reçu de HubRise
   * @param restaurantId - ID du restaurant CN (récupéré du state)
   * @returns Token et infos du location HubRise
   */
  async exchangeCodeForToken(
    code: string,
    restaurantId: string,
  ): Promise<HubriseTokenResponse> {
    const clientId = this.configService.get<string>('HUBRISE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('HUBRISE_CLIENT_SECRET');

    this.logger.log(`[HubRise OAuth] Échange du code pour le restaurant ${restaurantId}`);

    try {
      // Postman collection : code, client_id, client_secret (pas de redirect_uri)
      const response = await fetch(HUBRISE_OAUTH.TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId!,
          client_secret: clientSecret!,
        }).toString(),
      });

      if (!response.ok) {
        const error = await response.text();
        this.logger.error(`[HubRise OAuth] Erreur échange token : ${error}`);
        throw new Error(`Erreur OAuth HubRise : ${error}`);
      }

      const tokenData = (await response.json()) as HubriseTokenResponse;

      // Sauvegarder le token et le location_id dans le restaurant
      await this.saveTokenForRestaurant(restaurantId, tokenData);

      this.logger.log(
        `[HubRise OAuth] Token obtenu pour le location ${tokenData.location_id}`,
      );

      return tokenData;
    } catch (error) {
      this.logger.error(`[HubRise OAuth] Erreur : ${error}`);
      throw error;
    }
  }

  /**
   * Sauvegarde le token OAuth et le location_id dans le restaurant.
   * Met à jour les champs hubrise_* du modèle Restaurant.
   */
  private async saveTokenForRestaurant(
    restaurantId: string,
    tokenData: HubriseTokenResponse,
  ): Promise<void> {
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        hubrise_access_token: tokenData.access_token,
        hubrise_location_id: tokenData.location_id ?? null,
        hubrise_catalog_id: tokenData.catalog_id ?? null,
        hubrise_customer_list_id: tokenData.customer_list_id ?? null,
      },
    });

    this.logger.log(
      `[HubRise OAuth] Token sauvegardé pour le restaurant ${restaurantId} (location: ${tokenData.location_id})`,
    );
  }

  /**
   * Récupère le token HubRise d'un restaurant.
   * @returns Le token ou null si le restaurant n'est pas connecté
   */
  async getTokenForRestaurant(restaurantId: string): Promise<string | null> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { hubrise_access_token: true },
    });

    return restaurant?.hubrise_access_token ?? null;
  }

  /**
   * Récupère les infos HubRise d'un restaurant.
   */
  async getHubriseInfoForRestaurant(restaurantId: string) {
    return this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        name: true,
        hubrise_access_token: true,
        hubrise_location_id: true,
        hubrise_catalog_id: true,
        hubrise_customer_list_id: true,
      },
    });
  }

  /**
   * Déconnecte un restaurant de HubRise.
   * 1. Révoque le token côté HubRise (POST /oauth2/v1/revoke avec Basic Auth)
   * 2. Supprime les données OAuth en base
   */
  async disconnectRestaurant(restaurantId: string): Promise<void> {
    // Récupérer le token avant de le supprimer pour le révoquer
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { hubrise_access_token: true },
    });

    // Révoquer le token côté HubRise
    if (restaurant?.hubrise_access_token) {
      await this.revokeToken(restaurant.hubrise_access_token);
    }

    // Supprimer les données OAuth en base
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        hubrise_access_token: null,
        hubrise_location_id: null,
        hubrise_catalog_id: null,
        hubrise_customer_list_id: null,
      },
    });

    this.logger.log(`[HubRise] Restaurant ${restaurantId} déconnecté de HubRise`);
  }

  /**
   * Révoque un access_token auprès de HubRise.
   * POST /oauth2/v1/revoke avec Basic Auth (client_id:client_secret)
   * et le token dans le body.
   */
  private async revokeToken(accessToken: string): Promise<void> {
    const clientId = this.configService.get<string>('HUBRISE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('HUBRISE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      this.logger.warn('[HubRise OAuth] Impossible de révoquer — client_id ou client_secret manquant');
      return;
    }

    try {
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const response = await fetch(HUBRISE_OAUTH.REVOKE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({ token: accessToken }).toString(),
      });

      if (response.ok) {
        this.logger.log('[HubRise OAuth] Token révoqué avec succès');
      } else {
        const error = await response.text();
        this.logger.warn(`[HubRise OAuth] Erreur révocation token : ${error}`);
      }
    } catch (error) {
      // Ne pas bloquer la déconnexion locale si la révocation échoue
      this.logger.warn(`[HubRise OAuth] Erreur réseau lors de la révocation : ${error}`);
    }
  }

  /**
   * Vérifie si un restaurant est connecté à HubRise.
   */
  async isRestaurantConnected(restaurantId: string): Promise<boolean> {
    const token = await this.getTokenForRestaurant(restaurantId);
    return !!token;
  }

  /**
   * Récupère tous les restaurants connectés à HubRise.
   */
  async getConnectedRestaurants() {
    return this.prisma.restaurant.findMany({
      where: {
        hubrise_access_token: { not: null },
        hubrise_location_id: { not: null },
      },
      select: {
        id: true,
        name: true,
        hubrise_location_id: true,
        hubrise_catalog_id: true,
      },
    });
  }

  // ─── Utilitaires internes ──────────────────────────────────────────

  /**
   * Construit l'URI de redirection OAuth.
   */
  private getRedirectUri(): string {
    const baseUrl = this.configService.get<string>('BASE_URL', '');
    return `${baseUrl}/api/v1/hubrise/auth/callback`;
  }
}
