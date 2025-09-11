import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StatisticsService } from '../services/statistics.service';
import { GetStatsQueryDto, DashboardViewModel } from '../dto/dashboard.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';

import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRole } from '@prisma/client';
import { ModulePermissionsGuard } from 'src/common/guards/user-module-permissions-guard';
import { RequirePermission } from 'src/common/decorators/user-require-permission';

@UseGuards(JwtAuthGuard, ModulePermissionsGuard)
@Controller('statistics')
export class StatisticsController {
  constructor(private readonly statisticsService: StatisticsService) {}

  @Get('dashboard')
  @RequirePermission('dashboard', 'read')
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.CAISSIER, UserRole.MARKETING)
  async getDashboardStats(@Query() query: GetStatsQueryDto): Promise<DashboardViewModel> {
    return this.statisticsService.getDashboardStats(query);
  }

  @Get('revenue')
  @RequirePermission('chiffre_affaires', 'read')
  @UserRoles(UserRole.ADMIN, UserRole.COMPTABLE)
  async getRevenueStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return { revenue: dashboard.revenue, revenueCard: dashboard.stats.revenue };
  }

  @Get('orders')
  @RequirePermission('commandes', 'read')
  @UserRoles(UserRole.ADMIN, UserRole.COMPTABLE, UserRole.CAISSIER, UserRole.CALL_CENTER)
  async getOrdersStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return { weeklyOrders: dashboard.weeklyOrders, ordersCard: dashboard.stats.totalOrders };
  }

  @Get('menus')
  @RequirePermission('plats', 'read')
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  async getMenusStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return { bestSellingMenus: dashboard.bestSellingMenus, menusSoldCard: dashboard.stats.menusSold };
  }

  @Get('customers')
  @RequirePermission('clients', 'read')
  @UserRoles(UserRole.ADMIN)
  async getCustomersStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return { customersCard: dashboard.stats.totalCustomers };
  }

  @Get('daily-sales')
  @RequirePermission('chiffre_affaires', 'read')
  @UserRoles(UserRole.ADMIN, UserRole.COMPTABLE)
  async getDailySales(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return dashboard.dailySales;
  }
}
