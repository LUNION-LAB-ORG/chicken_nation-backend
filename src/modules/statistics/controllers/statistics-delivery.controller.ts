import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { StatisticsDeliveryService } from '../services/statistics-delivery.service';
import { DeliveryStatsQueryDto } from '../dto/delivery-stats.dto';

@Controller('statistics/delivery')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
@UseInterceptors(CacheInterceptor)
export class StatisticsDeliveryController {
  constructor(private readonly deliveryService: StatisticsDeliveryService) {}

  /**
   * GET /statistics/delivery/overview
   * Vue d'ensemble livraison : total commandes livraison, CA, frais de livraison perçus, panier moyen.
   * Filtres : restaurantId, startDate, endDate, period
   */
  @Get('overview')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getDeliveryOverview(@Query() query: DeliveryStatsQueryDto) {
    return this.deliveryService.getDeliveryOverview(query);
  }

  /**
   * GET /statistics/delivery/fees-breakdown
   * Décomposition des frais de livraison par tranche (Gratuit, 500 FCFA, 1000 FCFA…).
   * Répartition en % pour chaque tranche, CA généré, frais collectés.
   * Filtres : restaurantId, startDate, endDate, period
   */
  @Get('fees-breakdown')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getDeliveryFeesBreakdown(@Query() query: DeliveryStatsQueryDto) {
    return this.deliveryService.getDeliveryFeesBreakdown(query);
  }

  /**
   * GET /statistics/delivery/by-zone
   * Top zones de livraison : nombre de commandes, CA et part en % par ville/quartier.
   * Filtres : restaurantId, startDate, endDate, period, limit
   */
  @Get('by-zone')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getDeliveryByZone(@Query() query: DeliveryStatsQueryDto) {
    return this.deliveryService.getDeliveryByZone(query);
  }

  /**
   * GET /statistics/delivery/performance
   * Performance de livraison : temps moyen, taux de ponctualité, commandes en retard.
   * Filtres : restaurantId, startDate, endDate, period
   */
  @Get('performance')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getDeliveryPerformance(@Query() query: DeliveryStatsQueryDto) {
    return this.deliveryService.getDeliveryPerformance(query);
  }
}
