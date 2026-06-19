import { CacheTTL } from '@nestjs/cache-manager';
import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { UserScopedCacheInterceptor } from 'src/modules/order/interceptors/user-scoped-cache.interceptor';
import { StatsRestaurantScopeGuard } from '../guards/restaurant-scope.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { DashboardViewModel, GetStatsQueryDto } from '../dto/dashboard.dto';
import { StatisticsService } from '../services/statistics.service';

/**
 * Controller principal du dashboard synthétique.
 * Agrège toutes les métriques clés en un seul appel pour la page d'accueil.
 * Les rapports détaillés sont dans les controllers dédiés :
 *   - /statistics/products/*
 *   - /statistics/orders/*
 *   - /statistics/clients/*
 *   - /statistics/delivery/*
 *   - /statistics/marketing/*
 */
@Controller('statistics')
@UseInterceptors(UserScopedCacheInterceptor)
export class StatisticsDashboardController {
  constructor(private readonly statisticsService: StatisticsService) {}

  /**
   * GET /statistics/dashboard
   * Vue synthétique complète : KPIs, revenus, commandes hebdo, meilleurs menus,
   * ventes journalières, frais de livraison.
   * Filtres : restaurantId, startDate, endDate, period
   */
  @Get('dashboard')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, StatsRestaurantScopeGuard)
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getDashboardStats(@Query() query: GetStatsQueryDto): Promise<DashboardViewModel> {
    return this.statisticsService.getDashboardStats(query);
  }
}
