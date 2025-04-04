import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SalesStatisticsService } from '../services/sales-statistics.service';
import { GetStatisticsDto } from '../dto/get-statistics.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../auth/enums/user-role.enum';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';

@ApiTags('analytics/sales-statistics')
@Controller('analytics/sales-statistics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth()
export class SalesStatisticsController {
  constructor(private readonly salesStatisticsService: SalesStatisticsService) {}

  @Get()
  @ApiOperation({ summary: 'Get sales statistics (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns sales statistics.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  async getStatistics(@Query() dto: GetStatisticsDto) {
    return this.salesStatisticsService.getStatistics(dto);
  }

  @Get('top-products')
  @ApiOperation({ summary: 'Get top selling products (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns top selling products.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiQuery({ name: 'startDate', required: true, type: Date })
  @ApiQuery({ name: 'endDate', required: true, type: Date })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getTopProducts(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit?: number,
  ) {
    return this.salesStatisticsService.getTopProducts(
      new Date(startDate),
      new Date(endDate),
      limit ? parseInt(limit.toString(), 10) : 10,
    );
  }

  @Get('top-restaurants')
  @ApiOperation({ summary: 'Get top performing restaurants (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns top performing restaurants.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiQuery({ name: 'startDate', required: true, type: Date })
  @ApiQuery({ name: 'endDate', required: true, type: Date })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getTopRestaurants(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit?: number,
  ) {
    return this.salesStatisticsService.getTopRestaurants(
      new Date(startDate),
      new Date(endDate),
      limit ? parseInt(limit.toString(), 10) : 10,
    );
  }

  @Get('revenue-by-time-of-day')
  @ApiOperation({ summary: 'Get revenue by time of day (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns revenue by time of day.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiQuery({ name: 'startDate', required: true, type: Date })
  @ApiQuery({ name: 'endDate', required: true, type: Date })
  async getRevenueByTimeOfDay(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.salesStatisticsService.getRevenueByTimeOfDay(
      new Date(startDate),
      new Date(endDate),
    );
  }

  @Get('revenue-by-day-of-week')
  @ApiOperation({ summary: 'Get revenue by day of week (admin only)' })
  @ApiResponse({ status: 200, description: 'Returns revenue by day of week.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiQuery({ name: 'startDate', required: true, type: Date })
  @ApiQuery({ name: 'endDate', required: true, type: Date })
  async getRevenueByDayOfWeek(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.salesStatisticsService.getRevenueByDayOfWeek(
      new Date(startDate),
      new Date(endDate),
    );
  }
}
