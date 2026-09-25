/**
 * Contrôleur d'authentification OAuth 2.0 HubRise.
 *
 * Endpoints :
 * - POST /hubrise/auth/connect/:restaurantId → Renvoie l'URL d'autorisation HubRise ({ url })
 * - GET  /hubrise/auth/callback             → Callback OAuth (reçoit le code)
 * - GET  /hubrise/auth/status/:restaurantId  → Vérifie si un restaurant est connecté
 * - POST /hubrise/auth/disconnect/:restaurantId → Déconnecte un restaurant
 * - GET  /hubrise/auth/connected            → Liste les restaurants connectés
 */

import {
  Controller,
  UseGuards,
  Get,
  Post,
  Param,
  Query,
  Req,
  Res,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { User } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';

import { HubriseAuthService } from '../services/hubrise-auth.service';
import { HubriseWebhookService } from '../services/hubrise-webhook.service';
import { MotifRetour, urlRetourBackoffice } from '../utils/retour-oauth.util';

@Controller('hubrise/auth')
export class HubriseAuthController {
  private readonly logger = new Logger(HubriseAuthController.name);

  constructor(
    private readonly authService: HubriseAuthService,
    private readonly webhookService: HubriseWebhookService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Prépare la connexion OAuth avec HubRise pour un restaurant et renvoie
   * l'URL d'autorisation, que le backoffice ouvre lui-même.
   *
   * ⚠️ Appel AUTHENTIFIÉ qui répond en JSON, et non plus une redirection :
   * l'écran ouvrait cette route par `window.open`, sans en-tête Bearer, donc
   * 401 pour tout le monde. Le `state` signé y lie le restaurant à
   * l'utilisateur qui demande la connexion.
   *
   * @param restaurantId - ID du restaurant CN à connecter
   */
  // ⚠️ CREATE et non READ, comme disconnect : cette route lance un OAuth dont
  // le retour réécrit le jeton HubRise du restaurant. En READ, un rôle en
  // simple consultation (Marketing, Comptable) pouvait rattacher un restaurant
  // à son propre compte HubRise.
  @Post('connect/:restaurantId')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.RESTAURANTS, Action.CREATE)
  @HttpCode(HttpStatus.OK)
  async connect(
    @Param('restaurantId') restaurantId: string,
    @Req() req: Request,
  ): Promise<{ url: string }> {
    const user = req.user as User;
    const url = await this.authService.getAuthorizationUrl(restaurantId, user.id);
    return { url };
  }

  /**
   * Callback OAuth — reçoit le code d'autorisation de HubRise.
   * Vérifie le `state` signé AVANT tout échange, échange le code, enregistre
   * le jeton sans écraser une autre liaison, puis inscrit le webhook.
   * Termine TOUJOURS par une redirection vers le backoffice, avec un motif en
   * cas d'échec (jamais de JSON brut dans l'onglet de l'utilisateur).
   *
   * @param code - Code d'autorisation retourné par HubRise
   * @param state - `state` signé par `getAuthorizationUrl`
   * @param error - Présent si l'utilisateur a refusé sur HubRise (access_denied)
   */
  // ⚠️ VOLONTAIREMENT SANS GARDE : retour OAuth appelé par le navigateur de
  // l'utilisateur, redirigé par HubRise, donc sans jeton. Toute la confiance
  // repose sur le `state` signé et le nonce à usage unique.
  @Get('callback')
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Res() res: Response,
  ) {
    const base = this.config.get<string>('BACKOFFICE_URL');
    let motif: MotifRetour | null = null;

    try {
      const retour = await this.authService.traiterRetour({ code, state, error });
      if (retour.ok) {
        // Enregistrer le webhook callback (le token est scopé au location)
        await this.webhookService.registerCallback(retour.accessToken);
      } else {
        motif = retour.motif;
      }
    } catch (erreur) {
      this.logger.error(`[HubRise Auth] Erreur callback : ${erreur}`);
      motif = 'echec';
    }

    return res.redirect(urlRetourBackoffice(base, motif));
  }

  /**
   * Vérifie si un restaurant est connecté à HubRise.
   * Retourne les infos HubRise du restaurant.
   */
  @Get('status/:restaurantId')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.RESTAURANTS, Action.READ)
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
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.RESTAURANTS, Action.CREATE)
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
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.RESTAURANTS, Action.READ)
  async connected() {
    const restaurants = await this.authService.getConnectedRestaurants();

    return {
      count: restaurants.length,
      restaurants,
    };
  }
}
