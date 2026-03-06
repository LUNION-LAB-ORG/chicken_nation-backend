import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { StatisticsOrdersService } from '../services/statistics-orders.service';
import { OrdersStatsQueryDto } from '../dto/orders-stats.dto';

@Controller('statistics/orders')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
@UseInterceptors(CacheInterceptor)
export class StatisticsOrdersController {
  constructor(private readonly ordersService: StatisticsOrdersService) {}

  /**
   * GET /statistics/orders/overview
   * Vue d'ensemble : total commandes, CA, panier moyen, tendance vs période précédente.
   * Filtres : restaurantId, startDate, endDate, period, type (DELIVERY|PICKUP|TABLE), channel (app|call)
   */
  @Get('overview')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getOrdersOverview(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getOrdersOverview(query);
  }

  /**
   * GET /statistics/orders/by-channel
   * Commandes App vs Call Center avec répartition des nouveaux / récurrents.
   * Filtres : restaurantId, startDate, endDate, period
   */
  @Get('by-channel')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getOrdersByChannel(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getOrdersByChannel(query);
  }

  /**
   * GET /statistics/orders/processing-time
   * Temps de traitement moyen/min/max : création → acceptation → prêt → livraison.
   * Filtres : restaurantId, startDate, endDate, period, type
   */
  @Get('processing-time')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getOrdersProcessingTime(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getOrdersProcessingTime(query);
  }

  /**
   * GET /statistics/orders/late
   * Commandes en retard vs dans les délais, taux de ponctualité.
   * Filtres : restaurantId, startDate, endDate, period
   */
  @Get('late')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getLateOrders(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getLateOrders(query);
  }

  /**
   * GET /statistics/orders/by-restaurant
   * Volume et CA par restaurant.
   * Filtres : startDate, endDate, period, limit
   */
  @Get('by-restaurant')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getOrdersByRestaurant(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getOrdersByRestaurant(query);
  }

  /**
   * GET /statistics/orders/restaurant-punctuality
   * Ponctualité restaurant : temps de préparation (accepted_at → ready_at) par restaurant.
   */
  @Get('restaurant-punctuality')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getRestaurantPunctuality(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getRestaurantPunctuality(query);
  }

  /**
   * GET /statistics/orders/by-restaurant-and-type
   * Répartition par restaurant et par type de commande (histogrammes empilés).
   */
  @Get('by-restaurant-and-type')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getOrdersByRestaurantAndType(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getOrdersByRestaurantAndType(query);
  }

  /**
   * GET /statistics/orders/by-restaurant-and-source
   * Répartition par restaurant et par source (App / Call Center).
   */
  @Get('by-restaurant-and-source')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getOrdersByRestaurantAndSource(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getOrdersByRestaurantAndSource(query);
  }

  /**
   * GET /statistics/orders/client-zones
   * Zones clients : coordonnées des adresses de livraison pour heat map.
   */
  @Get('client-zones')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getClientZones(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getClientZones(query);
  }

  /**
   * GET /statistics/orders/daily-trend
   * Tendance journalière / hebdomadaire / mensuelle des commandes.
   * Filtres : restaurantId, startDate, endDate, period, granularity (day|week|month)
   */
  @Get('daily-trend')
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getOrdersDailyTrend(@Query() query: OrdersStatsQueryDto) {
    return this.ordersService.getOrdersDailyTrend(query);
  }
}
