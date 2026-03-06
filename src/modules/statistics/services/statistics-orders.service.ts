import { Injectable } from '@nestjs/common';
import { OrderStatus, OrderType, Prisma } from '@prisma/client';
import {
  eachDayOfInterval,
  eachMonthOfInterval,
  eachWeekOfInterval,
  endOfDay,
  endOfMonth,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  endOfWeek,
  differenceInMinutes,
} from 'date-fns';
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
  OrdersStatsQueryDto,
  OrdersOverviewResponse,
  OrdersByChannelResponse,
  ChannelStats,
  DailyTrendPoint,
  ProcessingTimeResponse,
  LateOrdersResponse,
  RestaurantPunctualityResponse,
  OrdersByRestaurantResponse,
  OrdersByRestaurantAndTypeResponse,
  OrdersByRestaurantAndSourceResponse,
  OrdersDailyTrendResponse,
  ClientZonesResponse,
} from '../dto/orders-stats.dto';

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'En attente',
  ACCEPTED: 'Nouvelle commande',
  IN_PROGRESS: 'En préparation',
  READY: 'Prête',
  PICKED_UP: 'Récupérée',
  COLLECTED: 'Récoltée',
  COMPLETED: 'Livrée',
  CANCELLED: 'Annulée',
};

const TYPE_LABELS: Record<string, string> = {
  DELIVERY: 'Livraison',
  PICKUP: 'Retrait',
  TABLE: 'Sur place',
};

@Injectable()
export class StatisticsOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Vue globale commandes : total, CA, panier moyen, annulations, répartition statut/type.
   * Migré et enrichi depuis OrderService.getOrderStatistics()
   */
  async getOrdersOverview(query: OrdersStatsQueryDto): Promise<OrdersOverviewResponse> {
    const dateRange = parseDateRange(query);
    const prevPeriod = getPreviousPeriod(dateRange.startDate, dateRange.endDate);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const baseWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      created_at: buildDateFilter(dateRange),
      ...(query.type && { type: query.type }),
    };

    const paidCompletedWhere: Prisma.OrderWhereInput = {
      ...baseWhere,
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
    };

    const prevPaidCompletedWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      created_at: { gte: prevPeriod.start, lte: prevPeriod.end },
    };

    const [totalOrders, revenueAgg, prevRevenue, cancelledCount, byStatus, byType] =
      await Promise.all([
        this.prisma.order.count({ where: paidCompletedWhere }),
        this.prisma.order.aggregate({
          _sum: { net_amount: true },
          _avg: { net_amount: true },
          where: paidCompletedWhere,
        }),
        this.prisma.order.aggregate({
          _sum: { net_amount: true },
          where: prevPaidCompletedWhere,
        }),
        this.prisma.order.count({
          where: { ...baseWhere, status: OrderStatus.CANCELLED },
        }),
        this.prisma.order.groupBy({
          by: ['status'],
          _count: true,
          where: baseWhere,
        }),
        this.prisma.order.groupBy({
          by: ['type'],
          _count: true,
          _sum: { net_amount: true },
          where: paidCompletedWhere,
        }),
      ]);

    const totalRevenue = revenueAgg._sum.net_amount ?? 0;
    const prevTotalRevenue = prevRevenue._sum.net_amount ?? 0;
    const averageBasket = revenueAgg._avg.net_amount ?? 0;
    const totalAllOrders = byStatus.reduce((acc, s) => acc + s._count, 0);
    const cancellationRate =
      totalAllOrders > 0 ? Math.round((cancelledCount / totalAllOrders) * 100) : 0;

    return {
      totalOrders,
      totalRevenue,
      totalRevenueFormatted: formatCurrency(totalRevenue),
      averageBasket,
      cancelledOrders: cancelledCount,
      cancellationRate,
      evolution: calculateTrend(totalRevenue, prevTotalRevenue),
      byStatus: byStatus.map((s) => ({
        status: s.status,
        label: STATUS_LABELS[s.status] ?? s.status,
        count: s._count,
        percentage:
          totalAllOrders > 0 ? Math.round((s._count / totalAllOrders) * 100) : 0,
      })),
      byType: byType.map((t) => ({
        type: t.type,
        label: TYPE_LABELS[t.type] ?? t.type,
        count: t._count,
        revenue: t._sum.net_amount ?? 0,
        percentage:
          totalOrders > 0 ? Math.round((t._count / totalOrders) * 100) : 0,
      })),
    };
  }

  /**
   * Commandes par canal (App vs Call Center) avec courbes journalières.
   * Nouveaux clients = première commande sur la période.
   * Récurrents = avaient déjà commandé avant la période.
   */
  async getOrdersByChannel(query: OrdersStatsQueryDto): Promise<OrdersByChannelResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const baseOrderWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      created_at: buildDateFilter(dateRange),
    };

    // Toutes les commandes de la période avec info client
    const orders = await this.prisma.order.findMany({
      where: baseOrderWhere,
      select: {
        id: true,
        customer_id: true,
        auto: true,
        net_amount: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
    });

    if (orders.length === 0) {
      const empty: ChannelStats = {
        totalOrders: 0, revenue: 0, averageBasket: 0,
        newClientsOrders: 0, recurringClientsOrders: 0, newClientsRate: 0,
      };
      return { app: empty, callCenter: empty, dailyTrend: [] };
    }

    // Identifier les clients "nouveaux" : première commande >= startDate
    const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];

    const previousOrders = await this.prisma.order.groupBy({
      by: ['customer_id'],
      _count: true,
      where: {
        customer_id: { in: customerIds as string[] },
        created_at: { lt: dateRange.startDate },
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        paied: true,
      },
    });

    // Les clients qui N'apparaissent PAS dans previousOrders → nouveaux
    const recurringCustomerIds = new Set(previousOrders.map((p) => p.customer_id));
    const isNew = (customerId: string | null) =>
      customerId ? !recurringCustomerIds.has(customerId) : true;

    // Agréger par canal
    let appNew = 0, appRecurring = 0, appRevenue = 0;
    let callNew = 0, callRecurring = 0, callRevenue = 0;

    for (const order of orders) {
      const isApp = order.auto === true;
      const isNewCustomer = isNew(order.customer_id);
      const amount = order.net_amount ?? 0;

      if (isApp) {
        appRevenue += amount;
        if (isNewCustomer) appNew++;
        else appRecurring++;
      } else {
        callRevenue += amount;
        if (isNewCustomer) callNew++;
        else callRecurring++;
      }
    }

    const appTotal = appNew + appRecurring;
    const callTotal = callNew + callRecurring;

    const app: ChannelStats = {
      totalOrders: appTotal,
      revenue: appRevenue,
      averageBasket: appTotal > 0 ? appRevenue / appTotal : 0,
      newClientsOrders: appNew,
      recurringClientsOrders: appRecurring,
      newClientsRate: appTotal > 0 ? Math.round((appNew / appTotal) * 100) : 0,
    };

    const callCenter: ChannelStats = {
      totalOrders: callTotal,
      revenue: callRevenue,
      averageBasket: callTotal > 0 ? callRevenue / callTotal : 0,
      newClientsOrders: callNew,
      recurringClientsOrders: callRecurring,
      newClientsRate: callTotal > 0 ? Math.round((callNew / callTotal) * 100) : 0,
    };

    // Tendance journalière pour les Line Charts
    const days = eachDayOfInterval({ start: dateRange.startDate, end: dateRange.endDate });

    const dailyTrend: DailyTrendPoint[] = await Promise.all(
      days.map(async (day) => {
        const dayStart = startOfDay(day);
        const dayEnd = endOfDay(day);

        const dayOrders = orders.filter((o) => {
          const d = new Date(o.created_at);
          return d >= dayStart && d <= dayEnd;
        });

        let newViaApp = 0, newViaCall = 0, recurViaApp = 0, recurViaCall = 0;
        for (const o of dayOrders) {
          const isApp = o.auto === true;
          const isNewC = isNew(o.customer_id);
          if (isApp && isNewC) newViaApp++;
          else if (isApp && !isNewC) recurViaApp++;
          else if (!isApp && isNewC) newViaCall++;
          else recurViaCall++;
        }

        return {
          date: format(day, 'yyyy-MM-dd'),
          label: format(day, 'EEE dd MMM', { locale: fr }),
          newViaApp,
          newViaCallCenter: newViaCall,
          recurringViaApp: recurViaApp,
          recurringViaCallCenter: recurViaCall,
          total: dayOrders.length,
        };
      }),
    );

    return { app, callCenter, dailyTrend };
  }

  /**
   * Temps de traitement des commandes : total + par étape.
   * Temps total = accepted_at → collected_at (moment où le client reçoit sa commande)
   * Étape 1 : created_at → accepted_at (attente acceptation)
   * Étape 2 : accepted_at → ready_at (préparation restaurant)
   * Étape 3 : ready_at → collected_at (livraison/retrait)
   */
  async getOrdersProcessingTime(
    query: OrdersStatsQueryDto,
  ): Promise<ProcessingTimeResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    // On ne filtre PAS sur collected_at pour ne pas exclure les commandes
    // où collected_at n'est pas renseigné. Chaque étape filtre individuellement.
    const orders = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        paied: true,
        created_at: buildDateFilter(dateRange),
        accepted_at: { not: null },
      },
      select: {
        created_at: true,
        accepted_at: true,
        ready_at: true,
        picked_up_at: true,
        collected_at: true,
        completed_at: true,
        type: true,
      },
    });

    if (orders.length === 0) {
      return {
        averageMinutes: 0, minMinutes: 0, maxMinutes: 0,
        sampleSize: 0, byStep: [],
      };
    }

    const avg = (arr: number[]) =>
      arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    // Étape 1 : Attente acceptation (created_at → accepted_at)
    const step1Times = orders
      .filter((o) => o.accepted_at)
      .map((o) => differenceInMinutes(new Date(o.accepted_at!), new Date(o.created_at)))
      .filter((t) => t > 0);

    // Étape 2 : Préparation restaurant (accepted_at → ready_at)
    const step2Times = orders
      .filter((o) => o.accepted_at && o.ready_at)
      .map((o) =>
        differenceInMinutes(new Date(o.ready_at!), new Date(o.accepted_at!)),
      )
      .filter((t) => t > 0);

    // Étape 3 : Livraison/Retrait (ready_at → collected_at)
    // Fallback : si collected_at absent, utilise completed_at
    const step3Times = orders
      .filter((o) => o.ready_at && (o.collected_at || o.completed_at))
      .map((o) => {
        const endTime = o.collected_at ? new Date(o.collected_at) : new Date(o.completed_at!);
        return differenceInMinutes(endTime, new Date(o.ready_at!));
      })
      .filter((t) => t > 0);

    // Temps total : accepted_at → collected_at (ou completed_at en fallback)
    const totalTimes = orders
      .map((o) => {
        if (!o.accepted_at) return null;
        const endTime = o.collected_at
          ? new Date(o.collected_at)
          : o.completed_at
            ? new Date(o.completed_at)
            : null;
        if (!endTime) return null;
        return differenceInMinutes(endTime, new Date(o.accepted_at));
      })
      .filter((t): t is number => t !== null && t > 0);

    return {
      averageMinutes: avg(totalTimes),
      minMinutes: totalTimes.length > 0 ? Math.min(...totalTimes) : 0,
      maxMinutes: totalTimes.length > 0 ? Math.max(...totalTimes) : 0,
      sampleSize: orders.length,
      byStep: [
        {
          step: 'Attente acceptation',
          description: 'De la création à l\'acceptation de la commande',
          averageMinutes: avg(step1Times),
          minMinutes: step1Times.length > 0 ? Math.min(...step1Times) : 0,
          maxMinutes: step1Times.length > 0 ? Math.max(...step1Times) : 0,
        },
        {
          step: 'Préparation',
          description: 'De l\'acceptation à la mise à disposition (restaurant)',
          averageMinutes: avg(step2Times),
          minMinutes: step2Times.length > 0 ? Math.min(...step2Times) : 0,
          maxMinutes: step2Times.length > 0 ? Math.max(...step2Times) : 0,
        },
        {
          step: 'Livraison / Retrait',
          description: 'De la mise à disposition à la réception client',
          averageMinutes: avg(step3Times),
          minMinutes: step3Times.length > 0 ? Math.min(...step3Times) : 0,
          maxMinutes: step3Times.length > 0 ? Math.max(...step3Times) : 0,
        },
      ],
    };
  }

  /**
   * Ponctualité livraison : temps entre READY (ready_at) et COLLECTED (collected_at).
   * Seuil : 40 minutes max. Si durée > 40 min → en retard.
   */
  async getLateOrders(query: OrdersStatsQueryDto): Promise<LateOrdersResponse> {
    const LATE_THRESHOLD_MINUTES = 40;
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
        collected_at: { not: null },
      },
      select: {
        ready_at: true,
        collected_at: true,
      },
    });

    if (orders.length === 0) {
      return {
        totalDeliveryOrders: 0, onTimeOrders: 0, lateOrders: 0,
        lateRate: 0, averageDelayMinutes: 0, maxDelayMinutes: 0,
      };
    }

    let lateCount = 0;
    const delayTimes: number[] = [];

    for (const order of orders) {
      const readyTime = new Date(order.ready_at!);
      const collectedTime = new Date(order.collected_at!);
      const deliveryDuration = differenceInMinutes(collectedTime, readyTime);

      if (deliveryDuration > LATE_THRESHOLD_MINUTES) {
        lateCount++;
        const delay = deliveryDuration - LATE_THRESHOLD_MINUTES;
        if (delay > 0) delayTimes.push(delay);
      }
    }

    const onTimeCount = orders.length - lateCount;
    const lateRate =
      orders.length > 0 ? Math.round((lateCount / orders.length) * 100) : 0;
    const averageDelay =
      delayTimes.length > 0
        ? Math.round(delayTimes.reduce((a, b) => a + b, 0) / delayTimes.length)
        : 0;
    const maxDelay = delayTimes.length > 0 ? Math.max(...delayTimes) : 0;

    return {
      totalDeliveryOrders: orders.length,
      onTimeOrders: onTimeCount,
      lateOrders: lateCount,
      lateRate,
      averageDelayMinutes: averageDelay,
      maxDelayMinutes: maxDelay,
    };
  }

  /**
   * Ponctualité restaurant : temps entre ACCEPTED (accepted_at) et READY (ready_at).
   * Mesure l'efficacité de préparation des restaurants.
   */
  async getRestaurantPunctuality(
    query: OrdersStatsQueryDto,
  ): Promise<RestaurantPunctualityResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const orders = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        paied: true,
        created_at: buildDateFilter(dateRange),
        accepted_at: { not: null },
        ready_at: { not: null },
      },
      select: {
        restaurant_id: true,
        accepted_at: true,
        ready_at: true,
      },
    });

    if (orders.length === 0) {
      return {
        totalOrders: 0,
        averagePrepMinutes: 0,
        minPrepMinutes: 0,
        maxPrepMinutes: 0,
        byRestaurant: [],
      };
    }

    // Temps de préparation par commande
    const prepTimes = orders
      .map((o) => ({
        restaurantId: o.restaurant_id,
        minutes: differenceInMinutes(new Date(o.ready_at!), new Date(o.accepted_at!)),
      }))
      .filter((p) => p.minutes > 0);

    const allMinutes = prepTimes.map((p) => p.minutes);
    const avg = (arr: number[]) =>
      arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    // Par restaurant
    const byRestaurantMap = new Map<string, number[]>();
    for (const p of prepTimes) {
      const key = p.restaurantId ?? 'unknown';
      if (!byRestaurantMap.has(key)) byRestaurantMap.set(key, []);
      byRestaurantMap.get(key)!.push(p.minutes);
    }

    // Récupérer les noms
    const restaurantIds = [...byRestaurantMap.keys()].filter((id) => id !== 'unknown');
    const restaurants = await this.prisma.restaurant.findMany({
      where: { id: { in: restaurantIds } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(restaurants.map((r) => [r.id, r.name]));

    const byRestaurant = [...byRestaurantMap.entries()]
      .map(([id, times]) => ({
        restaurantId: id,
        restaurantName: nameMap.get(id) ?? 'Inconnu',
        totalOrders: times.length,
        averagePrepMinutes: avg(times),
        minPrepMinutes: Math.min(...times),
        maxPrepMinutes: Math.max(...times),
      }))
      .sort((a, b) => a.averagePrepMinutes - b.averagePrepMinutes);

    return {
      totalOrders: prepTimes.length,
      averagePrepMinutes: avg(allMinutes),
      minPrepMinutes: allMinutes.length > 0 ? Math.min(...allMinutes) : 0,
      maxPrepMinutes: allMinutes.length > 0 ? Math.max(...allMinutes) : 0,
      byRestaurant,
    };
  }

  /**
   * Répartition des commandes par restaurant.
   */
  async getOrdersByRestaurant(
    query: OrdersStatsQueryDto,
  ): Promise<OrdersByRestaurantResponse> {
    const dateRange = parseDateRange(query);
    const prevPeriod = getPreviousPeriod(dateRange.startDate, dateRange.endDate);

    const baseWhere: Prisma.OrderWhereInput = {
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      created_at: buildDateFilter(dateRange),
    };

    const [grouped, prevGrouped, restaurants] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['restaurant_id'],
        _count: true,
        _sum: { net_amount: true },
        _avg: { net_amount: true },
        where: baseWhere,
      }),
      this.prisma.order.groupBy({
        by: ['restaurant_id'],
        _sum: { net_amount: true },
        where: {
          ...baseWhere,
          created_at: { gte: prevPeriod.start, lte: prevPeriod.end },
        },
      }),
      this.prisma.restaurant.findMany({
        select: { id: true, name: true, image: true },
      }),
    ]);

    const prevMap = new Map(
      prevGrouped.map((p) => [p.restaurant_id, p._sum.net_amount ?? 0]),
    );
    const restaurantMap = new Map(restaurants.map((r) => [r.id, r]));

    const totalOrders = grouped.reduce((acc, g) => acc + g._count, 0);
    const totalRevenue = grouped.reduce((acc, g) => acc + (g._sum.net_amount ?? 0), 0);

    const items = grouped
      .sort((a, b) => (b._sum.net_amount ?? 0) - (a._sum.net_amount ?? 0))
      .map((g) => {
        const rest = restaurantMap.get(g.restaurant_id ?? '');
        const revenue = g._sum.net_amount ?? 0;
        const prevRevenue = prevMap.get(g.restaurant_id) ?? 0;
        return {
          restaurantId: g.restaurant_id ?? '',
          restaurantName: rest?.name ?? 'Restaurant inconnu',
          restaurantImage: rest?.image ?? '',
          totalOrders: g._count,
          revenue,
          revenueFormatted: formatCurrency(revenue),
          averageBasket: Math.round(g._avg.net_amount ?? 0),
          percentage: totalOrders > 0 ? Math.round((g._count / totalOrders) * 100) : 0,
          evolution: calculateTrend(revenue, prevRevenue),
        };
      });

    return { items, totalOrders, totalRevenue };
  }

  /**
   * Répartition par restaurant ET par type de commande (pour histogrammes empilés).
   */
  async getOrdersByRestaurantAndType(
    query: OrdersStatsQueryDto,
  ): Promise<OrdersByRestaurantAndTypeResponse> {
    const dateRange = parseDateRange(query);

    const baseWhere: Prisma.OrderWhereInput = {
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      created_at: buildDateFilter(dateRange),
    };

    const [grouped, restaurants] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['restaurant_id', 'type'],
        _count: true,
        where: baseWhere,
      }),
      this.prisma.restaurant.findMany({
        select: { id: true, name: true },
      }),
    ]);

    const restaurantMap = new Map(restaurants.map((r) => [r.id, r.name]));

    // Agréger : { restaurantId → { DELIVERY: n, PICKUP: n, TABLE: n, total: n } }
    const dataMap = new Map<
      string,
      { name: string; DELIVERY: number; PICKUP: number; TABLE: number; total: number }
    >();

    for (const g of grouped) {
      const id = g.restaurant_id ?? 'unknown';
      if (!dataMap.has(id)) {
        dataMap.set(id, {
          name: restaurantMap.get(id) ?? 'Inconnu',
          DELIVERY: 0,
          PICKUP: 0,
          TABLE: 0,
          total: 0,
        });
      }
      const entry = dataMap.get(id)!;
      const typeKey = g.type as 'DELIVERY' | 'PICKUP' | 'TABLE';
      if (typeKey in entry) {
        entry[typeKey] += g._count;
      }
      entry.total += g._count;
    }

    const items = [...dataMap.entries()]
      .map(([id, data]) => ({
        restaurantId: id,
        restaurantName: data.name,
        delivery: data.DELIVERY,
        pickup: data.PICKUP,
        table: data.TABLE,
        total: data.total,
      }))
      .sort((a, b) => b.total - a.total);

    return { items };
  }

  /**
   * Répartition par restaurant ET par source (App vs Call Center).
   * Pour histogrammes empilés par canal.
   */
  async getOrdersByRestaurantAndSource(
    query: OrdersStatsQueryDto,
  ): Promise<OrdersByRestaurantAndSourceResponse> {
    const dateRange = parseDateRange(query);

    const baseWhere: Prisma.OrderWhereInput = {
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      created_at: buildDateFilter(dateRange),
    };

    const [grouped, restaurants] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['restaurant_id', 'auto'],
        _count: true,
        where: baseWhere,
      }),
      this.prisma.restaurant.findMany({
        select: { id: true, name: true },
      }),
    ]);

    const restaurantMap = new Map(restaurants.map((r) => [r.id, r.name]));

    // Agréger : { restaurantId → { app: n, callCenter: n, total: n } }
    const dataMap = new Map<
      string,
      { name: string; app: number; callCenter: number; total: number }
    >();

    for (const g of grouped) {
      const id = g.restaurant_id ?? 'unknown';
      if (!dataMap.has(id)) {
        dataMap.set(id, {
          name: restaurantMap.get(id) ?? 'Inconnu',
          app: 0,
          callCenter: 0,
          total: 0,
        });
      }
      const entry = dataMap.get(id)!;
      if (g.auto === true) {
        entry.app += g._count;
      } else {
        entry.callCenter += g._count;
      }
      entry.total += g._count;
    }

    const items = [...dataMap.entries()]
      .map(([id, data]) => ({
        restaurantId: id,
        restaurantName: data.name,
        app: data.app,
        callCenter: data.callCenter,
        total: data.total,
      }))
      .sort((a, b) => b.total - a.total);

    return { items };
  }

  /**
   * Zones clients : extrait les coordonnées des adresses de livraison des commandes.
   * Retourne un tableau de points (lat, lng, count) pour la heat map.
   */
  async getClientZones(query: OrdersStatsQueryDto): Promise<ClientZonesResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const orders = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        created_at: buildDateFilter(dateRange),
        type: OrderType.DELIVERY,
        address: { not: Prisma.JsonNull },
      },
      select: {
        address: true,
      },
    });

    // Extraire les coordonnées du champ JSON address
    // Le champ address peut être un objet JSON ou une chaîne JSON stringifiée
    // Format: { title, address, street?, city?, longitude, latitude, note }
    const coordCounts = new Map<string, { lat: number; lng: number; count: number }>();

    for (const order of orders) {
      let addr: { latitude?: number; longitude?: number; city?: string } | null = null;
      try {
        const raw = order.address;
        if (typeof raw === 'string') {
          addr = JSON.parse(raw);
        } else if (raw && typeof raw === 'object') {
          addr = raw as { latitude?: number; longitude?: number; city?: string };
        }
      } catch {
        continue; // JSON invalide, on skip
      }
      if (!addr || !addr.latitude || !addr.longitude) continue;

      // Arrondir à 3 décimales pour regrouper les points proches (~111m)
      const lat = Math.round(addr.latitude * 1000) / 1000;
      const lng = Math.round(addr.longitude * 1000) / 1000;
      const key = `${lat},${lng}`;

      if (coordCounts.has(key)) {
        coordCounts.get(key)!.count++;
      } else {
        coordCounts.set(key, { lat, lng, count: 1 });
      }
    }

    const points = [...coordCounts.values()].sort((a, b) => b.count - a.count);
    const totalOrders = orders.length;
    const totalPoints = points.length;

    // Calculer le centre moyen pour centrer la carte
    let centerLat = 6.3703; // Cotonou par défaut
    let centerLng = 2.3912;
    if (points.length > 0) {
      centerLat = points.reduce((acc, p) => acc + p.lat * p.count, 0) /
        points.reduce((acc, p) => acc + p.count, 0);
      centerLng = points.reduce((acc, p) => acc + p.lng * p.count, 0) /
        points.reduce((acc, p) => acc + p.count, 0);
    }

    return {
      points,
      totalOrders,
      totalPoints,
      center: { lat: centerLat, lng: centerLng },
    };
  }

  /**
   * Tendance journalière des commandes (pour le reporting quotidien de Ben).
   */
  async getOrdersDailyTrend(
    query: OrdersStatsQueryDto,
  ): Promise<OrdersDailyTrendResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const granularity = query.granularity ?? 'day';

    const baseWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      created_at: buildDateFilter(dateRange),
    };

    const allOrders = await this.prisma.order.findMany({
      where: baseWhere,
      select: { created_at: true, net_amount: true },
      orderBy: { created_at: 'asc' },
    });

    let intervals: Date[];
    let getIntervalStart: (d: Date) => Date;
    let getIntervalEnd: (d: Date) => Date;
    let labelFormat: string;

    if (granularity === 'month') {
      intervals = eachMonthOfInterval({ start: dateRange.startDate, end: dateRange.endDate });
      getIntervalStart = startOfMonth;
      getIntervalEnd = endOfMonth;
      labelFormat = 'MMM yyyy';
    } else if (granularity === 'week') {
      intervals = eachWeekOfInterval(
        { start: dateRange.startDate, end: dateRange.endDate },
        { weekStartsOn: 1 },
      );
      getIntervalStart = (d) => startOfWeek(d, { weekStartsOn: 1 });
      getIntervalEnd = (d) => endOfWeek(d, { weekStartsOn: 1 });
      labelFormat = "'Sem.' w";
    } else {
      intervals = eachDayOfInterval({ start: dateRange.startDate, end: dateRange.endDate });
      getIntervalStart = startOfDay;
      getIntervalEnd = endOfDay;
      labelFormat = 'EEE dd MMM';
    }

    const data = intervals.map((interval) => {
      const iStart = getIntervalStart(interval);
      const iEnd = getIntervalEnd(interval);

      const periodOrders = allOrders.filter((o) => {
        const d = new Date(o.created_at);
        return d >= iStart && d <= iEnd;
      });

      const count = periodOrders.length;
      const revenue = periodOrders.reduce((acc, o) => acc + (o.net_amount ?? 0), 0);

      return {
        date: format(interval, 'yyyy-MM-dd'),
        label: format(interval, labelFormat, { locale: fr }),
        count,
        revenue,
        averageBasket: count > 0 ? Math.round(revenue / count) : 0,
      };
    });

    return {
      data,
      totalOrders: allOrders.length,
      totalRevenue: allOrders.reduce((acc, o) => acc + (o.net_amount ?? 0), 0),
    };
  }
}
