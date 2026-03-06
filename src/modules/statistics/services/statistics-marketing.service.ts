import { Injectable } from '@nestjs/common';
import { OrderStatus, OrderType, PromotionStatus, Prisma } from '@prisma/client';
import { differenceInDays, format, subDays } from 'date-fns';
import { fr } from 'date-fns/locale';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  parseDateRange,
  buildRestaurantFilter,
  formatCurrency,
  buildDateFilter,
} from '../helpers/statistics.helper';
import {
  PromoUsageQueryDto,
  ChurnExportQueryDto,
  TopZonesQueryDto,
  PromoUsageItem,
  PromoUsageResponse,
  TopZoneItem,
  TopZonesResponse,
  ChurnExportItem,
  ChurnExportResponse,
  PromotionPerformanceItem,
  PromotionsPerformanceResponse,
} from '../dto/marketing-stats.dto';

@Injectable()
export class StatisticsMarketingService {
  constructor(private readonly prisma: PrismaService) {}

  async getPromoUsage(query: PromoUsageQueryDto): Promise<PromoUsageResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const usageWhere: Prisma.PromotionUsageWhereInput = {
      created_at: buildDateFilter(dateRange),
      order: {
        ...restaurantFilter,
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      },
    };

    if (query.promotionId) {
      usageWhere.promotion_id = query.promotionId;
    }

    if (query.promoCode) {
      usageWhere.promotion = { title: { contains: query.promoCode, mode: 'insensitive' } };
    }

    const usages = await this.prisma.promotionUsage.findMany({
      where: usageWhere,
      include: {
        promotion: {
          select: {
            id: true, title: true, discount_type: true, discount_value: true,
          },
        },
      },
    });

    const promoMap = new Map<string, {
      id: string; title: string; discountType: string; discountValue: number;
      usageCount: number; totalDiscount: number; revenueGenerated: number;
      customerIds: Set<string>;
    }>();

    for (const usage of usages) {
      const promo = usage.promotion;
      if (!promo) continue;

      const existing = promoMap.get(promo.id);
      if (existing) {
        existing.usageCount++;
        existing.totalDiscount += usage.discount_amount;
        existing.revenueGenerated += usage.final_amount;
        if (usage.customer_id) existing.customerIds.add(usage.customer_id);
      } else {
        promoMap.set(promo.id, {
          id: promo.id,
          title: promo.title,
          discountType: promo.discount_type,
          discountValue: promo.discount_value,
          usageCount: 1,
          totalDiscount: usage.discount_amount,
          revenueGenerated: usage.final_amount,
          customerIds: new Set(usage.customer_id ? [usage.customer_id] : []),
        });
      }
    }

    const items: PromoUsageItem[] = Array.from(promoMap.values())
      .sort((a, b) => b.usageCount - a.usageCount)
      .map((p) => ({
        id: p.id,
        title: p.title,
        discountType: p.discountType,
        discountValue: p.discountValue,
        usageCount: p.usageCount,
        totalDiscount: p.totalDiscount,
        totalDiscountFormatted: formatCurrency(p.totalDiscount),
        revenueGenerated: p.revenueGenerated,
        revenueGeneratedFormatted: formatCurrency(p.revenueGenerated),
        uniqueUsers: p.customerIds.size,
      }));

    const totalDiscountAccorded = items.reduce((acc, i) => acc + i.totalDiscount, 0);
    const totalRevenueWithPromo = items.reduce((acc, i) => acc + i.revenueGenerated, 0);

    return { items, totalPromos: items.length, totalDiscountAccorded, totalRevenueWithPromo };
  }

  async getPromotionsPerformance(
    query: PromoUsageQueryDto,
  ): Promise<PromotionsPerformanceResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const promotions = await this.prisma.promotion.findMany({
      where: {
        restaurantPromotions: query.restaurantId
          ? { some: { restaurant_id: query.restaurantId } }
          : undefined,
      },
      include: {
        promotion_usages: {
          where: {
            created_at: buildDateFilter(dateRange),
            order: {
              ...restaurantFilter,
              paied: true,
              status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
            },
          },
        },
      },
      orderBy: { current_usage: 'desc' },
    });

    const items: PromotionPerformanceItem[] = promotions.map((p) => {
      const revenueGenerated = p.promotion_usages.reduce(
        (acc, u) => acc + u.final_amount,
        0,
      );
      const usageRate =
        p.max_total_usage && p.max_total_usage > 0
          ? Math.round((p.current_usage / p.max_total_usage) * 100)
          : 0;

      return {
        id: p.id,
        title: p.title,
        status: p.status,
        usageCount: p.promotion_usages.length,
        maxUsage: p.max_total_usage ?? 0,
        usageRate,
        revenueGenerated,
        revenueGeneratedFormatted: formatCurrency(revenueGenerated),
        startDate: p.start_date
          ? format(new Date(p.start_date), 'dd/MM/yyyy', { locale: fr })
          : '',
        expirationDate: p.expiration_date
          ? format(new Date(p.expiration_date), 'dd/MM/yyyy', { locale: fr })
          : '',
      };
    });

    const activePromos = items.filter(
      (i) => i.status === PromotionStatus.ACTIVE,
    ).length;
    const totalRevenueWithPromo = items.reduce((acc, i) => acc + i.revenueGenerated, 0);

    return { items, totalActivePromos: activePromos, totalRevenueWithPromo };
  }

  async getTopZones(query: TopZonesQueryDto): Promise<TopZonesResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const limit = query.limit ?? 5;

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
      { count: number; revenue: number; lats: number[]; lngs: number[] }
    >();

    for (const order of orders) {
      const addr = order.address as any;
      const zone = addr?.city ?? addr?.address ?? 'Zone inconnue';
      const lat = parseFloat(addr?.latitude);
      const lng = parseFloat(addr?.longitude);

      const existing = zoneMap.get(zone);
      if (existing) {
        existing.count++;
        existing.revenue += order.net_amount ?? 0;
        if (!isNaN(lat)) existing.lats.push(lat);
        if (!isNaN(lng)) existing.lngs.push(lng);
      } else {
        zoneMap.set(zone, {
          count: 1, revenue: order.net_amount ?? 0,
          lats: !isNaN(lat) ? [lat] : [],
          lngs: !isNaN(lng) ? [lng] : [],
        });
      }
    }

    const totalOrders = orders.length;
    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined;

    const items: TopZoneItem[] = Array.from(zoneMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([zone, data]) => ({
        zone,
        orderCount: data.count,
        revenue: data.revenue,
        revenueFormatted: formatCurrency(data.revenue),
        percentage:
          totalOrders > 0 ? Math.round((data.count / totalOrders) * 100) : 0,
        latitude: avg(data.lats),
        longitude: avg(data.lngs),
      }));

    return { items, totalOrders };
  }

  async getChurnExport(query: ChurnExportQueryDto): Promise<ChurnExportResponse> {
    const inactiveDays = query.inactiveDays ?? 30;
    const limitDate = subDays(new Date(), inactiveDays);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const lastOrders = await this.prisma.order.groupBy({
      by: ['customer_id'],
      _max: { created_at: true },
      _count: { _all: true },
      _sum: { net_amount: true },
      where: {
        ...restaurantFilter,
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      },
      having: { created_at: { _max: { lt: limitDate } } },
      orderBy: { _max: { created_at: 'asc' } },
      take: 5000,
    });

    if (lastOrders.length === 0) {
      return { items: [], totalCount: 0, inactiveDays };
    }

    const customerIds = lastOrders.map((o) => o.customer_id!) as string[];

    const channelData = await this.prisma.order.groupBy({
      by: ['customer_id', 'auto'],
      _count: { _all: true },
      where: {
        customer_id: { in: customerIds },
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      },
    });
    const channelMap = new Map<string, { app: number; call: number }>();
    for (const c of channelData) {
      const id = c.customer_id!;
      if (!channelMap.has(id)) channelMap.set(id, { app: 0, call: 0 });
      const entry = channelMap.get(id)!;
      if (c.auto) entry.app += c._count._all;
      else entry.call += c._count._all;
    }

    const customers = await this.prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, first_name: true, last_name: true, phone: true, email: true },
    });
    const customerMap = new Map(customers.map((c) => [c.id, c]));

    const now = new Date();
    const items: ChurnExportItem[] = lastOrders.map((g) => {
      const customer = customerMap.get(g.customer_id!);
      const channels = channelMap.get(g.customer_id!) ?? { app: 0, call: 0 };
      const preferredChannel =
        channels.app > channels.call ? 'APP' : channels.call > channels.app ? 'CALL_CENTER' : 'MIXED';
      const maxCreatedAt = g._max?.created_at;

      return {
        phone: customer?.phone ?? '',
        firstName: customer?.first_name ?? '',
        lastName: customer?.last_name ?? '',
        email: customer?.email ?? '',
        lastOrderDate: maxCreatedAt
          ? format(new Date(maxCreatedAt), 'dd/MM/yyyy', { locale: fr })
          : '',
        daysSinceLastOrder: maxCreatedAt
          ? differenceInDays(now, new Date(maxCreatedAt))
          : 0,
        totalOrders: (g._count as { _all: number })._all,
        totalSpent: g._sum?.net_amount ?? 0,
        preferredChannel,
      };
    });

    return { items, totalCount: items.length, inactiveDays };
  }
}
