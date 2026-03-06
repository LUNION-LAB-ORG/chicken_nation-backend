import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { StatisticsMarketingService } from '../services/statistics-marketing.service';
import {
  PromoUsageQueryDto,
  ChurnExportQueryDto,
  TopZonesQueryDto,
} from '../dto/marketing-stats.dto';

@Controller('statistics/marketing')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
@UseInterceptors(CacheInterceptor)
export class StatisticsMarketingController {
  constructor(private readonly marketingService: StatisticsMarketingService) {}

  /**
   * GET /statistics/marketing/promo-usage
   * Utilisation et performance des codes promos / promotions.
   * Mesure du ROI d'une campagne Facebook ou d'influence.
   * Filtres : restaurantId, startDate, endDate, period, promotionId, promoCode
   */
  @Get('promo-usage')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getPromoUsage(@Query() query: PromoUsageQueryDto) {
    return this.marketingService.getPromoUsage(query);
  }

  /**
   * GET /statistics/marketing/promotions-performance
   * Performance globale de toutes les promotions actives et passées.
   * Taux d'utilisation, CA généré, dates de validité.
   * Filtres : restaurantId, startDate, endDate, period
   */
  @Get('promotions-performance')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getPromotionsPerformance(@Query() query: PromoUsageQueryDto) {
    return this.marketingService.getPromotionsPerformance(query);
  }

  /**
   * GET /statistics/marketing/top-zones
   * Top N zones de livraison pour cibler le street marketing (flyers).
   * Retourne lat/lng centroïde pour affichage carte Google Maps.
   * Filtres : restaurantId, startDate, endDate, period, limit
   */
  @Get('top-zones')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getTopZones(@Query() query: TopZonesQueryDto) {
    return this.marketingService.getTopZones(query);
  }

  /**
   * GET /statistics/marketing/churn-export
   * Export des clients en churn (inactifs depuis N jours) pour campagnes SMS/WhatsApp.
   * Retourne : téléphone, prénom, nom, email, date dernière commande, canal préféré.
   * Filtres : restaurantId, inactiveDays (défaut: 30)
   */
  @Get('churn-export')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  async getChurnExport(@Query() query: ChurnExportQueryDto) {
    return this.marketingService.getChurnExport(query);
  }
}
