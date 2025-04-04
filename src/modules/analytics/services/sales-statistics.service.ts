import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { SalesStatistic, StatisticPeriod } from '../entities/sales-statistic.entity';
import { GetStatisticsDto } from '../dto/get-statistics.dto';
import { addDays, addMonths, addWeeks, addYears, endOfDay, endOfMonth, endOfWeek, endOfYear, startOfDay, startOfMonth, startOfWeek, startOfYear } from 'date-fns';

@Injectable()
export class SalesStatisticsService {
  constructor(
    @InjectRepository(SalesStatistic)
    private salesStatisticsRepository: Repository<SalesStatistic>,
  ) {}

  async getStatistics(dto: GetStatisticsDto): Promise<SalesStatistic[]> {
    const { periodType, startDate, endDate, restaurantId, categoryId, productId } = dto;
    
    const query = this.salesStatisticsRepository.createQueryBuilder('stat')
      .where('stat.periodType = :periodType', { periodType })
      .andWhere('stat.periodStart >= :startDate', { startDate: new Date(startDate) })
      .andWhere('stat.periodEnd <= :endDate', { endDate: new Date(endDate) });
    
    if (restaurantId) {
      query.andWhere('stat.restaurantId = :restaurantId', { restaurantId });
    }
    
    if (categoryId) {
      query.andWhere('stat.categoryId = :categoryId', { categoryId });
    }
    
    if (productId) {
      query.andWhere('stat.productId = :productId', { productId });
    }
    
    return query.orderBy('stat.periodStart', 'ASC').getMany();
  }

  async generateDailyStatistics(date: Date): Promise<SalesStatistic> {
    // This would typically be called by a scheduled job
    const start = startOfDay(date);
    const end = endOfDay(date);
    
    // Here you would query the orders table to get actual sales data
    // This is a simplified example
    const statistic = new SalesStatistic();
    statistic.periodType = StatisticPeriod.DAILY;
    statistic.periodStart = start;
    statistic.periodEnd = end;
    
    // These values would be calculated from actual order data
    statistic.totalOrders = 0;
    statistic.totalSales = 0;
    statistic.averageOrderValue = 0;
    statistic.totalCustomers = 0;
    statistic.newCustomers = 0;
    statistic.returningCustomers = 0;
    
    return this.salesStatisticsRepository.save(statistic);
  }

  async generateWeeklyStatistics(date: Date): Promise<SalesStatistic> {
    const start = startOfWeek(date, { weekStartsOn: 1 }); // Week starts on Monday
    const end = endOfWeek(date, { weekStartsOn: 1 });
    
    // Aggregate daily statistics for the week
    const dailyStats = await this.salesStatisticsRepository.find({
      where: {
        periodType: StatisticPeriod.DAILY,
        periodStart: MoreThanOrEqual(start),
        periodEnd: LessThanOrEqual(end),
      },
    });
    
    const statistic = new SalesStatistic();
    statistic.periodType = StatisticPeriod.WEEKLY;
    statistic.periodStart = start;
    statistic.periodEnd = end;
    
    // Aggregate values from daily statistics
    statistic.totalOrders = dailyStats.reduce((sum, stat) => sum + stat.totalOrders, 0);
    statistic.totalSales = dailyStats.reduce((sum, stat) => sum + Number(stat.totalSales), 0);
    statistic.averageOrderValue = statistic.totalOrders > 0 ? statistic.totalSales / statistic.totalOrders : 0;
    statistic.totalCustomers = dailyStats.reduce((sum, stat) => sum + stat.totalCustomers, 0);
    statistic.newCustomers = dailyStats.reduce((sum, stat) => sum + stat.newCustomers, 0);
    statistic.returningCustomers = dailyStats.reduce((sum, stat) => sum + stat.returningCustomers, 0);
    
    return this.salesStatisticsRepository.save(statistic);
  }

  async generateMonthlyStatistics(date: Date): Promise<SalesStatistic> {
    const start = startOfMonth(date);
    const end = endOfMonth(date);
    
    // Aggregate weekly statistics for the month
    const weeklyStats = await this.salesStatisticsRepository.find({
      where: {
        periodType: StatisticPeriod.WEEKLY,
        periodStart: MoreThanOrEqual(start),
        periodEnd: LessThanOrEqual(end),
      },
    });
    
    const statistic = new SalesStatistic();
    statistic.periodType = StatisticPeriod.MONTHLY;
    statistic.periodStart = start;
    statistic.periodEnd = end;
    
    // Aggregate values from weekly statistics
    statistic.totalOrders = weeklyStats.reduce((sum, stat) => sum + stat.totalOrders, 0);
    statistic.totalSales = weeklyStats.reduce((sum, stat) => sum + Number(stat.totalSales), 0);
    statistic.averageOrderValue = statistic.totalOrders > 0 ? statistic.totalSales / statistic.totalOrders : 0;
    statistic.totalCustomers = weeklyStats.reduce((sum, stat) => sum + stat.totalCustomers, 0);
    statistic.newCustomers = weeklyStats.reduce((sum, stat) => sum + stat.newCustomers, 0);
    statistic.returningCustomers = weeklyStats.reduce((sum, stat) => sum + stat.returningCustomers, 0);
    
    return this.salesStatisticsRepository.save(statistic);
  }

  async generateYearlyStatistics(date: Date): Promise<SalesStatistic> {
    const start = startOfYear(date);
    const end = endOfYear(date);
    
    // Aggregate monthly statistics for the year
    const monthlyStats = await this.salesStatisticsRepository.find({
      where: {
        periodType: StatisticPeriod.MONTHLY,
        periodStart: MoreThanOrEqual(start),
        periodEnd: LessThanOrEqual(end),
      },
    });
    
    const statistic = new SalesStatistic();
    statistic.periodType = StatisticPeriod.YEARLY;
    statistic.periodStart = start;
    statistic.periodEnd = end;
    
    // Aggregate values from monthly statistics
    statistic.totalOrders = monthlyStats.reduce((sum, stat) => sum + stat.totalOrders, 0);
    statistic.totalSales = monthlyStats.reduce((sum, stat) => sum + Number(stat.totalSales), 0);
    statistic.averageOrderValue = statistic.totalOrders > 0 ? statistic.totalSales / statistic.totalOrders : 0;
    statistic.totalCustomers = monthlyStats.reduce((sum, stat) => sum + stat.totalCustomers, 0);
    statistic.newCustomers = monthlyStats.reduce((sum, stat) => sum + stat.newCustomers, 0);
    statistic.returningCustomers = monthlyStats.reduce((sum, stat) => sum + stat.returningCustomers, 0);
    
    return this.salesStatisticsRepository.save(statistic);
  }

  async getTopProducts(startDate: Date, endDate: Date, limit = 10): Promise<any[]> {
    // This would query the order_items table to get the most sold products
    // Simplified example - in a real implementation, you would join with orders and products tables
    return [];
  }

  async getTopRestaurants(startDate: Date, endDate: Date, limit = 10): Promise<any[]> {
    // This would query the orders table to get the restaurants with the most sales
    // Simplified example - in a real implementation, you would join with restaurants table
    return [];
  }

  async getRevenueByTimeOfDay(startDate: Date, endDate: Date): Promise<any[]> {
    // This would query the orders table to get sales grouped by hour of day
    // Simplified example
    return [];
  }

  async getRevenueByDayOfWeek(startDate: Date, endDate: Date): Promise<any[]> {
    // This would query the orders table to get sales grouped by day of week
    // Simplified example
    return [];
  }
}
