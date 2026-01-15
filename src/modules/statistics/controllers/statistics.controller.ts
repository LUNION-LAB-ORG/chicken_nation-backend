import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { DashboardViewModel, GetStatsQueryDto } from '../dto/dashboard.dto';
import { StatisticsService } from '../services/statistics.service';

@Controller('statistics')
@UseInterceptors(CacheInterceptor)
export class StatisticsController {
  constructor(private readonly statisticsService: StatisticsService) { }

  @Get('dashboard')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  async getDashboardStats(@Query() query: GetStatsQueryDto): Promise<DashboardViewModel> {
    return this.statisticsService.getDashboardStats(query);
  }

  @Get('revenue')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  async getRevenueStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return { revenue: dashboard.revenue, revenueCard: dashboard.stats.revenue };
  }

  @Get('orders')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  async getOrdersStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return { weeklyOrders: dashboard.weeklyOrders, ordersCard: dashboard.stats.totalOrders };
  }

  @Get('menus')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MENUS, Action.READ)
  async getMenusStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return { bestSellingMenus: dashboard.bestSellingMenus, menusSoldCard: dashboard.stats.menusSold };
  }

  @Get('customers')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  async getCustomersStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return { customersCard: dashboard.stats.totalCustomers };
  }

  @Get('daily-sales')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  async getDailySales(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return dashboard.dailySales;
  }
}
