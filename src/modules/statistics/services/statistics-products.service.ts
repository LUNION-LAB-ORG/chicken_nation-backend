import { Injectable } from '@nestjs/common';
import { EntityStatus, OrderStatus, Prisma } from '@prisma/client';
import { format, parseISO, startOfDay, endOfDay } from 'date-fns';
import { fr } from 'date-fns/locale';
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
  ProductsStatsQueryDto,
  ProductsComparisonQueryDto,
  TopProductItem,
  TopProductsResponse,
  TopCategoryItem,
  TopCategoriesResponse,
  ProductComparisonItem,
  ProductComparisonResponse,
  ProductsByRestaurantResponse,
  ProductsByZoneResponse,
  TopProductByZoneItem,
} from '../dto/products-stats.dto';

@Injectable()
export class StatisticsProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Top produits vendus sur la période avec évolution vs période précédente.
   * Migré et enrichi depuis DishService.findPopular() + StatisticsService.getBestSellingMenus()
   */
  async getTopProducts(query: ProductsStatsQueryDto): Promise<TopProductsResponse> {
    const dateRange = parseDateRange(query);
    const prevPeriod = getPreviousPeriod(dateRange.startDate, dateRange.endDate);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const limit = query.limit ?? 10;

    const baseOrderWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      paied: true,
      created_at: buildDateFilter(dateRange),
    };

    const prevOrderWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      paied: true,
      created_at: { gte: prevPeriod.start, lte: prevPeriod.end },
    };

    // Catégorie optionnelle
    const categoryFilter = query.categoryId
      ? { dish: { category_id: query.categoryId } }
      : {};

    // Période courante
    const topItems = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      _sum: { quantity: true },
      _count: { _all: true },
      where: { order: baseOrderWhere, ...categoryFilter },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });

    if (topItems.length === 0) {
      return { items: [], totalSold: 0, uniqueDishesCount: 0 };
    }

    const dishIds = topItems.map((i) => i.dish_id);
    const totalSoldCurrentPeriod = topItems.reduce(
      (acc, i) => acc + (i._sum.quantity ?? 0),
      0,
    );

    // Revenue par plat (période courante)
    const revenueByDish = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      _sum: { amount: true },
      where: { dish_id: { in: dishIds }, order: baseOrderWhere },
    });

    // Période précédente pour les mêmes plats
    const prevItems = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      _sum: { quantity: true },
      where: { dish_id: { in: dishIds }, order: prevOrderWhere },
    });

    const prevMap = new Map(prevItems.map((p) => [p.dish_id, p._sum.quantity ?? 0]));
    const revenueMap = new Map(
      revenueByDish.map((r) => [r.dish_id, r._sum.amount ?? 0]),
    );

    // Détails plats
    const dishes = await this.prisma.dish.findMany({
      where: { id: { in: dishIds }, entity_status: EntityStatus.ACTIVE },
      include: { category: true },
    });
    const dishMap = new Map(dishes.map((d) => [d.id, d]));

    const items: TopProductItem[] = topItems
      .map((item) => {
        const dish = dishMap.get(item.dish_id);
        if (!dish) return null;

        const totalSold = item._sum.quantity ?? 0;
        const previousPeriodSold = prevMap.get(item.dish_id) ?? 0;
        const revenue = revenueMap.get(item.dish_id) ?? 0;
        const percentage =
          totalSoldCurrentPeriod > 0
            ? Math.round((totalSold / totalSoldCurrentPeriod) * 100)
            : 0;

        return {
          id: dish.id,
          name: dish.name,
          image: dish.image ?? '',
          categoryName: dish.category?.name ?? '',
          totalSold,
          revenue,
          percentage,
          previousPeriodSold,
          evolution: calculateTrend(totalSold, previousPeriodSold),
        } as TopProductItem;
      })
      .filter((i): i is TopProductItem => i !== null);

    // Compte total de plats distincts vendus
    const uniqueDishesCount = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      where: { order: baseOrderWhere },
    }).then((r) => r.length);

    return { items, totalSold: totalSoldCurrentPeriod, uniqueDishesCount };
  }

  /**
   * Top catégories par volume de vente.
   */
  async getTopCategories(query: ProductsStatsQueryDto): Promise<TopCategoriesResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const limit = query.limit ?? 10;

    const baseOrderWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      paied: true,
      created_at: buildDateFilter(dateRange),
    };

    // Grouper par dish.category_id via jointure
    const itemsWithDish = await this.prisma.orderItem.findMany({
      where: { order: baseOrderWhere },
      include: { dish: { include: { category: true } } },
    });

    // Agréger par catégorie
    const categoryMap = new Map<string, {
      id: string; name: string; image: string;
      totalSold: number; revenue: number; dishIds: Set<string>;
    }>();

    for (const item of itemsWithDish) {
      const cat = item.dish?.category;
      if (!cat) continue;

      const existing = categoryMap.get(cat.id);
      if (existing) {
        existing.totalSold += item.quantity;
        existing.revenue += item.amount;
        existing.dishIds.add(item.dish_id);
      } else {
        categoryMap.set(cat.id, {
          id: cat.id,
          name: cat.name,
          image: cat.image ?? '',
          totalSold: item.quantity,
          revenue: item.amount,
          dishIds: new Set([item.dish_id]),
        });
      }
    }

    const totalSold = Array.from(categoryMap.values()).reduce(
      (acc, c) => acc + c.totalSold,
      0,
    );

    const items: TopCategoryItem[] = Array.from(categoryMap.values())
      .sort((a, b) => b.totalSold - a.totalSold)
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        name: c.name,
        image: c.image,
        totalSold: c.totalSold,
        revenue: c.revenue,
        percentage: totalSold > 0 ? Math.round((c.totalSold / totalSold) * 100) : 0,
        dishCount: c.dishIds.size,
      }));

    return { items, totalSold };
  }

  /**
   * Comparaison des ventes entre deux périodes sur les mêmes produits.
   * Besoin : mesurer l'impact d'une promo (+15% sur "Bucket Familial")
   */
  async getProductsComparison(
    query: ProductsComparisonQueryDto,
  ): Promise<ProductComparisonResponse> {
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const limit = query.limit ?? 10;

    const period1Start = startOfDay(parseISO(query.period1Start));
    const period1End = endOfDay(parseISO(query.period1End));
    const period2Start = startOfDay(parseISO(query.period2Start));
    const period2End = endOfDay(parseISO(query.period2End));

    const orderWhere = (start: Date, end: Date): Prisma.OrderWhereInput => ({
      ...restaurantFilter,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      paied: true,
      created_at: { gte: start, lte: end },
    });

    const catFilter = query.categoryId ? { dish: { category_id: query.categoryId } } : {};

    // Période 1
    const p1Items = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      _sum: { quantity: true },
      where: { order: orderWhere(period1Start, period1End), ...catFilter },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });

    const topDishIds = p1Items.map((i) => i.dish_id);

    // Période 2 pour les mêmes plats
    const p2Items = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      _sum: { quantity: true },
      where: {
        dish_id: { in: topDishIds },
        order: orderWhere(period2Start, period2End),
      },
    });

    const p2Map = new Map(p2Items.map((p) => [p.dish_id, p._sum.quantity ?? 0]));

    const dishes = await this.prisma.dish.findMany({
      where: { id: { in: topDishIds } },
      include: { category: true },
    });
    const dishMap = new Map(dishes.map((d) => [d.id, d]));

    const items: ProductComparisonItem[] = p1Items
      .map((item) => {
        const dish = dishMap.get(item.dish_id);
        if (!dish) return null;

        const p1Sold = item._sum.quantity ?? 0;
        const p2Sold = p2Map.get(item.dish_id) ?? 0;
        const evolutionValue = p2Sold - p1Sold;

        return {
          id: dish.id,
          name: dish.name,
          image: dish.image ?? '',
          categoryName: dish.category?.name ?? '',
          period1Sold: p1Sold,
          period2Sold: p2Sold,
          evolution: calculateTrend(p2Sold, p1Sold),
          evolutionValue,
        } as ProductComparisonItem;
      })
      .filter((i): i is ProductComparisonItem => i !== null);

    return {
      items,
      period1Label: `${format(period1Start, 'dd MMM yyyy', { locale: fr })} → ${format(period1End, 'dd MMM yyyy', { locale: fr })}`,
      period2Label: `${format(period2Start, 'dd MMM yyyy', { locale: fr })} → ${format(period2End, 'dd MMM yyyy', { locale: fr })}`,
    };
  }

  /**
   * Ventes d'un plat donné par restaurant.
   */
  async getProductsByRestaurant(
    query: ProductsStatsQueryDto & { dishId?: string },
  ): Promise<ProductsByRestaurantResponse> {
    const dateRange = parseDateRange(query);

    const baseWhere: Prisma.OrderItemWhereInput = {
      order: {
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        paied: true,
        created_at: buildDateFilter(dateRange),
      },
    };

    if (query.dishId) {
      baseWhere.dish_id = query.dishId;
    }

    const items = await this.prisma.orderItem.findMany({
      where: baseWhere,
      include: {
        order: { include: { restaurant: true } },
        dish: true,
      },
    });

    const restaurantMap = new Map<string, {
      restaurantId: string; restaurantName: string; totalSold: number; revenue: number;
    }>();

    for (const item of items) {
      const rest = item.order?.restaurant;
      if (!rest) continue;
      const existing = restaurantMap.get(rest.id);
      if (existing) {
        existing.totalSold += item.quantity;
        existing.revenue += item.amount;
      } else {
        restaurantMap.set(rest.id, {
          restaurantId: rest.id,
          restaurantName: rest.name,
          totalSold: item.quantity,
          revenue: item.amount,
        });
      }
    }

    const totalSold = Array.from(restaurantMap.values()).reduce(
      (acc, r) => acc + r.totalSold,
      0,
    );

    const byRestaurant = Array.from(restaurantMap.values())
      .sort((a, b) => b.totalSold - a.totalSold)
      .map((r) => ({
        ...r,
        percentage: totalSold > 0 ? Math.round((r.totalSold / totalSold) * 100) : 0,
      }));

    const dish = query.dishId
      ? await this.prisma.dish.findUnique({ where: { id: query.dishId } })
      : null;

    return {
      dishId: query.dishId ?? '',
      dishName: dish?.name ?? 'Tous les plats',
      byRestaurant,
    };
  }

  /**
   * Quels plats sont commandés dans quelles zones géographiques.
   * Utilise Order.address (JSON) → champ city pour la zone.
   */
  async getProductsByZone(query: ProductsStatsQueryDto): Promise<ProductsByZoneResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const limit = query.limit ?? 10;

    // Récupérer les top plats
    const topDishes = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      _sum: { quantity: true },
      where: {
        order: {
          ...restaurantFilter,
          status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
          paied: true,
          created_at: buildDateFilter(dateRange),
        },
      },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });

    if (topDishes.length === 0) return { items: [] };

    const topDishIds = topDishes.map((d) => d.dish_id);

    // Pour chaque plat, obtenir la répartition par zone (city)
    const ordersWithAddress = await this.prisma.orderItem.findMany({
      where: {
        dish_id: { in: topDishIds },
        order: {
          ...restaurantFilter,
          status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
          paied: true,
          created_at: buildDateFilter(dateRange),
          type: 'DELIVERY', // Uniquement les livraisons ont une adresse
        },
      },
      include: {
        order: { select: { address: true } },
        dish: true,
      },
    });

    // Agréger par plat → zone
    const dishZoneMap = new Map<string, {
      dishId: string; dishName: string; image: string;
      totalSold: number;
      zones: Map<string, number>;
    }>();

    for (const item of ordersWithAddress) {
      const address = item.order?.address as any;
      const zone = address?.city ?? address?.address ?? 'Zone inconnue';
      const dishId = item.dish_id;

      if (!dishZoneMap.has(dishId)) {
        dishZoneMap.set(dishId, {
          dishId,
          dishName: item.dish?.name ?? '',
          image: item.dish?.image ?? '',
          totalSold: 0,
          zones: new Map(),
        });
      }

      const entry = dishZoneMap.get(dishId)!;
      entry.totalSold += item.quantity;
      entry.zones.set(zone, (entry.zones.get(zone) ?? 0) + item.quantity);
    }

    const items: TopProductByZoneItem[] = Array.from(dishZoneMap.values()).map((d) => {
      const totalByZone = Array.from(d.zones.values()).reduce((a, b) => a + b, 0);
      return {
        dishId: d.dishId,
        dishName: d.dishName,
        image: d.image,
        totalSold: d.totalSold,
        zones: Array.from(d.zones.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([zone, count]) => ({
            zone,
            orderCount: count,
            percentage: totalByZone > 0 ? Math.round((count / totalByZone) * 100) : 0,
          })),
      };
    });

    return { items };
  }
}
