import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { StatisticsProductsService } from '../services/statistics-products.service';
import {
  ProductsStatsQueryDto,
  ProductsComparisonQueryDto,
} from '../dto/products-stats.dto';

@Controller('statistics/products')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
@UseInterceptors(CacheInterceptor)
export class StatisticsProductsController {
  constructor(private readonly productsService: StatisticsProductsService) {}

  /**
   * GET /statistics/products/top
   * Top produits par volume de vente sur la période.
   * Filtres : restaurantId, startDate, endDate, period, categoryId, limit
   */
  @Get('top')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getTopProducts(@Query() query: ProductsStatsQueryDto) {
    return this.productsService.getTopProducts(query);
  }

  /**
   * GET /statistics/products/top-categories
   * Top catégories par nombre de plats vendus.
   * Filtres : restaurantId, startDate, endDate, period, limit
   */
  @Get('top-categories')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getTopCategories(@Query() query: ProductsStatsQueryDto) {
    return this.productsService.getTopCategories(query);
  }

  /**
   * GET /statistics/products/comparison
   * Comparaison de performances produits entre deux périodes.
   * Filtres : restaurantId, period1Start, period1End, period2Start, period2End, limit
   */
  @Get('comparison')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getProductsComparison(@Query() query: ProductsComparisonQueryDto) {
    return this.productsService.getProductsComparison(query);
  }

  /**
   * GET /statistics/products/by-restaurant
   * Répartition des ventes par restaurant (tous les restaurants).
   * Filtres : startDate, endDate, period, limit
   */
  @Get('by-restaurant')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getProductsByRestaurant(@Query() query: ProductsStatsQueryDto) {
    return this.productsService.getProductsByRestaurant(query);
  }

  /**
   * GET /statistics/products/by-zone
   * Plats les plus commandés par zone géographique.
   * Filtres : restaurantId, startDate, endDate, period, limit
   */
  @Get('by-zone')
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getProductsByZone(@Query() query: ProductsStatsQueryDto) {
    return this.productsService.getProductsByZone(query);
  }
}
