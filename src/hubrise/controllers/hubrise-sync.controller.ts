/**
 * Contrôleur pour les actions manuelles de synchronisation HubRise.
 *
 * Ces endpoints permettent aux administrateurs du backoffice de :
 * - Déclencher un pull/push du catalogue
 * - Déclencher un import des clients
 * - Prévisualiser et appliquer l'auto-matching des références
 *
 * Endpoints :
 * - POST /hubrise/sync/catalog/pull/:restaurantId       → Import catalogue HubRise → CN
 * - POST /hubrise/sync/catalog/push/:restaurantId       → Push catalogue CN → HubRise
 * - POST /hubrise/sync/customers/pull/:restaurantId     → Import clients HubRise → CN
 * - GET  /hubrise/sync/catalog/match/:restaurantId      → Preview auto-matching
 * - POST /hubrise/sync/catalog/match/:restaurantId      → Appliquer l'auto-matching
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Logger,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { HubriseAuthService } from '../services/hubrise-auth.service';
import {
  HubriseCatalogSyncService,
  MatchConfirmation,
} from '../services/hubrise-catalog-sync.service';
import { HubriseCustomerSyncService } from '../services/hubrise-customer-sync.service';

@Controller('hubrise/sync')
export class HubriseSyncController {
  private readonly logger = new Logger(HubriseSyncController.name);

  constructor(
    private readonly authService: HubriseAuthService,
    private readonly catalogSync: HubriseCatalogSyncService,
    private readonly customerSync: HubriseCustomerSyncService,
  ) {}

  /**
   * Importe le catalogue HubRise dans Chicken Nation.
   * Nécessite que le restaurant soit connecté à HubRise avec un catalogue configuré.
   */
  @Post('catalog/pull/:restaurantId')
  @HttpCode(HttpStatus.OK)
  async pullCatalog(@Param('restaurantId') restaurantId: string) {
    this.logger.log(`[HubRise Sync] Pull catalogue pour restaurant ${restaurantId}`);

    // Vérifier la connexion HubRise
    const info = await this.authService.getHubriseInfoForRestaurant(restaurantId);
    if (!info?.hubrise_access_token || !info?.hubrise_catalog_id) {
      throw new BadRequestException(
        'Le restaurant n\'est pas connecté à HubRise ou n\'a pas de catalogue configuré.',
      );
    }

    const result = await this.catalogSync.pullCatalog(
      info.hubrise_catalog_id,
      restaurantId,
      info.hubrise_access_token,
    );

    return {
      success: true,
      message: 'Catalogue importé depuis HubRise',
      result,
    };
  }

  /**
   * Envoie le catalogue Chicken Nation vers HubRise.
   * Nécessite que le restaurant soit connecté à HubRise avec un catalogue configuré.
   */
  @Post('catalog/push/:restaurantId')
  @HttpCode(HttpStatus.OK)
  async pushCatalog(@Param('restaurantId') restaurantId: string) {
    this.logger.log(`[HubRise Sync] Push catalogue pour restaurant ${restaurantId}`);

    const info = await this.authService.getHubriseInfoForRestaurant(restaurantId);
    if (!info?.hubrise_access_token || !info?.hubrise_catalog_id) {
      throw new BadRequestException(
        'Le restaurant n\'est pas connecté à HubRise ou n\'a pas de catalogue configuré.',
      );
    }

    await this.catalogSync.pushCatalog(
      restaurantId,
      info.hubrise_access_token,
      info.hubrise_catalog_id,
    );

    return {
      success: true,
      message: 'Catalogue envoyé vers HubRise',
    };
  }

  /**
   * Importe tous les clients HubRise dans Chicken Nation.
   * Utile pour la synchronisation initiale après connexion.
   */
  @Post('customers/pull/:restaurantId')
  @HttpCode(HttpStatus.OK)
  async pullCustomers(@Param('restaurantId') restaurantId: string) {
    this.logger.log(`[HubRise Sync] Import clients pour restaurant ${restaurantId}`);

    const info = await this.authService.getHubriseInfoForRestaurant(restaurantId);
    if (!info?.hubrise_access_token || !info?.hubrise_customer_list_id) {
      throw new BadRequestException(
        'Le restaurant n\'est pas connecté à HubRise ou n\'a pas de liste de clients configurée.',
      );
    }

    const result = await this.customerSync.pullAllCustomers(
      info.hubrise_customer_list_id,
      info.hubrise_access_token,
    );

    return {
      success: true,
      message: 'Clients importés depuis HubRise',
      result,
    };
  }

  // ─── AUTO-MATCHING ─────────────────────────────────────────────────

  /**
   * Prévisualise l'auto-matching entre le catalogue HubRise et les données CN.
   *
   * Compare les noms des catégories et plats HubRise avec ceux de CN
   * et retourne les correspondances proposées avec un score de confiance.
   *
   * Exemple de réponse :
   * {
   *   summary: { categories: { total: 5, alreadyLinked: 2, proposed: 2, noMatch: 1 }, ... },
   *   categoryMatches: [
   *     { hubriseRef: "CAT_01", hubriseName: "Poulets", cnId: "xxx", cnName: "Poulets Braisés", confidence: 80, status: "proposed" }
   *   ],
   *   dishMatches: [
   *     { hubriseRef: "DISH_01", hubriseName: "Poulet Braisé", cnId: "yyy", cnName: "Poulet braisé", confidence: 100, ... }
   *   ]
   * }
   */
  @Get('catalog/match/:restaurantId')
  async previewMatch(@Param('restaurantId') restaurantId: string) {
    this.logger.log(`[HubRise Matching] Preview pour restaurant ${restaurantId}`);

    const info = await this.authService.getHubriseInfoForRestaurant(restaurantId);
    if (!info?.hubrise_access_token || !info?.hubrise_catalog_id) {
      throw new BadRequestException(
        'Le restaurant n\'est pas connecté à HubRise ou n\'a pas de catalogue configuré.',
      );
    }

    const preview = await this.catalogSync.previewAutoMatch(
      info.hubrise_catalog_id,
      restaurantId,
      info.hubrise_access_token,
    );

    return {
      success: true,
      ...preview,
    };
  }

  /**
   * Applique les correspondances validées.
   * Écrit les `reference` HubRise dans les Category et Dish de CN.
   *
   * Body attendu :
   * {
   *   matches: [
   *     { type: "category", cnId: "uuid-xxx", hubriseRef: "CAT_01" },
   *     { type: "dish", cnId: "uuid-yyy", hubriseRef: "DISH_01" },
   *     ...
   *   ]
   * }
   */
  @Post('catalog/match/:restaurantId')
  @HttpCode(HttpStatus.OK)
  async applyMatch(
    @Param('restaurantId') _restaurantId: string,
    @Body() body: { matches: MatchConfirmation[] },
  ) {
    if (!body.matches || !Array.isArray(body.matches) || body.matches.length === 0) {
      throw new BadRequestException('Le champ "matches" est requis et doit contenir au moins une correspondance.');
    }

    this.logger.log(`[HubRise Matching] Application de ${body.matches.length} correspondances`);

    const result = await this.catalogSync.applyAutoMatch(body.matches);

    return {
      success: true,
      message: `${result.categoriesUpdated} catégories et ${result.dishesUpdated} plats mis à jour`,
      result,
    };
  }
}
