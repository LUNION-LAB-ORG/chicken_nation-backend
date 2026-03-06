import { Injectable } from '@nestjs/common';
import { DeliveryService, OrderStatus, OrderType, Prisma } from '@prisma/client';
import { differenceInMinutes } from 'date-fns';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  parseDateRange,
  getPreviousPeriod,
  calculateTrend,
  buildRestaurantFilter,
  formatCurrency,
  buildDateFilter,
} from '../helpers/statistics.helper';
import {
  DeliveryStatsQueryDto,
  DeliveryOverviewResponse,
  DeliveryFeesBreakdownResponse,
  DeliveryByZoneResponse,
  DeliveryByZoneItem,
  DeliveryPerformanceResponse,
} from '../dto/delivery-stats.dto';

@Injectable()
export class StatisticsDeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * KPIs globaux livraison : total, frais, TURBO vs FREE, évolution.
   */
  async getDeliveryOverview(
    query: DeliveryStatsQueryDto,
  ): Promise<DeliveryOverviewResponse> {
    const dateRange = parseDateRange(query);
    const prevPeriod = getPreviousPeriod(dateRange.startDate, dateRange.endDate);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const baseWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      type: OrderType.DELIVERY,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      paied: true,
      created_at: buildDateFilter(dateRange),
    };

    const [current, prev, byService] = await Promise.all([
      this.prisma.order.aggregate({
        _count: true,
        _sum: { net_amount: true, delivery_fee: true },
        _avg: { delivery_fee: true },
        where: baseWhere,
      }),
      this.prisma.order.aggregate({
        _count: true,
        _sum: { net_amount: true },
        where: {
          ...restaurantFilter,
          type: OrderType.DELIVERY,
          status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
          paied: true,
          created_at: { gte: prevPeriod.start, lte: prevPeriod.end },
        },
      }),
      this.prisma.order.groupBy({
        by: ['delivery_service'],
        _count: true,
        where: baseWhere,
      }),
    ]);

    const total = current._count ?? 0;
    const totalFees = current._sum.delivery_fee ?? 0;
    const totalRevenue = current._sum.net_amount ?? 0;
    const avgFee = current._avg.delivery_fee ?? 0;
    const prevTotal = prev._count ?? 0;

    const turboCount =
      byService.find((s) => s.delivery_service === DeliveryService.TURBO)?._count ?? 0;
    const freeCount =
      byService.find((s) => s.delivery_service === DeliveryService.FREE)?._count ?? 0;

    return {
      totalDeliveries: total,
      totalFeesCollected: totalFees,
      totalFeesFormatted: formatCurrency(totalFees),
      averageFee: Math.round(avgFee),
      totalRevenue,
      totalRevenueFormatted: formatCurrency(totalRevenue),
      turboCount,
      freeCount,
      turboPercentage: total > 0 ? Math.round((turboCount / total) * 100) : 0,
      freePercentage: total > 0 ? Math.round((freeCount / total) * 100) : 0,
      evolution: calculateTrend(total, prevTotal),
    };
  }

  /**
   * Répartition des livraisons par tranche de frais.
   * Migré depuis StatisticsService.getDeliveryStats() (anciennement dans getDashboardStats)
   */
  async getDeliveryFeesBreakdown(
    query: DeliveryStatsQueryDto,
  ): Promise<DeliveryFeesBreakdownResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const groupedStats = await this.prisma.order.groupBy({
      by: ['delivery_fee'],
      _count: { _all: true },
      _sum: { net_amount: true, delivery_fee: true },
      where: {
        ...restaurantFilter,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        paied: true,
        created_at: buildDateFilter(dateRange),
        type: OrderType.DELIVERY,
      },
    });

    const totalOrdersCount = groupedStats.reduce((acc, i) => acc + i._count._all, 0);
    const totalGlobalFees = groupedStats.reduce(
      (acc, i) => acc + (i._sum.delivery_fee ?? 0),
      0,
    );
    const totalGlobalRevenue = groupedStats.reduce(
      (acc, i) => acc + (i._sum.net_amount ?? 0),
      0,
    );

    const breakdown = groupedStats
      .map((group) => {
        const fee = group.delivery_fee ?? 0;
        const count = group._count._all;
        const revenue = group._sum.net_amount ?? 0;
        const feesCollected = group._sum.delivery_fee ?? 0;

        return {
          label: fee === 0 ? 'Gratuit' : `${fee.toLocaleString('fr-FR')} FCFA`,
          feeAmount: fee,
          orderCount: count,
          revenueGenerated: formatCurrency(revenue),
          deliveryFeesCollected: feesCollected,
          percentage:
            totalOrdersCount > 0
              ? Math.round((count / totalOrdersCount) * 100)
              : 0,
        };
      })
      .sort((a, b) => (a.feeAmount ?? 0) - (b.feeAmount ?? 0));

    return {
      totalDeliveryFees: totalGlobalFees,
      totalDeliveryRevenue: totalGlobalRevenue,
      breakdown,
    };
  }

  /**
   * Top zones de livraison par volume de commandes.
   * Utilise Order.address (JSON) → champ city.
   */
  async getDeliveryByZone(query: DeliveryStatsQueryDto): Promise<DeliveryByZoneResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const limit = query.limit ?? 10;

    const orders = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        type: OrderType.DELIVERY,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        paied: true,
        created_at: buildDateFilter(dateRange),
      },
      select: { address: true, net_amount: true },
    });

    const zoneMap = new Map<
      string,
      { count: number; revenue: number; latitudes: number[]; longitudes: number[] }
    >();

    for (const order of orders) {
      let addr: any = order.address;
      // L'adresse peut être stockée en JSON stringifié
      if (typeof addr === 'string') {
        try {
          addr = JSON.parse(addr);
        } catch {
          addr = {};
        }
      }
      const zone = addr?.city ?? addr?.address ?? 'Zone inconnue';
      const lat = parseFloat(addr?.latitude);
      const lng = parseFloat(addr?.longitude);

      const existing = zoneMap.get(zone);
      if (existing) {
        existing.count++;
        existing.revenue += order.net_amount ?? 0;
        if (!isNaN(lat)) existing.latitudes.push(lat);
        if (!isNaN(lng)) existing.longitudes.push(lng);
      } else {
        zoneMap.set(zone, {
          count: 1,
          revenue: order.net_amount ?? 0,
          latitudes: !isNaN(lat) ? [lat] : [],
          longitudes: !isNaN(lng) ? [lng] : [],
        });
      }
    }

    const totalDeliveries = orders.length;
    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined;

    const items: DeliveryByZoneItem[] = Array.from(zoneMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([zone, data]) => ({
        zone,
        orderCount: data.count,
        revenue: data.revenue,
        revenueFormatted: formatCurrency(data.revenue),
        percentage:
          totalDeliveries > 0
            ? Math.round((data.count / totalDeliveries) * 100)
            : 0,
        latitude: avg(data.latitudes),
        longitude: avg(data.longitudes),
      }));

    return { items, totalDeliveries };
  }

  /**
   * Performance de livraison : temps, retards.
   */
  /**
   * Seuil de ponctualité livraison : 40 min entre ready_at et réception client.
   */
  private static readonly LATE_THRESHOLD_MINUTES = 40;

  async getDeliveryPerformance(
    query: DeliveryStatsQueryDto,
  ): Promise<DeliveryPerformanceResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const orders = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        type: OrderType.DELIVERY,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        paied: true,
        created_at: buildDateFilter(dateRange),
        ready_at: { not: null },
      },
      select: {
        ready_at: true,
        collected_at: true,
        completed_at: true,
      },
    });

    if (orders.length === 0) {
      return {
        averageDeliveryMinutes: 0, minDeliveryMinutes: 0,
        maxDeliveryMinutes: 0, onTimeRate: 0, lateOrders: 0, onTimeOrders: 0,
        averageDelayMinutes: 0, maxDelayMinutes: 0,
      };
    }

    // Utilise collected_at (réception client) avec fallback sur completed_at
    const deliveryTimes: number[] = [];
    let lateCount = 0;

    for (const order of orders) {
      const endTime = order.collected_at ?? order.completed_at;
      if (!endTime) continue;

      const minutes = differenceInMinutes(new Date(endTime), new Date(order.ready_at!));
      if (minutes > 0) {
        deliveryTimes.push(minutes);
        if (minutes > StatisticsDeliveryService.LATE_THRESHOLD_MINUTES) {
          lateCount++;
        }
      }
    }

    const validCount = deliveryTimes.length;
    const onTimeCount = validCount - lateCount;
    const avg = (arr: number[]) =>
      arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    // Calcul du retard moyen (uniquement pour les commandes en retard)
    const lateDelays = deliveryTimes
      .filter((t) => t > StatisticsDeliveryService.LATE_THRESHOLD_MINUTES)
      .map((t) => t - StatisticsDeliveryService.LATE_THRESHOLD_MINUTES);

    return {
      averageDeliveryMinutes: avg(deliveryTimes),
      minDeliveryMinutes: deliveryTimes.length > 0 ? Math.min(...deliveryTimes) : 0,
      maxDeliveryMinutes: deliveryTimes.length > 0 ? Math.max(...deliveryTimes) : 0,
      onTimeRate:
        validCount > 0 ? Math.round((onTimeCount / validCount) * 100) : 0,
      lateOrders: lateCount,
      onTimeOrders: onTimeCount,
      averageDelayMinutes: avg(lateDelays),
      maxDelayMinutes: lateDelays.length > 0 ? Math.max(...lateDelays) : 0,
    };
  }
}
