import { Injectable, Logger } from '@nestjs/common';
import { EntityStatus, LoyaltyPointType, OrderStatus, Prisma } from '@prisma/client';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import * as puppeteer from 'puppeteer';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  parseDateRange,
  buildRestaurantFilter,
  buildDateFilter,
} from '../helpers/statistics.helper';
import { StatisticsOrdersService } from './statistics-orders.service';
import { StatisticsProductsService } from './statistics-products.service';
import { StatisticsClientsService } from './statistics-clients.service';
import { StatisticsDeliveryService } from './statistics-delivery.service';
import { StatisticsMarketingService } from './statistics-marketing.service';

export interface MarketingReportQuery {
  restaurantId?: string;
  startDate?: string;
  endDate?: string;
  period?: 'today' | 'week' | 'month' | 'last_month' | 'year';
  // Conservés pour la rétrocompatibilité du DTO, volontairement ignorés :
  // le rapport est GLOBAL (tous types, tous canaux) par conception.
  type?: string;
  status?: string;
  auto?: boolean;
}

// Libellés métier des types de commande (source unique du rapport).
const TYPE_LABELS: Record<string, string> = {
  DELIVERY: 'Livraison',
  PICKUP: 'À emporter',
  TABLE: 'Sur place',
};
// Ordre d'affichage stable des types.
const TYPE_ORDER = ['DELIVERY', 'PICKUP', 'TABLE'];

const CHANNEL_LABELS: Record<string, string> = {
  APP: 'Application',
  CALL_CENTER: 'Call Center',
  MIXED: 'Mixte',
};
const LEVEL_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  GOLD: 'Gold',
};

interface ReportData {
  meta: { dateLabel: string; scopeLabel: string; generatedAt: string };
  overview: {
    netRevenue: number;
    totalOrders: number;
    averageBasket: number;
    cancellationRate: number;
    cancelledOrders: number;
    evolution: string;
  };
  byType: Array<{
    label: string;
    orders: number;
    revenue: number;
    percentage: number;
    averageBasket: number;
  }>;
  channel: {
    app: { orders: number; revenue: number; averageBasket: number; newRate: number; percentage: number };
    call: { orders: number; revenue: number; averageBasket: number; newRate: number; percentage: number };
  };
  byRestaurant: {
    items: Array<{
      name: string;
      appOrders: number;
      callOrders: number;
      totalOrders: number;
      revenue: number;
      percentage: number;
    }>;
    totalApp: number;
    totalCall: number;
    totalOrders: number;
    totalRevenue: number;
  };
  products: {
    top: Array<{ name: string; category: string; sold: number; revenue: number; evolution: string }>;
    categories: Array<{ name: string; sold: number; revenue: number; percentage: number }>;
    promoShare: number;
    promoRevenue: number;
    promoSold: number;
    regularRevenue: number;
  };
  clients: {
    total: number;
    newClients: number;
    recurringClients: number;
    newRate: number;
    averageLtv: number;
    averageFrequency: number;
    newBasket: number;
    recurringBasket: number;
    top10Share: number;
    top20Share: number;
    top: Array<{ name: string; orders: number; spent: number; channel: string; level: string }>;
  };
  finance: {
    discount: number;
    deliveryFee: number;
    tax: number;
    ttc: number;
    ht: number;
  };
  loyalty: { earned: number; redeemed: number; expired: number; bonus: number };
  payment: {
    online: { orders: number; revenue: number };
    offline: { orders: number; revenue: number };
  };
  delivery: {
    totalDeliveries: number;
    feesCollected: number;
    averageFee: number;
    turboPercentage: number;
    freePercentage: number;
    averageMinutes: number;
    onTimeRate: number;
    topZones: Array<{ zone: string; orders: number; revenue: number; percentage: number }>;
  };
  promos: Array<{
    title: string;
    usageCount: number;
    uniqueUsers: number;
    totalDiscount: number;
    revenueGenerated: number;
  }>;
  reviews: { average: number; total: number; distribution: Record<number, number> };
}

@Injectable()
export class MarketingReportService {
  private readonly logger = new Logger(MarketingReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: StatisticsOrdersService,
    private readonly productsService: StatisticsProductsService,
    private readonly clientsService: StatisticsClientsService,
    private readonly deliveryService: StatisticsDeliveryService,
    private readonly marketingService: StatisticsMarketingService,
  ) {}

  async collectReportData(query: MarketingReportQuery): Promise<ReportData> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const dateFilter = buildDateFilter(dateRange);

    // Filtres communs à toutes les sous-requêtes réutilisées : le rapport est
    // volontairement TOUS TYPES (DELIVERY + PICKUP + TABLE) et tous canaux.
    const subQuery = {
      restaurantId: query.restaurantId,
      startDate: query.startDate,
      endDate: query.endDate,
      period: query.period,
    };

    // Base de calcul pour les requêtes d'appoint (bilan financier / paiement) :
    // aligné sur le reste du module (net_amount, statuts terminaux, payée).
    const baseWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      entity_status: { not: EntityStatus.DELETED },
      status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] },
      paied: true,
      created_at: dateFilter,
    };

    // Avis : Comment n'a pas de restaurant_id direct, on passe par la commande.
    const reviewWhere: Prisma.CommentWhereInput = {
      entity_status: EntityStatus.ACTIVE,
      created_at: dateFilter,
      ...(query.restaurantId ? { order: { restaurant_id: query.restaurantId } } : {}),
    };

    const [
      overviewRaw,
      channelRaw,
      restaurantSourceRaw,
      topProductsRaw,
      topCategoriesRaw,
      promoPerfRaw,
      clientsRaw,
      basketRaw,
      concentrationRaw,
      topClientsRaw,
      deliveryRaw,
      promoUsageRaw,
      financeAgg,
      loyaltyRaw,
      paymentRaw,
      reviewsAggregate,
      reviewsDistribution,
      allRestaurants,
    ] = await Promise.all([
      this.ordersService.getOrdersOverview(subQuery),
      this.ordersService.getOrdersByChannel(subQuery),

      // Détail par restaurant : ventilé App/Call Center + CA net, scopé au
      // restaurant si demandé (getOrdersByRestaurantAndSource ignore le
      // restaurantId et ne renvoie pas le CA, donc requête dédiée ici).
      this.prisma.order.groupBy({
        by: ['restaurant_id', 'auto'],
        _count: { _all: true },
        _sum: { net_amount: true },
        where: baseWhere,
      }),

      this.productsService.getTopProducts({ ...subQuery, limit: 8 }),
      this.productsService.getTopCategories({ ...subQuery, limit: 6 }),
      this.productsService.getPromotionPerformance(subQuery),
      this.clientsService.getClientsOverview(subQuery),
      this.clientsService.getBasketComparison(subQuery),
      this.clientsService.getRevenueConcentration(subQuery),
      this.clientsService.getTopClients({ ...subQuery, limit: 5 }),
      this.deliveryService.getDeliveryDashboard({ ...subQuery, limit: 5 }),
      this.marketingService.getPromoUsage(subQuery),

      // (A) Bilan financier tous-types : remises, frais livraison, taxe, TTC.
      // amount = net_amount - discount + tax + delivery_fee (cf. order.service).
      this.prisma.order.aggregate({
        _sum: {
          net_amount: true,
          amount: true,
          discount: true,
          tax: true,
          delivery_fee: true,
        },
        where: baseWhere,
      }),

      // (B) Fidélité : points émis vs consommés vs expirés sur la période.
      this.prisma.loyaltyPoint.groupBy({
        by: ['type'],
        _sum: { points: true },
        where: {
          created_at: dateFilter,
          ...(query.restaurantId ? { order: { restaurant_id: query.restaurantId } } : {}),
        },
      }),

      // (C) Paiement : part du CA en ligne vs au comptoir.
      this.prisma.order.groupBy({
        by: ['payment_method'],
        _count: { _all: true },
        _sum: { net_amount: true },
        where: baseWhere,
      }),

      // Avis : moyenne + total (scopés restaurant).
      this.prisma.comment.aggregate({
        _avg: { rating: true },
        _count: { _all: true },
        where: reviewWhere,
      }),

      // Avis : distribution par note.
      this.prisma.comment.groupBy({
        by: ['rating'],
        _count: { _all: true },
        where: reviewWhere,
      }),

      // Noms des restaurants (détail par restaurant + libellé de périmètre).
      this.prisma.restaurant.findMany({ select: { id: true, name: true } }),
    ]);

    // --- Détail par restaurant : App / Call Center + CA net (scopé) ---
    const restaurantMap = new Map(allRestaurants.map((r) => [r.id, r.name]));
    const restoAgg = new Map<
      string,
      { name: string; appOrders: number; callOrders: number; totalOrders: number; revenue: number }
    >();
    for (const row of restaurantSourceRaw) {
      const id = row.restaurant_id;
      if (!restoAgg.has(id)) {
        restoAgg.set(id, {
          name: restaurantMap.get(id) ?? 'Inconnu',
          appOrders: 0,
          callOrders: 0,
          totalOrders: 0,
          revenue: 0,
        });
      }
      const e = restoAgg.get(id)!;
      const count = row._count._all;
      if (row.auto === true) e.appOrders += count;
      else e.callOrders += count;
      e.totalOrders += count;
      e.revenue += row._sum.net_amount ?? 0;
    }
    const restoItems = [...restoAgg.values()].sort((a, b) => b.revenue - a.revenue);
    const totalRestoRevenue = restoItems.reduce((s, r) => s + r.revenue, 0);
    const byRestaurant = {
      items: restoItems.map((r) => ({
        name: r.name,
        appOrders: r.appOrders,
        callOrders: r.callOrders,
        totalOrders: r.totalOrders,
        revenue: r.revenue,
        percentage:
          totalRestoRevenue > 0 ? Math.round((r.revenue / totalRestoRevenue) * 1000) / 10 : 0,
      })),
      totalApp: restoItems.reduce((s, r) => s + r.appOrders, 0),
      totalCall: restoItems.reduce((s, r) => s + r.callOrders, 0),
      totalOrders: restoItems.reduce((s, r) => s + r.totalOrders, 0),
      totalRevenue: totalRestoRevenue,
    };

    // Part App/Call sur l'ensemble (répartition par source).
    const channelTotalOrders =
      channelRaw.app.totalOrders + channelRaw.callCenter.totalOrders;
    const channelPct = (n: number) =>
      channelTotalOrders > 0 ? Math.round((n / channelTotalOrders) * 1000) / 10 : 0;

    // --- Répartition par type (cœur du rapport) ---
    const byType = [...overviewRaw.byType]
      .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
      .map((t) => ({
        label: TYPE_LABELS[t.type] ?? t.type,
        orders: t.count,
        revenue: t.revenue,
        percentage: t.percentage,
        averageBasket: t.count > 0 ? Math.round(t.revenue / t.count) : 0,
      }));

    // --- Paiement : ONLINE (défaut) vs OFFLINE ---
    const payment = { online: { orders: 0, revenue: 0 }, offline: { orders: 0, revenue: 0 } };
    for (const row of paymentRaw) {
      const bucket = row.payment_method === 'OFFLINE' ? payment.offline : payment.online;
      bucket.orders += row._count._all;
      bucket.revenue += row._sum.net_amount ?? 0;
    }

    // --- Fidélité ---
    const loyalty = { earned: 0, redeemed: 0, expired: 0, bonus: 0 };
    for (const row of loyaltyRaw) {
      const points = row._sum.points ?? 0;
      if (row.type === LoyaltyPointType.EARNED) loyalty.earned = points;
      else if (row.type === LoyaltyPointType.REDEEMED) loyalty.redeemed = points;
      else if (row.type === LoyaltyPointType.EXPIRED) loyalty.expired = points;
      else if (row.type === LoyaltyPointType.BONUS) loyalty.bonus = points;
    }

    // --- Avis : distribution 1..5 ---
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of reviewsDistribution) {
      const rating = Math.round(r.rating);
      if (rating >= 1 && rating <= 5) distribution[rating] = r._count._all;
    }

    const dateLabel = `du ${format(dateRange.startDate, 'dd/MM/yyyy', { locale: fr })} au ${format(
      dateRange.endDate,
      'dd/MM/yyyy',
      { locale: fr },
    )}`;

    return {
      meta: {
        dateLabel,
        scopeLabel: query.restaurantId
          ? (restaurantMap.get(query.restaurantId) ?? 'Restaurant')
          : 'Tous les restaurants',
        generatedAt: format(new Date(), "dd/MM/yyyy 'à' HH:mm", { locale: fr }),
      },
      overview: {
        netRevenue: overviewRaw.totalRevenue,
        totalOrders: overviewRaw.totalOrders,
        averageBasket: overviewRaw.averageBasket,
        cancellationRate: overviewRaw.cancellationRate,
        cancelledOrders: overviewRaw.cancelledOrders,
        evolution: overviewRaw.evolution,
      },
      byType,
      channel: {
        app: {
          orders: channelRaw.app.totalOrders,
          revenue: channelRaw.app.revenue,
          averageBasket: channelRaw.app.averageBasket,
          newRate: channelRaw.app.newClientsRate,
          percentage: channelPct(channelRaw.app.totalOrders),
        },
        call: {
          orders: channelRaw.callCenter.totalOrders,
          revenue: channelRaw.callCenter.revenue,
          averageBasket: channelRaw.callCenter.averageBasket,
          newRate: channelRaw.callCenter.newClientsRate,
          percentage: channelPct(channelRaw.callCenter.totalOrders),
        },
      },
      byRestaurant,
      products: {
        top: topProductsRaw.items.map((p) => ({
          name: p.name,
          category: p.categoryName,
          sold: p.totalSold,
          revenue: p.revenue,
          evolution: p.evolution ?? '',
        })),
        categories: topCategoriesRaw.items.map((c) => ({
          name: c.name,
          sold: c.totalSold,
          revenue: c.revenue,
          percentage: c.percentage,
        })),
        promoShare: promoPerfRaw.promoRevenueShare,
        promoRevenue: promoPerfRaw.promoRevenue,
        promoSold: promoPerfRaw.promoTotalSold,
        regularRevenue: promoPerfRaw.regularRevenue,
      },
      clients: {
        total: clientsRaw.totalClients,
        newClients: clientsRaw.newClients,
        recurringClients: clientsRaw.recurringClients,
        newRate: clientsRaw.newClientsRate,
        averageLtv: clientsRaw.averageLtv,
        averageFrequency: clientsRaw.averageOrderFrequency,
        newBasket: basketRaw.newClientsBasket,
        recurringBasket: basketRaw.recurringClientsBasket,
        top10Share: concentrationRaw.top10Percentage,
        top20Share: concentrationRaw.top20Percentage,
        top: topClientsRaw.items.map((c) => ({
          name: c.fullname,
          orders: c.ordersInPeriod,
          spent: c.totalSpent,
          channel: CHANNEL_LABELS[c.preferredChannel] ?? c.preferredChannel,
          level: LEVEL_LABELS[c.loyaltyLevel] ?? c.loyaltyLevel,
        })),
      },
      finance: {
        discount: financeAgg._sum.discount ?? 0,
        deliveryFee: financeAgg._sum.delivery_fee ?? 0,
        tax: financeAgg._sum.tax ?? 0,
        ttc: financeAgg._sum.amount ?? 0,
        ht: (financeAgg._sum.amount ?? 0) - (financeAgg._sum.tax ?? 0),
      },
      loyalty,
      payment,
      delivery: {
        totalDeliveries: deliveryRaw.overview.totalDeliveries,
        feesCollected: deliveryRaw.overview.totalFeesCollected,
        averageFee: deliveryRaw.overview.averageFee,
        turboPercentage: deliveryRaw.overview.turboPercentage,
        freePercentage: deliveryRaw.overview.freePercentage,
        averageMinutes: deliveryRaw.performance.averageDeliveryMinutes,
        onTimeRate: deliveryRaw.performance.onTimeRate,
        topZones: deliveryRaw.byZone.items.slice(0, 5).map((z) => ({
          zone: z.zone,
          orders: z.orderCount,
          revenue: z.revenue,
          percentage: z.percentage,
        })),
      },
      promos: promoUsageRaw.items.slice(0, 5).map((p) => ({
        title: p.title,
        usageCount: p.usageCount,
        uniqueUsers: p.uniqueUsers,
        totalDiscount: p.totalDiscount,
        revenueGenerated: p.revenueGenerated,
      })),
      reviews: {
        average: reviewsAggregate._avg.rating ?? 0,
        total: reviewsAggregate._count._all,
        distribution,
      },
    };
  }

  async generatePdf(query: MarketingReportQuery): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.collectReportData(query);
    const html = this.buildHtml(data);

    // PUPPETEER_EXECUTABLE_PATH est défini dans le Dockerfile sur le binaire
    // Chromium système (/usr/bin/chromium). En local sans cette variable,
    // Puppeteer retombe sur le Chrome bundled qu'il télécharge.
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });

      const pdfBuffer = await page.pdf({
        format: 'A4',
        landscape: true,
        margin: { top: '9mm', right: '9mm', bottom: '9mm', left: '9mm' },
        printBackground: true,
      });

      const dateStr = format(new Date(), 'yyyy-MM-dd');
      return {
        buffer: Buffer.from(pdfBuffer),
        filename: `rapport-marketing-${dateStr}.pdf`,
      };
    } finally {
      await browser.close();
    }
  }

  private buildHtml(data: ReportData): string {
    const fmt = (n: number) => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0));
    const money = (n: number) => `${fmt(n)} FCFA`;
    const pctv = (n: number) => `${(n ?? 0).toFixed(1).replace(/\.0$/, '')}%`;
    // Échappe les chaînes issues de la base (noms clients/plats/promos/restaurants
    // saisis librement) avant injection dans le HTML rendu par Chromium :
    // évite qu'un nom comme "</td><script>" casse la mise en page ou s'exécute.
    const esc = (s: string) => {
      const m: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return String(s ?? '').replace(/[&<>"']/g, (c) => m[c]);
    };
    const emptyRow = (cols: number) =>
      `<tr><td colspan="${cols}" class="muted text-center">Aucune donnée sur la période</td></tr>`;

    // Badge d'évolution coloré à partir d'une chaîne "+12.3%" / "-4.1%" / "0.0%".
    const evo = (s: string) => {
      if (!s) return '';
      const neg = s.trim().startsWith('-');
      const zero = /^[+-]?0(\.0+)?%$/.test(s.trim());
      const cls = zero ? 'evo-flat' : neg ? 'evo-down' : 'evo-up';
      const arrow = zero ? '' : neg ? '▼ ' : '▲ ';
      return `<span class="evo ${cls}">${arrow}${s}</span>`;
    };

    const stars = (rating: number) => {
      const full = Math.round(rating);
      return '★'.repeat(full) + '☆'.repeat(Math.max(0, 5 - full));
    };

    // Couleurs par type pour les barres de répartition.
    const typeColors: Record<string, string> = {
      Livraison: '#F17922',
      'À emporter': '#F4A259',
      'Sur place': '#F6C177',
    };

    const totalPayment = data.payment.online.orders + data.payment.offline.orders;
    const onlinePct = totalPayment > 0 ? (data.payment.online.orders / totalPayment) * 100 : 0;
    const offlinePct = totalPayment > 0 ? (data.payment.offline.orders / totalPayment) * 100 : 0;

    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1f2430; background: #fff; font-size: 11.5px; line-height: 1.4; }

    .header { background: linear-gradient(135deg, #F17922, #d94f00); color: #fff; padding: 18px 26px; display: flex; justify-content: space-between; align-items: flex-end; }
    .header h1 { font-size: 21px; font-weight: 800; letter-spacing: 0.2px; }
    .header .sub { font-size: 12px; opacity: 0.95; margin-top: 3px; }
    .header .scope { text-align: right; font-size: 12px; opacity: 0.95; }
    .header .scope strong { display: block; font-size: 14px; }

    .content { padding: 16px 26px 6px; }
    .section { margin-bottom: 16px; page-break-inside: avoid; }
    .section-title { font-size: 13px; font-weight: 800; color: #d94f00; margin-bottom: 9px; padding-bottom: 4px; border-bottom: 2px solid #f1d9c6; display: flex; align-items: center; gap: 6px; }
    .section-title .emoji { font-size: 13px; }
    .note { font-size: 10px; color: #8a93a2; font-weight: 500; }

    .page-break { page-break-before: always; }

    /* KPI cards */
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .kpi-card { background: #faf7f4; border: 1px solid #efe6dd; border-radius: 10px; padding: 13px 15px; }
    .kpi-value { font-size: 22px; font-weight: 800; color: #d94f00; }
    .kpi-value .unit { font-size: 12px; font-weight: 700; color: #b06a3a; }
    .kpi-label { font-size: 10px; color: #6c757d; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
    .kpi-foot { margin-top: 6px; font-size: 10px; color: #8a93a2; }

    .evo { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 8px; }
    .evo-up { background: #e6f4ec; color: #1e8e5a; }
    .evo-down { background: #fdecea; color: #c0392b; }
    .evo-flat { background: #eef1f4; color: #6c757d; }

    table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
    th { background: #f6f7f9; color: #556; font-weight: 700; text-align: left; padding: 6px 9px; border-bottom: 1.5px solid #e3e7ec; }
    td { padding: 6px 9px; border-bottom: 1px solid #f1f3f5; }
    .text-right { text-align: right; }
    .text-center { text-align: center; }
    .muted { color: #8a93a2; }
    .rank { color: #b06a3a; font-weight: 800; width: 20px; }
    tfoot .total-row td { border-top: 2px solid #e0d6ca; border-bottom: none; background: #faf7f4; color: #d94f00; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }

    .card { background: #fff; border: 1px solid #eceff2; border-radius: 10px; padding: 12px 14px; }
    .card-title { font-size: 11px; font-weight: 700; color: #445; margin-bottom: 8px; }

    /* Barres de répartition */
    .bar-row { display: grid; grid-template-columns: 96px 1fr 92px; align-items: center; gap: 10px; margin: 7px 0; }
    .bar-label { font-size: 11px; font-weight: 700; color: #2a2f3a; }
    .bar-track { background: #eef1f4; border-radius: 6px; height: 16px; overflow: hidden; }
    .bar-fill { height: 16px; border-radius: 6px; }
    .bar-meta { text-align: right; font-size: 10.5px; color: #556; }
    .bar-meta strong { color: #1f2430; }

    /* Encarts chiffres */
    .stat-line { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px dashed #eef1f4; font-size: 11px; }
    .stat-line:last-child { border-bottom: none; }
    .stat-line .k { color: #6c757d; }
    .stat-line .v { font-weight: 700; color: #1f2430; }

    .badge { display: inline-block; padding: 1px 7px; border-radius: 8px; font-size: 9.5px; font-weight: 700; }
    .badge-app { background: #e6f4ec; color: #1e8e5a; }
    .badge-call { background: #e7f0fb; color: #2b6cb0; }
    .badge-gold { background: #fdf3d6; color: #9a7008; }
    .badge-premium { background: #efe9fb; color: #6b46c1; }
    .badge-standard { background: #eef1f4; color: #556; }

    .stars { color: #F17922; font-size: 15px; letter-spacing: 2px; }
    .review-bar { display: flex; align-items: center; gap: 7px; margin: 3px 0; }
    .review-fill { height: 8px; background: #F17922; border-radius: 4px; }
    .review-bg { flex: 1; height: 8px; background: #eef1f4; border-radius: 4px; overflow: hidden; }

    .callout { background: #faf7f4; border: 1px solid #efe6dd; border-radius: 9px; padding: 10px 12px; text-align: center; }
    .callout .big { font-size: 18px; font-weight: 800; color: #d94f00; }
    .callout .lab { font-size: 10px; color: #6c757d; margin-top: 2px; }

    .footer { text-align: center; color: #aab2bd; font-size: 9.5px; padding: 10px 26px; border-top: 1px solid #eef1f4; }
    .footer .method { color: #8a93a2; margin-top: 3px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Rapport Marketing Chicken Nation</h1>
      <div class="sub">Vue complète, tous types de commande ${data.meta.dateLabel}</div>
    </div>
    <div class="scope">
      <strong>${esc(data.meta.scopeLabel)}</strong>
      Généré le ${data.meta.generatedAt}
    </div>
  </div>

  <div class="content">

    <!-- 1. Vue d'ensemble -->
    <div class="section">
      <div class="section-title"><span class="emoji">💰</span> Vue d'ensemble</div>
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-value">${fmt(data.overview.netRevenue)} <span class="unit">FCFA</span></div>
          <div class="kpi-label">Chiffre d'affaires net</div>
          <div class="kpi-foot">${evo(data.overview.evolution)} vs période précédente</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">${fmt(data.overview.totalOrders)}</div>
          <div class="kpi-label">Commandes servies</div>
          <div class="kpi-foot">Livrées et retirées</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">${fmt(data.overview.averageBasket)} <span class="unit">FCFA</span></div>
          <div class="kpi-label">Panier moyen</div>
          <div class="kpi-foot">CA net par commande</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">${pctv(data.overview.cancellationRate)}</div>
          <div class="kpi-label">Taux d'annulation</div>
          <div class="kpi-foot">${fmt(data.overview.cancelledOrders)} commandes annulées</div>
        </div>
      </div>
    </div>

    <!-- 2. Répartition par type (coeur) -->
    <div class="section">
      <div class="section-title">Répartition par type de commande</div>
      <div class="grid-2">
        <div>
          <div class="note" style="margin-bottom:8px;">Part en nombre de commandes servies</div>
          ${
            data.byType.length > 0
              ? data.byType
                  .map(
                    (t) => `
            <div class="bar-row">
              <div class="bar-label">${t.label}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, t.percentage).toFixed(1)}%; background:${typeColors[t.label] ?? '#F17922'};"></div></div>
              <div class="bar-meta"><strong>${pctv(t.percentage)}</strong></div>
            </div>`,
                  )
                  .join('')
              : `<div class="note">Aucune donnée sur la période</div>`
          }
        </div>
        <div>
          <table>
            <thead>
              <tr><th>Type</th><th class="text-center">Commandes</th><th class="text-right">CA net</th><th class="text-right">Panier moyen</th></tr>
            </thead>
            <tbody>
              ${
                data.byType.length > 0
                  ? data.byType
                      .map(
                        (t) => `
                <tr>
                  <td><strong>${t.label}</strong></td>
                  <td class="text-center">${fmt(t.orders)}</td>
                  <td class="text-right">${money(t.revenue)}</td>
                  <td class="text-right">${money(t.averageBasket)}</td>
                </tr>`,
                      )
                      .join('')
                  : emptyRow(4)
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 3. Source & Restaurants -->
    <div class="section">
      <div class="section-title">Répartition par source et détail par restaurant</div>
      <div class="card" style="margin-bottom:14px;">
        <div class="card-title">Répartition par source (Application vs Call Center)</div>
        <table>
          <thead><tr><th>Source</th><th class="text-center">Commandes</th><th class="text-center">Part</th><th class="text-right">CA net</th><th class="text-right">Panier</th><th class="text-right">Nouveaux</th></tr></thead>
          <tbody>
            <tr>
              <td><span class="badge badge-app">Application</span></td>
              <td class="text-center">${fmt(data.channel.app.orders)}</td>
              <td class="text-center">${pctv(data.channel.app.percentage)}</td>
              <td class="text-right">${money(data.channel.app.revenue)}</td>
              <td class="text-right">${money(data.channel.app.averageBasket)}</td>
              <td class="text-right">${pctv(data.channel.app.newRate)}</td>
            </tr>
            <tr>
              <td><span class="badge badge-call">Call Center</span></td>
              <td class="text-center">${fmt(data.channel.call.orders)}</td>
              <td class="text-center">${pctv(data.channel.call.percentage)}</td>
              <td class="text-right">${money(data.channel.call.revenue)}</td>
              <td class="text-right">${money(data.channel.call.averageBasket)}</td>
              <td class="text-right">${pctv(data.channel.call.newRate)}</td>
            </tr>
          </tbody>
        </table>
        <div class="note" style="margin-top:6px;">« Part » = part des commandes servies. « Nouveaux » = commandes de clients acquis sur la période.</div>
      </div>
      <div class="card">
        <div class="card-title">Détail par restaurant (commandes par source et CA net)</div>
        <table>
          <thead><tr><th>Restaurant</th><th class="text-center">Application</th><th class="text-center">Call Center</th><th class="text-center">Total cmd.</th><th class="text-right">CA net</th><th class="text-center">Part CA</th></tr></thead>
          <tbody>
            ${
              data.byRestaurant.items.length > 0
                ? data.byRestaurant.items
                    .map(
                      (r) => `
            <tr>
              <td>${esc(r.name)}</td>
              <td class="text-center">${fmt(r.appOrders)}</td>
              <td class="text-center">${fmt(r.callOrders)}</td>
              <td class="text-center">${fmt(r.totalOrders)}</td>
              <td class="text-right">${money(r.revenue)}</td>
              <td class="text-center">${pctv(r.percentage)}</td>
            </tr>`,
                    )
                    .join('')
                : emptyRow(6)
            }
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td><strong>TOTAL</strong></td>
              <td class="text-center"><strong>${fmt(data.byRestaurant.totalApp)}</strong></td>
              <td class="text-center"><strong>${fmt(data.byRestaurant.totalCall)}</strong></td>
              <td class="text-center"><strong>${fmt(data.byRestaurant.totalOrders)}</strong></td>
              <td class="text-right"><strong>${money(data.byRestaurant.totalRevenue)}</strong></td>
              <td class="text-center"><strong>100%</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <!-- 4. Produits -->
    <div class="section page-break">
      <div class="section-title"><span class="emoji">🍗</span> Produits</div>
      <div class="grid-2">
        <div>
          <div class="card-title">Top plats vendus (tous types)</div>
          <table>
            <thead><tr><th class="rank">#</th><th>Plat</th><th>Catégorie</th><th class="text-center">Vendus</th><th class="text-right">CA</th><th class="text-right">Évol.</th></tr></thead>
            <tbody>
              ${
                data.products.top.length > 0
                  ? data.products.top
                      .map(
                        (p, i) => `
                <tr>
                  <td class="rank">${i + 1}</td>
                  <td><strong>${esc(p.name)}</strong></td>
                  <td class="muted">${esc(p.category)}</td>
                  <td class="text-center">${fmt(p.sold)}</td>
                  <td class="text-right">${money(p.revenue)}</td>
                  <td class="text-right">${evo(p.evolution)}</td>
                </tr>`,
                      )
                      .join('')
                  : emptyRow(6)
              }
            </tbody>
          </table>
        </div>
        <div>
          <div class="card-title">Meilleures catégories</div>
          <table>
            <thead><tr><th>Catégorie</th><th class="text-center">Vendus</th><th class="text-right">CA</th><th class="text-center">Part</th></tr></thead>
            <tbody>
              ${
                data.products.categories.length > 0
                  ? data.products.categories
                      .map(
                        (c) => `
                <tr>
                  <td><strong>${esc(c.name)}</strong></td>
                  <td class="text-center">${fmt(c.sold)}</td>
                  <td class="text-right">${money(c.revenue)}</td>
                  <td class="text-center">${pctv(c.percentage)}</td>
                </tr>`,
                      )
                      .join('')
                  : emptyRow(4)
              }
            </tbody>
          </table>
          <div class="callout" style="margin-top:12px;">
            <div class="big">${pctv(data.products.promoShare)}</div>
            <div class="lab">du CA produits réalisé sur des plats en promotion (${fmt(data.products.promoSold)} unités promo)</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 5. Clients -->
    <div class="section">
      <div class="section-title"><span class="emoji">👥</span> Clients</div>
      <div class="grid-3" style="margin-bottom:12px;">
        <div class="callout">
          <div class="big">${fmt(data.clients.newClients)} / ${fmt(data.clients.recurringClients)}</div>
          <div class="lab">Nouveaux / récurrents actifs (${pctv(data.clients.newRate)} de nouveaux)</div>
        </div>
        <div class="callout">
          <div class="big">${money(data.clients.newBasket)} / ${money(data.clients.recurringBasket)}</div>
          <div class="lab">Panier moyen nouveaux / récurrents</div>
        </div>
        <div class="callout">
          <div class="big">${pctv(data.clients.top10Share)}</div>
          <div class="lab">du CA généré par les 10% meilleurs clients (top 20% : ${pctv(data.clients.top20Share)})</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-title">Indicateurs clients</div>
          <div class="stat-line"><span class="k">Clients actifs sur la période</span><span class="v">${fmt(data.clients.total)}</span></div>
          <div class="stat-line"><span class="k">Valeur vie moyenne (LTV)</span><span class="v">${money(data.clients.averageLtv)}</span></div>
          <div class="stat-line"><span class="k">Fréquence de commande moyenne</span><span class="v">${data.clients.averageFrequency.toFixed(1)} / client</span></div>
        </div>
        <div class="card">
          <div class="card-title">Meilleurs clients</div>
          <table>
            <thead><tr><th>Client</th><th class="text-center">Cmd.</th><th class="text-right">Dépensé</th><th class="text-center">Canal</th><th class="text-center">Niveau</th></tr></thead>
            <tbody>
              ${
                data.clients.top.length > 0
                  ? data.clients.top
                      .map(
                        (c) => `
                <tr>
                  <td>${esc(c.name)}</td>
                  <td class="text-center">${fmt(c.orders)}</td>
                  <td class="text-right">${money(c.spent)}</td>
                  <td class="text-center muted">${esc(c.channel)}</td>
                  <td class="text-center">${esc(c.level)}</td>
                </tr>`,
                      )
                      .join('')
                  : emptyRow(5)
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 6. Marketing & coûts -->
    <div class="section">
      <div class="section-title">Marketing et coûts</div>
      <div class="grid-3">
        <div class="card">
          <div class="card-title">Promotions les plus utilisées</div>
          <table>
            <thead><tr><th>Promotion</th><th class="text-center">Usages</th><th class="text-right">Remise</th></tr></thead>
            <tbody>
              ${
                data.promos.length > 0
                  ? data.promos
                      .map(
                        (p) => `
                <tr>
                  <td><strong>${esc(p.title)}</strong><div class="note">${fmt(p.uniqueUsers)} clients · ${money(p.revenueGenerated)} de CA</div></td>
                  <td class="text-center">${fmt(p.usageCount)}</td>
                  <td class="text-right">${money(p.totalDiscount)}</td>
                </tr>`,
                      )
                      .join('')
                  : `<tr><td colspan="3" class="muted text-center">Aucune promotion utilisée sur la période</td></tr>`
              }
            </tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-title">Bilan financier</div>
          <div class="stat-line"><span class="k">Total remises accordées</span><span class="v">${money(data.finance.discount)}</span></div>
          <div class="stat-line"><span class="k">Total frais de livraison</span><span class="v">${money(data.finance.deliveryFee)}</span></div>
          <div class="stat-line"><span class="k">Taxe collectée</span><span class="v">${money(data.finance.tax)}</span></div>
          <div class="stat-line"><span class="k">Total HT (hors taxe)</span><span class="v">${money(data.finance.ht)}</span></div>
          <div class="stat-line"><span class="k">Total TTC (encaissé)</span><span class="v">${money(data.finance.ttc)}</span></div>
        </div>
        <div class="card">
          <div class="card-title"><span class="emoji">⭐</span> Points de fidélité</div>
          <div class="stat-line"><span class="k">Points émis (gagnés)</span><span class="v">${fmt(data.loyalty.earned)}</span></div>
          <div class="stat-line"><span class="k">Points consommés</span><span class="v">${fmt(data.loyalty.redeemed)}</span></div>
          <div class="stat-line"><span class="k">Points bonus</span><span class="v">${fmt(data.loyalty.bonus)}</span></div>
          <div class="stat-line"><span class="k">Points expirés</span><span class="v">${fmt(data.loyalty.expired)}</span></div>
        </div>
      </div>
    </div>

    <!-- 7. Livraison & Paiement -->
    <div class="section">
      <div class="grid-2">
        <div class="card">
          <div class="card-title"><span class="emoji">🛵</span> Livraison</div>
          <div class="grid-2" style="gap:10px; margin-bottom:8px;">
            <div class="stat-line"><span class="k">Livraisons</span><span class="v">${fmt(data.delivery.totalDeliveries)}</span></div>
            <div class="stat-line"><span class="k">Frais collectés</span><span class="v">${money(data.delivery.feesCollected)}</span></div>
            <div class="stat-line"><span class="k">Frais moyen</span><span class="v">${money(data.delivery.averageFee)}</span></div>
            <div class="stat-line"><span class="k">Turbo / gratuit</span><span class="v">${pctv(data.delivery.turboPercentage)} / ${pctv(data.delivery.freePercentage)}</span></div>
            <div class="stat-line"><span class="k">Temps moyen</span><span class="v">${Math.round(data.delivery.averageMinutes)} min</span></div>
            <div class="stat-line"><span class="k">Ponctualité</span><span class="v">${pctv(data.delivery.onTimeRate)}</span></div>
          </div>
          <div class="card-title" style="margin-top:6px;">Meilleures zones</div>
          <table>
            <thead><tr><th>Zone</th><th class="text-center">Livraisons</th><th class="text-right">CA</th><th class="text-center">Part</th></tr></thead>
            <tbody>
              ${
                data.delivery.topZones.length > 0
                  ? data.delivery.topZones
                      .map(
                        (z) => `
                <tr><td>${esc(z.zone)}</td><td class="text-center">${fmt(z.orders)}</td><td class="text-right">${money(z.revenue)}</td><td class="text-center">${pctv(z.percentage)}</td></tr>`,
                      )
                      .join('')
                  : `<tr><td colspan="4" class="muted text-center">Pas de donnée de zone</td></tr>`
              }
            </tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-title"><span class="emoji">💳</span> Mode de paiement</div>
          <div class="bar-row">
            <div class="bar-label">En ligne</div>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, onlinePct).toFixed(1)}%; background:#1e8e5a;"></div></div>
            <div class="bar-meta"><strong>${pctv(onlinePct)}</strong></div>
          </div>
          <div class="bar-row">
            <div class="bar-label">Au comptoir</div>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, offlinePct).toFixed(1)}%; background:#2b6cb0;"></div></div>
            <div class="bar-meta"><strong>${pctv(offlinePct)}</strong></div>
          </div>
          <table style="margin-top:8px;">
            <thead><tr><th>Mode</th><th class="text-center">Commandes</th><th class="text-right">CA net</th></tr></thead>
            <tbody>
              <tr><td><strong>En ligne</strong></td><td class="text-center">${fmt(data.payment.online.orders)}</td><td class="text-right">${money(data.payment.online.revenue)}</td></tr>
              <tr><td><strong>Au comptoir</strong></td><td class="text-center">${fmt(data.payment.offline.orders)}</td><td class="text-right">${money(data.payment.offline.revenue)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 8. Avis clients -->
    <div class="section">
      <div class="section-title">Satisfaction et avis clients</div>
      <div style="display:flex; align-items:center; gap:34px;">
        <div style="text-align:center; min-width:120px;">
          <div class="stars">${stars(data.reviews.average)}</div>
          <div style="font-size:22px; font-weight:800; color:#d94f00; margin-top:4px;">${data.reviews.average.toFixed(1)}/5</div>
          <div class="note">${fmt(data.reviews.total)} avis sur la période</div>
        </div>
        <div style="flex:1;">
          ${[5, 4, 3, 2, 1]
            .map((n) => {
              const count = data.reviews.distribution[n] || 0;
              const p = data.reviews.total > 0 ? Math.round((count / data.reviews.total) * 100) : 0;
              return `
            <div class="review-bar">
              <span style="width:12px; text-align:center; font-weight:700;">${n}</span>
              <span style="color:#F17922;">★</span>
              <div class="review-bg"><div class="review-fill" style="width:${p}%"></div></div>
              <span class="note" style="width:52px; text-align:right;">${fmt(count)} (${p}%)</span>
            </div>`;
            })
            .join('')}
        </div>
      </div>
    </div>

  </div>

  <div class="footer">
    Rapport généré automatiquement par Chicken Nation, le ${data.meta.generatedAt}.
    <div class="method">CA net = chiffre d'affaires produits hors taxe et frais de livraison. Périmètre : commandes livrées et retirées (payées), tous types confondus.</div>
  </div>
</body>
</html>`;
  }
}
