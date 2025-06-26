import { Injectable, BadRequestException } from '@nestjs/common';
import {
  startOfMonth,
  endOfMonth,
  eachMonthOfInterval,
  startOfYear,
  endOfYear,
  format,
  startOfDay,
  endOfDay,
  eachHourOfInterval,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  subWeeks,
  differenceInDays,
  subDays,
  parseISO,
  isValid,
  isBefore,
} from 'date-fns';

import { fr } from 'date-fns/locale';

import { OrderStatus, PaiementMode, PaiementStatus, Prisma } from '@prisma/client';
import {
  GetStatsQueryDto,
  DashboardViewModel,
  StatsCards,
  RevenueData,
  WeeklyOrdersData,
  BestSellingMenuItem,
  DailySalesData,
  DailyRevenueData,
  PeriodicData,
  HourlyValue
} from '../dto/dashboard.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { statisticsIcons } from '../constantes/statistics.constante';

interface DateRange {
  startDate: Date;
  endDate: Date;
}

interface PreviousPeriod {
  start: Date;
  end: Date;
}

@Injectable()
export class StatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboardStats(query: GetStatsQueryDto): Promise<DashboardViewModel> {
    // Validation et parsing des dates
    const dateRange = this.parseDateRange(query);
    const restaurantFilter = this.buildRestaurantFilter(query.restaurantId);

    try {
      // Exécution parallèle de toutes les requêtes
      const [stats, revenue, weeklyOrders, bestSellingMenus, dailySales] = await Promise.all([
        this.getStatsCards(dateRange, restaurantFilter, query.period || 'month'),
        this.getRevenueData(dateRange, restaurantFilter, query.period || 'month'),
        this.getWeeklyOrdersData(dateRange, restaurantFilter),
        this.getBestSellingMenus(dateRange, restaurantFilter),
        this.getDailySalesData(dateRange, restaurantFilter),
      ]);

      return {
        stats,
        revenue,
        weeklyOrders,
        bestSellingMenus,
        dailySales,
      };
    } catch (error) {
      throw new BadRequestException(`Erreur lors de la récupération des statistiques: ${error.message}`);
    }
  }

  private parseDateRange(query: GetStatsQueryDto): DateRange {
    const period = query.period || 'month';
    let startDate: Date;
    let endDate: Date;

    // Si des dates personnalisées sont fournies
    if (query.startDate && query.endDate) {
      startDate = parseISO(query.startDate);
      endDate = parseISO(query.endDate);

      // Validation des dates
      if (!isValid(startDate) || !isValid(endDate)) {
        throw new BadRequestException('Format de date invalide. Utilisez le format ISO (YYYY-MM-DD)');
      }

      if (isBefore(endDate, startDate)) {
        throw new BadRequestException('La date de fin doit être postérieure à la date de début');
      }

      // Ajuster l'heure de fin
      endDate.setHours(23, 59, 59, 999);
    } else {
      // Utilisation des périodes prédéfinies
      const now = new Date();

      switch (period) {
        case 'today':
          startDate = startOfDay(now);
          endDate = endOfDay(now);
          break;
        case 'week':
          startDate = startOfWeek(now, { weekStartsOn: 1 }); // Lundi comme premier jour
          endDate = endOfWeek(now, { weekStartsOn: 1 });
          break;
        case 'year':
          startDate = startOfYear(now);
          endDate = endOfYear(now);
          break;
        case 'month':
        default:
          startDate = startOfMonth(now);
          endDate = endOfMonth(now);
          break;
      }
    }

    return { startDate, endDate };
  }

  private buildRestaurantFilter(restaurantId?: string): Prisma.OrderWhereInput {
    return restaurantId ? { restaurant_id: restaurantId } : {};
  }

  private async getStatsCards(
    dateRange: DateRange,
    restaurantFilter: Prisma.OrderWhereInput,
    period: string
  ): Promise<StatsCards> {
    const { startDate, endDate } = dateRange;
    const prevPeriod = this.getPreviousPeriod(startDate, endDate);

    // Période actuelle
    const [revenue, menusSold, totalOrders, totalCustomers] = await Promise.all([
      // MODIFICATION : Utilisation de net_amount et paied: true pour le revenu
      this.prisma.order.aggregate({
        _sum: { net_amount: true },
        where: {
          ...restaurantFilter,
          status: OrderStatus.COMPLETED,
          paied: true, // Seules les commandes payées
          created_at: { gte: startDate, lte: endDate },
        },
      }),
      this.prisma.orderItem.aggregate({
        _sum: { quantity: true },
        where: {
          order: {
            ...restaurantFilter,
            status: OrderStatus.COMPLETED,
            paied: true, // Seules les commandes payées qui ont des menus vendus
            created_at: { gte: startDate, lte: endDate },
          },
        },
      }),
      this.prisma.order.count({
        where: {
          ...restaurantFilter,
          status: OrderStatus.COMPLETED,
          paied: true, // Compter uniquement les commandes terminées et payées
          created_at: { gte: startDate, lte: endDate },
        },
      }),
      this.prisma.customer.count({
        where: {
          created_at: { lte: endDate },
          orders: {
            some: {
              ...restaurantFilter,
              status: OrderStatus.COMPLETED,
              paied: true, // Compter les clients ayant au moins une commande complétée et payée
            }
          },
        },
      }),
    ]);

    // Période précédente
    const [prevRevenue, prevMenusSold, prevTotalOrders] = await Promise.all([
      // MODIFICATION : Utilisation de net_amount et paied: true pour le revenu précédent
      this.prisma.order.aggregate({
        _sum: { net_amount: true },
        where: {
          ...restaurantFilter,
          status: OrderStatus.COMPLETED,
          paied: true, // Seules les commandes payées
          created_at: { gte: prevPeriod.start, lte: prevPeriod.end },
        },
      }),
      this.prisma.orderItem.aggregate({
        _sum: { quantity: true },
        where: {
          order: {
            ...restaurantFilter,
            status: OrderStatus.COMPLETED,
            paied: true, // Seules les commandes payées
            created_at: { gte: prevPeriod.start, lte: prevPeriod.end },
          },
        },
      }),
      this.prisma.order.count({
        where: {
          ...restaurantFilter,
          status: OrderStatus.COMPLETED,
          paied: true, // Compter uniquement les commandes terminées et payées
          created_at: { gte: prevPeriod.start, lte: prevPeriod.end },
        },
      }),
    ]);

    // Calcul des valeurs
    const revenueValue = revenue._sum.net_amount || 0;
    const prevRevenueValue = prevRevenue._sum.net_amount || 0;
    const menusSoldValue = menusSold._sum.quantity || 0;
    const prevMenusSoldValue = prevMenusSold._sum.quantity || 0;
    const totalOrdersValue = totalOrders || 0;
    const prevTotalOrdersValue = prevTotalOrders || 0;

    // Génération des titres dynamiques
    const periodTitles = {
      today: 'Revenu quotidien',
      week: 'Revenu hebdomadaire',
      month: 'Revenu mensuel',
      year: 'Revenu annuel',
    };

    return {
      revenue: {
        title: periodTitles[period] || 'Revenu mensuel',
        value: revenueValue.toLocaleString('fr-FR'),
        unit: 'XOF',
        badgeText: this.calculateTrend(revenueValue, prevRevenueValue),
        badgeColor: revenueValue >= prevRevenueValue ? statisticsIcons.revenue.color : '#FF0000',
        iconImage: statisticsIcons.revenue.url,
      },
      menusSold: {
        title: 'Menus vendus',
        value: menusSoldValue.toString(),
        badgeText: this.calculateTrend(menusSoldValue, prevMenusSoldValue),
        badgeColor: menusSoldValue >= prevMenusSoldValue ? statisticsIcons.menusSold.color : '#FF0000',
        iconImage: statisticsIcons.menusSold.url,
      },
      totalOrders: {
        title: 'Commandes',
        value: totalOrdersValue.toString(),
        badgeText: this.calculateTrend(totalOrdersValue, prevTotalOrdersValue),
        badgeColor: totalOrdersValue >= prevTotalOrdersValue ? statisticsIcons.totalOrders.color : '#FF0000',
        iconImage: statisticsIcons.totalOrders.url,
      },
      totalCustomers: {
        title: 'Clients',
        value: totalCustomers.toString(),
        badgeText: '+8.7%', // Cette valeur pourrait être calculée dynamiquement (voir ma suggestion précédente)
        badgeColor: statisticsIcons.totalCustomers.color,
        iconImage: statisticsIcons.totalCustomers.url,
      },
    };
  }

  private calculateTrend(current: number, previous: number): string {
    if (previous === 0) return current > 0 ? '100.0%' : '0.0%';
    const percentage = ((current - previous) / previous * 100);
    return `${percentage >= 0 ? '+' : ''}${percentage.toFixed(1)}%`;
  }

  private getPreviousPeriod(start: Date, end: Date): PreviousPeriod {
    const diff = differenceInDays(end, start) + 1;
    return {
      start: subDays(start, diff),
      end: subDays(end, diff),
    };
  }

  private async getRevenueData(
    dateRange: DateRange,
    restaurantFilter: Prisma.OrderWhereInput,
    period: string
  ): Promise<RevenueData> {
    const { startDate, endDate } = dateRange;
    const isDaily = period === 'today';
    const isYearly = period === 'year';

    // Données principales
    const mainData = isDaily
      ? await this.getDailyRevenueData(startDate, endDate, restaurantFilter)
      : await this.getPeriodicRevenueData(startDate, endDate, restaurantFilter, period);

    // Données de comparaison
    const prevPeriod = this.getPreviousPeriod(startDate, endDate);
    const prevData = isDaily
      ? await this.getDailyRevenueData(prevPeriod.start, prevPeriod.end, restaurantFilter)
      : await this.getPeriodicRevenueData(prevPeriod.start, prevPeriod.end, restaurantFilter, period);

    const comparedToText = {
      today: 'hier',
      week: 'semaine précédente',
      month: 'mois précédent',
      year: 'année précédente',
    };

    const dailyData: DailyRevenueData = {
      total: `${mainData.total.toLocaleString('fr-FR')} XOF`,
      trend: {
        percentage: this.calculateTrend(mainData.total, prevData.total),
        comparedTo: comparedToText[period] || 'période précédente',
        isPositive: mainData.total >= prevData.total,
      },
    };

    // Ajouter les données horaires pour la période quotidienne
    if (isDaily && 'hourlyValues' in mainData) {
      dailyData.hourlyValues = mainData.hourlyValues;
    }

    const result: RevenueData = { dailyData };

    // Ajouter les données mensuelles pour la période annuelle
    if (isYearly && 'periodicData' in mainData) {
      result.monthlyData = mainData.periodicData;
    }

    return result;
  }

  private async getDailyRevenueData(
    start: Date,
    end: Date,
    restaurantFilter: Prisma.OrderWhereInput
  ): Promise<{ total: number; hourlyValues: HourlyValue[] }> {
    // MODIFICATION : Utilisation de net_amount et paied: true
    const totalRevenue = await this.prisma.order.aggregate({
      _sum: { net_amount: true },
      where: {
        ...restaurantFilter,
        status: OrderStatus.COMPLETED,
        paied: true,
        created_at: { gte: start, lte: end },
      },
    });

    const total = totalRevenue._sum.net_amount || 0;

    const hours = eachHourOfInterval({ start, end });
    const hourlyValues: HourlyValue[] = await Promise.all(
      hours.map(async (hour) => {
        const hourStart = new Date(hour);
        const hourEnd = new Date(hour);
        hourEnd.setHours(hour.getHours() + 1, 0, 0, 0);

        // MODIFICATION : Utilisation de net_amount et paied: true
        const revenue = await this.prisma.order.aggregate({
          _sum: { net_amount: true },
          where: {
            ...restaurantFilter,
            status: OrderStatus.COMPLETED,
            paied: true,
            created_at: { gte: hourStart, lt: hourEnd },
          },
        });

        return {
          hour: format(hour, 'HH:mm'),
          value: revenue._sum.net_amount || 0,
        };
      })
    );

    return { total, hourlyValues };
  }

  private async getPeriodicRevenueData(
    start: Date,
    end: Date,
    restaurantFilter: Prisma.OrderWhereInput,
    period: string
  ): Promise<{ total: number; periodicData: PeriodicData[] }> {
    const intervals = period === 'year'
      ? eachMonthOfInterval({ start, end })
      : eachDayOfInterval({ start, end });

    const periodicData: PeriodicData[] = await Promise.all(
      intervals.map(async (date) => {
        const intervalStart = period === 'year' ? startOfMonth(date) : startOfDay(date);
        const intervalEnd = period === 'year' ? endOfMonth(date) : endOfDay(date);

        // MODIFICATION : Utilisation de net_amount et paied: true
        const revenue = await this.prisma.order.aggregate({
          _sum: { net_amount: true },
          where: {
            ...restaurantFilter,
            status: OrderStatus.COMPLETED,
            paied: true,
            created_at: { gte: intervalStart, lte: intervalEnd },
          },
        });

        return {
          name: period === 'year'
            ? format(date, 'MMM', { locale: fr })
            : format(date, 'EEE', { locale: fr }).substring(0, 3),
          value: revenue._sum.net_amount || 0,
        };
      })
    );

    const total = periodicData.reduce((sum, item) => sum + item.value, 0);
    return { total, periodicData };
  }

  private async getWeeklyOrdersData(
    dateRange: DateRange,
    restaurantFilter: Prisma.OrderWhereInput
  ): Promise<WeeklyOrdersData> {
    const { startDate, endDate } = dateRange;

    // Générer les plages de dates des 4 dernières semaines
    const dateRanges = Array.from({ length: 4 }, (_, i) => {
      const start = subWeeks(startDate, i + 1);
      const end = subWeeks(endDate, i + 1);
      return `Du ${format(start, 'dd MMM', { locale: fr })} au ${format(end, 'dd MMM', { locale: fr })}`;
    }).reverse();

    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const dailyOrders = await Promise.all(
      days.map(async (day) => {
        const dayStart = startOfDay(day);
        const dayEnd = endOfDay(day);

        const count = await this.prisma.order.count({
          where: {
            ...restaurantFilter,
            status: OrderStatus.COMPLETED,
            paied: true, // Si vous voulez compter uniquement les commandes payées
            created_at: { gte: dayStart, lte: dayEnd },
          },
        });

        return {
          day: format(day, 'EEE', { locale: fr }).substring(0, 3),
          count,
        };
      })
    );

    return {
      dateRanges,
      currentRange: `Du ${format(startDate, 'dd MMM', { locale: fr })} au ${format(endDate, 'dd MMM', { locale: fr })}`,
      dailyOrders,
    };
  }

  private async getBestSellingMenus(
    dateRange: DateRange,
    restaurantFilter: Prisma.OrderWhereInput
  ): Promise<BestSellingMenuItem[]> {
    const { startDate, endDate } = dateRange;

    const bestSelling = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      _sum: { quantity: true },
      where: {
        order: {
          ...restaurantFilter,
          status: OrderStatus.COMPLETED,
          paied: true, // Inclure uniquement les menus vendus dans des commandes payées
          created_at: { gte: startDate, lte: endDate },
        },
      },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 4,
    });

    if (bestSelling.length === 0) {
      return [];
    }

    const totalSold = bestSelling.reduce((sum, item) => sum + (item._sum.quantity || 0), 0);

    const items = await Promise.all(
      bestSelling.map(async (item) => {
        const dish = await this.prisma.dish.findUnique({
          where: { id: item.dish_id },
          select: { id: true, name: true, image: true },
        });

        if (!dish) return null;

        const quantity = item._sum.quantity || 0;
        const percentage = totalSold > 0
          ? Math.round((quantity / totalSold) * 100)
          : 0;

        return {
          id: dish.id,
          name: dish.name,
          count: quantity,
          image: dish.image || '',
          percentage,
          interestedPercentage: `${percentage}% des ventes`,
        };
      })
    );

    return items.filter((item): item is BestSellingMenuItem => item !== null);
  }

  private async getDailySalesData(
    dateRange: DateRange,
    restaurantFilter: Prisma.OrderWhereInput
  ): Promise<DailySalesData> {
    const { startDate, endDate } = dateRange;

    const payments = await this.prisma.paiement.groupBy({
      by: ['mode'],
      _sum: { amount: true }, // Ici, l'agrégation sur `amount` du paiement est probablement correcte, car c'est le montant du paiement lui-même
      where: {
        order: { // Filtre par restaurant sur la commande associée au paiement
          ...restaurantFilter,
          paied: true, // Ne considérer que les paiements liés à des commandes marquées comme payées
          status: OrderStatus.COMPLETED // S'assurer que la commande est aussi complétée
        },
        status: PaiementStatus.SUCCESS,
        created_at: { gte: startDate, lte: endDate },
      },
    });

    const totalAmount = payments.reduce((sum, p) => sum + (p._sum.amount || 0), 0);

    const modeLabels: Record<PaiementMode, string> = {
      [PaiementMode.CASH]: 'Espèces',
      [PaiementMode.MOBILE_MONEY]: 'Mobile Money',
      [PaiementMode.WALLET]: 'Wallet',
      [PaiementMode.CREDIT_CARD]: 'Carte de crédit',
    };

    const modeColors: Record<PaiementMode, string> = {
      [PaiementMode.CASH]: '#10B981',
      [PaiementMode.MOBILE_MONEY]: '#3B82F6',
      [PaiementMode.WALLET]: '#F59E0B',
      [PaiementMode.CREDIT_CARD]: '#8B5CF6',
    };

    const categories = payments.map((p) => {
      const amount = p._sum.amount || 0;
      const percentage = totalAmount > 0 ? Math.round((amount / totalAmount) * 100) : 0;

      return {
        label: modeLabels[p.mode] || p.mode,
        value: `${amount.toLocaleString('fr-FR')} XOF`,
        color: modeColors[p.mode] || '#888888',
        percentage,
      };
    });

    return {
      title: 'Ventes par mode de paiement',
      subtitle: `Total: ${totalAmount.toLocaleString('fr-FR')} XOF`,
      categories,
    };
  }
}