import { BadRequestException } from '@nestjs/common';
import {
  differenceInDays,
  endOfDay,
  endOfMonth,
  endOfWeek,
  endOfYear,
  isBefore,
  isValid,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns';
import { Prisma } from '@prisma/client';

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

export interface PreviousPeriod {
  start: Date;
  end: Date;
}

export interface BaseStatsQuery {
  startDate?: string;
  endDate?: string;
  period?: 'today' | 'yesterday' | 'week' | 'last_week' | 'month' | 'last_month' | 'year';
  restaurantId?: string;
}

/**
 * Parse les paramètres de date en objet DateRange.
 * Supporte les périodes prédéfinies (today, week, month, year)
 * et les plages de dates personnalisées (startDate + endDate).
 */
export function parseDateRange(query: BaseStatsQuery): DateRange {
  const period = query.period || 'month';
  let startDate: Date;
  let endDate: Date;

  if (query.startDate && query.endDate) {
    startDate = parseISO(query.startDate);
    endDate = parseISO(query.endDate);

    if (!isValid(startDate) || !isValid(endDate)) {
      throw new BadRequestException(
        'Format de date invalide. Utilisez le format ISO (YYYY-MM-DD)',
      );
    }

    if (isBefore(endDate, startDate)) {
      throw new BadRequestException(
        'La date de fin doit être postérieure à la date de début',
      );
    }

    endDate = endOfDay(endDate);
    startDate = startOfDay(startDate);
  } else {
    const now = new Date();

    switch (period) {
      case 'today':
        startDate = startOfDay(now);
        endDate = endOfDay(now);
        break;
      case 'yesterday': {
        const yesterday = subDays(now, 1);
        startDate = startOfDay(yesterday);
        endDate = endOfDay(yesterday);
        break;
      }
      case 'week':
        startDate = startOfWeek(now, { weekStartsOn: 1 });
        endDate = endOfWeek(now, { weekStartsOn: 1 });
        break;
      case 'last_week': {
        const lastWeek = subWeeks(now, 1);
        startDate = startOfWeek(lastWeek, { weekStartsOn: 1 });
        endDate = endOfWeek(lastWeek, { weekStartsOn: 1 });
        break;
      }
      case 'last_month': {
        const lastMonth = subMonths(now, 1);
        startDate = startOfMonth(lastMonth);
        endDate = endOfMonth(lastMonth);
        break;
      }
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

/**
 * Calcule la période précédente de même durée.
 * Ex: si période = du 1 au 30 juin, retourne du 1 au 31 mai.
 */
export function getPreviousPeriod(start: Date, end: Date): PreviousPeriod {
  const diff = differenceInDays(end, start) + 1;
  return {
    start: startOfDay(subDays(start, diff)),
    end: endOfDay(subDays(end, diff)),
  };
}

/**
 * Calcule la tendance en pourcentage entre deux valeurs.
 * Retourne "+15.0%", "-5.2%", "0.0%"
 */
export function calculateTrend(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? '+100.0%' : '0.0%';
  const percentage = ((current - previous) / previous) * 100;
  return `${percentage >= 0 ? '+' : ''}${percentage.toFixed(1)}%`;
}

/**
 * Construit le filtre Prisma pour un restaurant donné.
 */
export function buildRestaurantFilter(
  restaurantId?: string,
): Prisma.OrderWhereInput {
  return restaurantId ? { restaurant_id: restaurantId } : {};
}

/**
 * Formate un montant en XOF lisible.
 * Ex: 1500000 → "1 500 000 XOF"
 */
export function formatCurrency(amount: number): string {
  return `${new Intl.NumberFormat('fr-FR').format(Math.round(amount))} XOF`;
}

/**
 * Construit le filtre de date sur created_at pour Prisma.
 */
export function buildDateFilter(dateRange: DateRange): Prisma.DateTimeFilter {
  return { gte: dateRange.startDate, lte: dateRange.endDate };
}
