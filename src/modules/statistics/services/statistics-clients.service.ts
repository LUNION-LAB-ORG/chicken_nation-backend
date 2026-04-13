import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import {
  differenceInDays,
  eachDayOfInterval,
  endOfDay,
  format,
  startOfDay,
  subDays,
} from 'date-fns';
import { fr } from 'date-fns/locale';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  parseDateRange,
  buildRestaurantFilter,
  formatCurrency,
  buildDateFilter,
} from '../helpers/statistics.helper';
import {
  ClientsStatsQueryDto,
  InactiveClientsQueryDto,
  ClientsOverviewResponse,
  ClientsAcquisitionResponse,
  ClientAcquisitionDailyPoint,
  ClientsRetentionResponse,
  TopClientsResponse,
  TopClientItem,
  InactiveClientsResponse,
  InactiveClientItem,
  ClientsByZoneResponse,
  ClientAnalyticsProfileResponse,
  LoyaltyDistributionResponse,
  PaymentMethodDistributionResponse,
  RevenueConcentrationResponse,
  BasketComparisonResponse,
} from '../dto/clients-stats.dto';

@Injectable()
export class StatisticsClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async getClientsOverview(query: ClientsStatsQueryDto): Promise<ClientsOverviewResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const paidWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      created_at: buildDateFilter(dateRange),
    };

    const ordersInPeriod = await this.prisma.order.findMany({
      where: paidWhere,
      select: { customer_id: true, auto: true, net_amount: true },
    });

    const customerIds = [...new Set(ordersInPeriod.map((o) => o.customer_id!))] as string[];

    // Segment counts (all customers, not just those who ordered in period)
    const allCustomers = await this.prisma.customer.findMany({
      where: { entity_status: 'ACTIVE' },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        notification_settings: { select: { expo_push_token: true } },
        _count: { select: { orders: true } },
      },
    });
    const totalAllCustomers = allCustomers.length;
    const noAppClients = allCustomers.filter(
      (c) => !c.notification_settings?.expo_push_token,
    ).length;
    const hasOrderedClients = allCustomers.filter((c) => c._count.orders > 0).length;
    const neverOrderedClients = allCustomers.filter((c) => c._count.orders === 0).length;
    const incompleteProfileClients = allCustomers.filter(
      (c) => !c.first_name || !c.last_name || !c.email,
    ).length;

    if (customerIds.length === 0) {
      return {
        totalClients: 0, newClients: 0, recurringClients: 0,
        newClientsRate: 0, averageLtv: 0, averageLtvFormatted: '0 XOF',
        averageBasket: 0, averageBasketFormatted: '0 XOF',
        averageOrderFrequency: 0, appClients: 0, callCenterClients: 0,
        totalAllCustomers, noAppClients, hasOrderedClients,
        neverOrderedClients, incompleteProfileClients,
      };
    }

    const previousOrders = await this.prisma.order.groupBy({
      by: ['customer_id'],
      _count: { _all: true },
      where: {
        customer_id: { in: customerIds },
        created_at: { lt: dateRange.startDate },
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      },
    });
    const recurringIds = new Set(previousOrders.map((p) => p.customer_id!));

    const newClients = customerIds.filter((id) => !recurringIds.has(id)).length;
    const recurringClients = customerIds.filter((id) => recurringIds.has(id)).length;

    const appCustomerIds = new Set(
      ordersInPeriod.filter((o) => o.auto === true).map((o) => o.customer_id!),
    );
    const callCustomerIds = new Set(
      ordersInPeriod.filter((o) => o.auto === false).map((o) => o.customer_id!),
    );

    const ltvByCustomer = await this.prisma.order.groupBy({
      by: ['customer_id'],
      _sum: { net_amount: true },
      _count: { _all: true },
      where: {
        customer_id: { in: customerIds },
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      },
    });

    const totalLtv = ltvByCustomer.reduce((acc, c) => acc + (c._sum?.net_amount ?? 0), 0);
    const totalOrdersAllTime = ltvByCustomer.reduce((acc, c) => acc + (c._count._all ?? 0), 0);
    const averageLtv = customerIds.length > 0 ? totalLtv / customerIds.length : 0;
    const totalRevenueInPeriod = ordersInPeriod.reduce((acc, o) => acc + (o.net_amount ?? 0), 0);
    const averageBasket =
      ordersInPeriod.length > 0 ? totalRevenueInPeriod / ordersInPeriod.length : 0;
    const averageOrderFrequency =
      customerIds.length > 0
        ? Math.round((totalOrdersAllTime / customerIds.length) * 10) / 10
        : 0;

    return {
      totalClients: customerIds.length,
      newClients,
      recurringClients,
      newClientsRate:
        customerIds.length > 0 ? Math.round((newClients / customerIds.length) * 100) : 0,
      averageLtv: Math.round(averageLtv),
      averageLtvFormatted: formatCurrency(averageLtv),
      averageBasket: Math.round(averageBasket),
      averageBasketFormatted: formatCurrency(averageBasket),
      averageOrderFrequency,
      appClients: appCustomerIds.size,
      callCenterClients: callCustomerIds.size,
      totalAllCustomers,
      noAppClients,
      hasOrderedClients,
      neverOrderedClients,
      incompleteProfileClients,
    };
  }

  async getClientsAcquisition(
    query: ClientsStatsQueryDto,
  ): Promise<ClientsAcquisitionResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const paidWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      created_at: buildDateFilter(dateRange),
    };

    const orders = await this.prisma.order.findMany({
      where: paidWhere,
      select: { customer_id: true, auto: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });

    const customerIds = [...new Set(orders.map((o) => o.customer_id!))] as string[];

    const prevOrders = await this.prisma.order.groupBy({
      by: ['customer_id'],
      _count: { _all: true },
      where: {
        customer_id: { in: customerIds },
        created_at: { lt: dateRange.startDate },
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      },
    });
    const recurringIds = new Set(prevOrders.map((p) => p.customer_id!));
    const isNew = (id: string | null) => (id ? !recurringIds.has(id) : true);

    const days = eachDayOfInterval({ start: dateRange.startDate, end: dateRange.endDate });

    const dailyTrend: ClientAcquisitionDailyPoint[] = days.map((day) => {
      const dStart = startOfDay(day);
      const dEnd = endOfDay(day);
      const dayOrders = orders.filter((o) => {
        const d = new Date(o.created_at);
        return d >= dStart && d <= dEnd;
      });

      const seen = new Set<string>();
      let newViaApp = 0, newViaCall = 0, recurViaApp = 0, recurViaCall = 0;
      for (const o of dayOrders) {
        if (!o.customer_id || seen.has(o.customer_id)) continue;
        seen.add(o.customer_id);
        const n = isNew(o.customer_id);
        const app = o.auto === true;
        if (app && n) newViaApp++;
        else if (app && !n) recurViaApp++;
        else if (!app && n) newViaCall++;
        else recurViaCall++;
      }

      return {
        date: format(day, 'yyyy-MM-dd'),
        label: format(day, 'EEE dd MMM', { locale: fr }),
        newViaApp,
        newViaCallCenter: newViaCall,
        recurringViaApp: recurViaApp,
        recurringViaCallCenter: recurViaCall,
      };
    });

    const totalNew = customerIds.filter((id) => !recurringIds.has(id)).length;
    const totalRecurring = customerIds.filter((id) => recurringIds.has(id)).length;

    return {
      dailyTrend,
      totalNew,
      totalRecurring,
      retentionRate:
        customerIds.length > 0
          ? Math.round((totalRecurring / customerIds.length) * 100)
          : 0,
    };
  }

  async getClientsRetention(
    query: ClientsStatsQueryDto,
  ): Promise<ClientsRetentionResponse> {
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const now = new Date();

    const baseWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
    };

    const allCustomers = await this.prisma.order.groupBy({
      by: ['customer_id'],
      _max: { created_at: true },
      where: baseWhere,
    });

    const total = allCustomers.length;
    if (total === 0) {
      return {
        activeClients: 0, churn30Days: 0, churnRate30: 0,
        churn60Days: 0, churnRate60: 0, atRiskClients: 0, retentionRate: 0,
      };
    }

    let active = 0, churn30 = 0, churn60 = 0, atRisk = 0;

    for (const c of allCustomers) {
      const lastOrder = c._max?.created_at;
      if (!lastOrder) continue;
      const days = differenceInDays(now, new Date(lastOrder));

      if (days <= 30) active++;
      else if (days <= 60) atRisk++;

      if (days > 30) churn30++;
      if (days > 60) churn60++;
    }

    return {
      activeClients: active,
      churn30Days: churn30,
      churnRate30: total > 0 ? Math.round((churn30 / total) * 100) : 0,
      churn60Days: churn60,
      churnRate60: total > 0 ? Math.round((churn60 / total) * 100) : 0,
      atRiskClients: atRisk,
      retentionRate: total > 0 ? Math.round((active / total) * 100) : 0,
    };
  }

  async getTopClients(query: ClientsStatsQueryDto): Promise<TopClientsResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const limit = query.limit ?? 10;

    const grouped = await this.prisma.order.groupBy({
      by: ['customer_id'],
      _count: { _all: true },
      _sum: { net_amount: true },
      _avg: { net_amount: true },
      _max: { created_at: true },
      where: {
        ...restaurantFilter,
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        created_at: buildDateFilter(dateRange),
      },
      orderBy: { _sum: { net_amount: 'desc' } },
      take: limit,
    });

    if (grouped.length === 0) return { items: [], totalCount: 0 };

    const customerIds = grouped.map((g) => g.customer_id!) as string[];

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
      select: {
        id: true, first_name: true, last_name: true, phone: true,
        email: true, image: true, loyalty_level: true, total_points: true,
      },
    });
    const customerMap = new Map(customers.map((c) => [c.id, c]));

    const items: TopClientItem[] = grouped.map((g) => {
      const customer = customerMap.get(g.customer_id!);
      const channels = channelMap.get(g.customer_id!) ?? { app: 0, call: 0 };
      const totalSpent = g._sum?.net_amount ?? 0;
      const preferredChannel =
        channels.app > channels.call
          ? 'APP'
          : channels.call > channels.app
          ? 'CALL_CENTER'
          : 'MIXED';

      return {
        id: g.customer_id!,
        fullname: customer
          ? `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim() || customer.phone
          : 'Inconnu',
        phone: customer?.phone ?? '',
        email: customer?.email ?? '',
        image: customer?.image ?? '',
        totalOrders: (g._count as { _all: number })._all,
        ordersInPeriod: (g._count as { _all: number })._all,
        totalSpent,
        totalSpentFormatted: formatCurrency(totalSpent),
        averageBasket: Math.round(g._avg?.net_amount ?? 0),
        lastOrderDate: g._max?.created_at
          ? format(new Date(g._max.created_at!), 'dd MMM yyyy', { locale: fr })
          : '',
        preferredChannel,
        loyaltyLevel: customer?.loyalty_level ?? 'STANDARD',
      };
    });

    return { items, totalCount: items.length };
  }

  async getInactiveClients(
    query: InactiveClientsQueryDto,
  ): Promise<InactiveClientsResponse> {
    const inactiveDays = query.inactiveDays ?? 30;
    const limitDate = subDays(new Date(), inactiveDays);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const limit = query.limit ?? 1000;

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
      take: limit,
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
      select: {
        id: true, first_name: true, last_name: true, phone: true, email: true,
      },
    });
    const customerMap = new Map(customers.map((c) => [c.id, c]));

    const now = new Date();
    const items: InactiveClientItem[] = lastOrders.map((g) => {
      const customer = customerMap.get(g.customer_id!);
      const lastOrderDate = g._max?.created_at!;
      const channels = channelMap.get(g.customer_id!) ?? { app: 0, call: 0 };
      const preferredChannel =
        channels.app > channels.call ? 'APP' : channels.call > channels.app ? 'CALL_CENTER' : 'MIXED';

      return {
        id: g.customer_id!,
        fullname: customer
          ? `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim() || customer.phone
          : 'Inconnu',
        phone: customer?.phone ?? '',
        email: customer?.email ?? '',
        lastOrderDate: lastOrderDate
          ? format(new Date(lastOrderDate), 'dd/MM/yyyy', { locale: fr })
          : '',
        daysSinceLastOrder: lastOrderDate
          ? differenceInDays(now, new Date(lastOrderDate))
          : 0,
        totalOrders: (g._count as { _all: number })._all,
        totalSpent: g._sum?.net_amount ?? 0,
        preferredChannel,
      };
    });

    return { items, totalCount: items.length, inactiveDays };
  }

  async getClientsByZone(query: ClientsStatsQueryDto): Promise<ClientsByZoneResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const activeCustomerIds = await this.prisma.order
      .groupBy({
        by: ['customer_id'],
        where: {
          ...restaurantFilter,
          paied: true,
          status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
          created_at: buildDateFilter(dateRange),
        },
      })
      .then((r) => r.map((o) => o.customer_id!) as string[]);

    if (activeCustomerIds.length === 0) {
      return { items: [], totalClients: 0 };
    }

    const addresses = await this.prisma.address.findMany({
      where: { customer_id: { in: activeCustomerIds } },
      select: { city: true, customer_id: true },
    });

    const clientCityMap = new Map<string, Set<string>>();
    for (const addr of addresses) {
      const city = addr.city ?? 'Zone inconnue';
      if (!clientCityMap.has(city)) clientCityMap.set(city, new Set());
      if (addr.customer_id) clientCityMap.get(city)!.add(addr.customer_id);
    }

    const ordersWithAddress = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        paied: true,
        type: 'DELIVERY',
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        created_at: buildDateFilter(dateRange),
        customer_id: { in: activeCustomerIds },
      },
      select: { address: true, customer_id: true },
    });

    const orderCityMap = new Map<string, number>();
    for (const order of ordersWithAddress) {
      const addr = order.address as any;
      const city = addr?.city ?? 'Zone inconnue';
      orderCityMap.set(city, (orderCityMap.get(city) ?? 0) + 1);
    }

    const totalClients = activeCustomerIds.length;
    const items = Array.from(clientCityMap.entries())
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, query.limit ?? 10)
      .map(([zone, clientSet]) => ({
        zone,
        clientCount: clientSet.size,
        orderCount: orderCityMap.get(zone) ?? 0,
        percentage: totalClients > 0 ? Math.round((clientSet.size / totalClients) * 100) : 0,
      }));

    return { items, totalClients };
  }

  async getClientAnalyticsProfile(
    clientId: string,
  ): Promise<ClientAnalyticsProfileResponse> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: clientId },
      select: {
        id: true, first_name: true, last_name: true, phone: true, image: true,
        loyalty_level: true, total_points: true,
      },
    });

    if (!customer) throw new NotFoundException('Client introuvable');

    const orders = await this.prisma.order.findMany({
      where: {
        customer_id: clientId,
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      },
      select: { auto: true, net_amount: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });

    if (orders.length === 0) {
      return {
        id: customer.id,
        fullname: `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim() || customer.phone,
        phone: customer.phone,
        image: customer.image ?? '',
        preferredChannel: 'APP',
        orderFrequencyPerMonth: 0,
        ltv: 0,
        ltvFormatted: '0 XOF',
        averageBasket: 0,
        totalOrders: 0,
        firstOrderDate: '',
        lastOrderDate: '',
        topDishes: [],
        loyaltyLevel: customer.loyalty_level ?? 'STANDARD',
        loyaltyPoints: customer.total_points ?? 0,
      };
    }

    const appOrders = orders.filter((o) => o.auto === true).length;
    const callOrders = orders.filter((o) => o.auto === false).length;
    const preferredChannel =
      appOrders > callOrders ? 'APP' : callOrders > appOrders ? 'CALL_CENTER' : 'MIXED';

    const ltv = orders.reduce((acc, o) => acc + (o.net_amount ?? 0), 0);
    const averageBasket = orders.length > 0 ? ltv / orders.length : 0;

    const firstOrder = new Date(orders[0].created_at);
    const lastOrder = new Date(orders[orders.length - 1].created_at);
    const monthsActive = Math.max(1, differenceInDays(lastOrder, firstOrder) / 30);
    const orderFrequencyPerMonth = Math.round((orders.length / monthsActive) * 10) / 10;

    const topDishesRaw = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      _count: { _all: true },
      where: {
        order: {
          customer_id: clientId,
          paied: true,
          status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        },
      },
      orderBy: { _count: { dish_id: 'desc' } },
      take: 5,
    });

    const dishIds = topDishesRaw.map((d) => d.dish_id);
    const dishes = await this.prisma.dish.findMany({
      where: { id: { in: dishIds } },
      select: { id: true, name: true, image: true },
    });
    const dishMap = new Map(dishes.map((d) => [d.id, d]));

    const topDishes = topDishesRaw
      .map((d) => {
        const dish = dishMap.get(d.dish_id);
        if (!dish) return null;
        return {
          dishId: dish.id,
          dishName: dish.name,
          image: dish.image ?? '',
          orderCount: d._count._all,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    return {
      id: customer.id,
      fullname:
        `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim() || customer.phone,
      phone: customer.phone,
      image: customer.image ?? '',
      preferredChannel,
      orderFrequencyPerMonth,
      ltv: Math.round(ltv),
      ltvFormatted: formatCurrency(ltv),
      averageBasket: Math.round(averageBasket),
      totalOrders: orders.length,
      firstOrderDate: format(firstOrder, 'dd/MM/yyyy', { locale: fr }),
      lastOrderDate: format(lastOrder, 'dd/MM/yyyy', { locale: fr }),
      topDishes,
      loyaltyLevel: customer.loyalty_level ?? 'STANDARD',
      loyaltyPoints: customer.total_points ?? 0,
    };
  }

  // =========================================================================
  // NOUVEAUX KPIs
  // =========================================================================

  /**
   * Répartition des clients par niveau de fidélité (STANDARD / PREMIUM / GOLD).
   */
  async getLoyaltyDistribution(
    query: ClientsStatsQueryDto,
  ): Promise<LoyaltyDistributionResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    // Récupérer les clients actifs sur la période
    const ordersInPeriod = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        created_at: buildDateFilter(dateRange),
      },
      select: { customer_id: true, net_amount: true },
    });

    const customerRevenueMap = new Map<string, number>();
    for (const o of ordersInPeriod) {
      const id = o.customer_id!;
      customerRevenueMap.set(id, (customerRevenueMap.get(id) ?? 0) + (o.net_amount ?? 0));
    }

    const customerIds = [...customerRevenueMap.keys()];
    if (customerIds.length === 0) {
      return { items: [], totalClients: 0 };
    }

    const customers = await this.prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, loyalty_level: true },
    });

    const levelMap = new Map<string, { count: number; totalRevenue: number }>();
    for (const c of customers) {
      const level = c.loyalty_level ?? 'STANDARD';
      const existing = levelMap.get(level) ?? { count: 0, totalRevenue: 0 };
      existing.count++;
      existing.totalRevenue += customerRevenueMap.get(c.id) ?? 0;
      levelMap.set(level, existing);
    }

    const totalClients = customers.length;
    const items = ['STANDARD', 'PREMIUM', 'GOLD']
      .map((level) => {
        const data = levelMap.get(level) ?? { count: 0, totalRevenue: 0 };
        return {
          level,
          clientCount: data.count,
          percentage: totalClients > 0 ? Math.round((data.count / totalClients) * 100) : 0,
          averageRevenue: data.count > 0 ? Math.round(data.totalRevenue / data.count) : 0,
        };
      })
      .filter((item) => item.clientCount > 0);

    return { items, totalClients };
  }

  /**
   * Répartition des clients par méthode de paiement (ONLINE / OFFLINE).
   */
  async getPaymentMethodDistribution(
    query: ClientsStatsQueryDto,
  ): Promise<PaymentMethodDistributionResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const orders = await this.prisma.order.findMany({
      where: {
        ...restaurantFilter,
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        created_at: buildDateFilter(dateRange),
      },
      select: { customer_id: true, payment_method: true, net_amount: true },
    });

    if (orders.length === 0) {
      return { items: [], totalClients: 0 };
    }

    const methodMap = new Map<
      string,
      { customers: Set<string>; orderCount: number; revenue: number }
    >();

    for (const o of orders) {
      const method = o.payment_method ?? 'ONLINE';
      if (!methodMap.has(method)) {
        methodMap.set(method, { customers: new Set(), orderCount: 0, revenue: 0 });
      }
      const entry = methodMap.get(method)!;
      if (o.customer_id) entry.customers.add(o.customer_id);
      entry.orderCount++;
      entry.revenue += o.net_amount ?? 0;
    }

    const allCustomerIds = new Set(orders.map((o) => o.customer_id!));
    const totalClients = allCustomerIds.size;

    const items = Array.from(methodMap.entries()).map(([method, data]) => ({
      method,
      clientCount: data.customers.size,
      orderCount: data.orderCount,
      percentage: totalClients > 0 ? Math.round((data.customers.size / totalClients) * 100) : 0,
      revenue: Math.round(data.revenue),
    }));

    return { items, totalClients };
  }

  /**
   * Concentration du CA — Combien de % du CA est généré par le top 10/20/50% des clients.
   */
  async getRevenueConcentration(
    query: ClientsStatsQueryDto,
  ): Promise<RevenueConcentrationResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const grouped = await this.prisma.order.groupBy({
      by: ['customer_id'],
      _sum: { net_amount: true },
      where: {
        ...restaurantFilter,
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
        created_at: buildDateFilter(dateRange),
      },
    });

    if (grouped.length === 0) {
      return {
        top10Percentage: 0, top20Percentage: 0, top50Percentage: 0,
        totalRevenue: 0, totalClients: 0,
      };
    }

    // Trier par CA décroissant
    const revenues = grouped
      .map((g) => g._sum.net_amount ?? 0)
      .sort((a, b) => b - a);

    const totalRevenue = revenues.reduce((a, b) => a + b, 0);
    const totalClients = revenues.length;

    const cumulativeShare = (topPercent: number): number => {
      const count = Math.max(1, Math.ceil(totalClients * (topPercent / 100)));
      const topRevenue = revenues.slice(0, count).reduce((a, b) => a + b, 0);
      return totalRevenue > 0 ? Math.round((topRevenue / totalRevenue) * 100) : 0;
    };

    return {
      top10Percentage: cumulativeShare(10),
      top20Percentage: cumulativeShare(20),
      top50Percentage: cumulativeShare(50),
      totalRevenue: Math.round(totalRevenue),
      totalClients,
    };
  }

  /**
   * Comparaison panier moyen : nouveaux clients vs récurrents.
   */
  async getBasketComparison(
    query: ClientsStatsQueryDto,
  ): Promise<BasketComparisonResponse> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);

    const paidWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      paied: true,
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      created_at: buildDateFilter(dateRange),
    };

    const ordersInPeriod = await this.prisma.order.findMany({
      where: paidWhere,
      select: { customer_id: true, net_amount: true },
    });

    const customerIds = [...new Set(ordersInPeriod.map((o) => o.customer_id!))] as string[];

    if (customerIds.length === 0) {
      return {
        newClientsBasket: 0, recurringClientsBasket: 0,
        newClientsRevenue: 0, recurringClientsRevenue: 0,
        newClientsOrders: 0, recurringClientsOrders: 0,
      };
    }

    // Identifier les récurrents (ont commandé avant la période)
    const previousOrders = await this.prisma.order.groupBy({
      by: ['customer_id'],
      _count: { _all: true },
      where: {
        customer_id: { in: customerIds },
        created_at: { lt: dateRange.startDate },
        paied: true,
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      },
    });
    const recurringIds = new Set(previousOrders.map((p) => p.customer_id!));

    let newRevenue = 0, newOrders = 0, recurRevenue = 0, recurOrders = 0;

    for (const o of ordersInPeriod) {
      const amount = o.net_amount ?? 0;
      if (recurringIds.has(o.customer_id!)) {
        recurRevenue += amount;
        recurOrders++;
      } else {
        newRevenue += amount;
        newOrders++;
      }
    }

    return {
      newClientsBasket: newOrders > 0 ? Math.round(newRevenue / newOrders) : 0,
      recurringClientsBasket: recurOrders > 0 ? Math.round(recurRevenue / recurOrders) : 0,
      newClientsRevenue: Math.round(newRevenue),
      recurringClientsRevenue: Math.round(recurRevenue),
      newClientsOrders: newOrders,
      recurringClientsOrders: recurOrders,
    };
  }
}
