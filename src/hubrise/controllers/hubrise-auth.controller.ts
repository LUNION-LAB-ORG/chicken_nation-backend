/**
 * Contrôleur d'authentification OAuth 2.0 HubRise.
 *
 * Endpoints :
 * - GET  /hubrise/auth/connect/:restaurantId → Redirige vers HubRise pour autoriser
 * - GET  /hubrise/auth/callback             → Callback OAuth (reçoit le code)
 * - GET  /hubrise/auth/status/:restaurantId  → Vérifie si un restaurant est connecté
 * - POST /hubrise/auth/disconnect/:restaurantId → Déconnecte un restaurant
 * - GET  /hubrise/auth/connected            → Liste les restaurants connectés
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Res,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { HubriseAuthService } from '../services/hubrise-auth.service';
import { HubriseWebhookService } from '../services/hubrise-webhook.service';

@Controller('hubrise/auth')
export class HubriseAuthController {
  private readonly logger = new Logger(HubriseAuthController.name);

  constructor(
    private readonly authService: HubriseAuthService,
    private readonly webhookService: HubriseWebhookService,
  ) {}

  /**
   * Initie la connexion OAuth avec HubRise pour un restaurant.
   * Redirige l'utilisateur vers la page d'autorisation HubRise.
   *
   * @param restaurantId - ID du restaurant CN à connecter
   */
  @Get('connect/:restaurantId')
  async connect(
    @Param('restaurantId') restaurantId: string,
    @Res() res: Response,
  ) {
    this.logger.log(`[HubRise Auth] Connexion initiée pour le restaurant ${restaurantId}`);

    const authUrl = this.authService.getAuthorizationUrl(restaurantId);
    return res.redirect(authUrl);
  }

  /**
   * Callback OAuth — reçoit le code d'autorisation de HubRise.
   * Échange le code contre un access_token et enregistre le webhook.
   *
   * @param code - Code d'autorisation retourné par HubRise
   * @param state - ID du restaurant CN (passé dans le state)
   */
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    this.logger.log(`[HubRise Auth] Callback OAuth reçu — state: ${state}`);

    try {
      if (!code || !state) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          message: 'Paramètres manquants (code ou state)',
        });
      }

      // Échanger le code contre un token
      const tokenData = await this.authService.exchangeCodeForToken(code, state);

      // Enregistrer le webhook callback (le token est scopé au location)
      if (tokenData.access_token) {
        await this.webhookService.registerCallback(tokenData.access_token);
      }

      // Rediriger vers le backoffice avec un message de succès
      const backofficeUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(
        `${backofficeUrl}/gestion?hubrise=connected&location=${tokenData.location_id}`,
      );
    } catch (error) {
      this.logger.error(`[HubRise Auth] Erreur callback : ${error}`);
      const backofficeUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${backofficeUrl}/gestion?hubrise=error`);
    }
  }

  /**
   * Vérifie si un restaurant est connecté à HubRise.
   * Retourne les infos HubRise du restaurant.
   */
  @Get('status/:restaurantId')
  async status(@Param('restaurantId') restaurantId: string) {
    const info = await this.authService.getHubriseInfoForRestaurant(restaurantId);

    return {
      connected: !!info?.hubrise_access_token,
      locationId: info?.hubrise_location_id ?? null,
      catalogId: info?.hubrise_catalog_id ?? null,
      customerListId: info?.hubrise_customer_list_id ?? null,
    };
  }

  /**
   * Déconnecte un restaurant de HubRise.
   * Supprime le token et les infos HubRise du restaurant.
   */
  @Post('disconnect/:restaurantId')
  @HttpCode(HttpStatus.OK)
  async disconnect(@Param('restaurantId') restaurantId: string) {
    await this.authService.disconnectRestaurant(restaurantId);

    return {
      success: true,
      message: 'Restaurant déconnecté de HubRise',
    };
  }

  /**
   * Liste tous les restaurants connectés à HubRise.
   */
  @Get('connected')
  async connected() {
    const restaurants = await this.authService.getConnectedRestaurants();

    return {
      count: restaurants.length,
      restaurants,
    };
  }
}
