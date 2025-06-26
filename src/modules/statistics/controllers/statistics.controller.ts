import { Controller, Get, Query } from '@nestjs/common';
import { StatisticsService } from '../services/statistics.service';
import { GetStatsQueryDto, DashboardViewModel } from '../dto/dashboard.dto';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';

@Controller('statistics')
export class StatisticsController {
  constructor(private readonly statisticsService: StatisticsService) {}

  @UseGuards(JwtAuthGuard)
  @UseGuards(JwtAuthGuard)
  @Get('dashboard')
  async getDashboardStats(@Query() query: GetStatsQueryDto): Promise<DashboardViewModel> {
    return this.statisticsService.getDashboardStats(query);
  }

  @UseGuards(JwtAuthGuard)
  @Get('revenue')
  async getRevenueStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return {
      revenue: dashboard.revenue,
      revenueCard: dashboard.stats.revenue,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('orders')
  async getOrdersStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return {
      weeklyOrders: dashboard.weeklyOrders,
      ordersCard: dashboard.stats.totalOrders,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('menus')
  async getMenusStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return {
      bestSellingMenus: dashboard.bestSellingMenus,
      menusSoldCard: dashboard.stats.menusSold,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('customers')
  async getCustomersStats(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return {
      customersCard: dashboard.stats.totalCustomers,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('daily-sales')
  async getDailySales(@Query() query: GetStatsQueryDto) {
    const dashboard = await this.statisticsService.getDashboardStats(query);
    return dashboard.dailySales;
  }
}