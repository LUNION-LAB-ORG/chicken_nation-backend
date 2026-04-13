import { Injectable, Logger } from '@nestjs/common';
import { EntityStatus, OrderStatus, OrderType, Prisma } from '@prisma/client';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import * as puppeteer from 'puppeteer';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  parseDateRange,
  buildRestaurantFilter,
  formatCurrency,
  buildDateFilter,
  DateRange,
} from '../helpers/statistics.helper';

export interface MarketingReportQuery {
  restaurantId?: string;
  startDate?: string;
  endDate?: string;
  period?: 'today' | 'week' | 'month' | 'last_month' | 'year';
  type?: OrderType;
  status?: OrderStatus;
  auto?: boolean;
}

interface ReportData {
  dateLabel: string;
  kpis: { totalOrders: number; averageBasket: number };
  byRestaurant: Array<{ name: string; orders: number; revenue: number }>;
  bySource: Array<{ source: string; orders: number; revenue: number }>;
  byType: Array<{ type: string; label: string; orders: number; revenue: number }>;
  topDishes: Array<{
    name: string;
    quantity: number;
    revenue: number;
    isPromotion: boolean;
    promotionPrice: number | null;
    price: number;         // Prix unitaire réel (CA / quantité)
    originalPrice: number; // Prix catalogue
  }>;
  reviews: {
    average: number;
    total: number;
    distribution: Record<number, number>;
  };
}

@Injectable()
export class MarketingReportService {
  private readonly logger = new Logger(MarketingReportService.name);

  constructor(private readonly prisma: PrismaService) {}

  async collectReportData(query: MarketingReportQuery): Promise<ReportData> {
    const dateRange = parseDateRange(query);
    const restaurantFilter = buildRestaurantFilter(query.restaurantId);
    const dateFilter = buildDateFilter(dateRange);

    const baseWhere: Prisma.OrderWhereInput = {
      ...restaurantFilter,
      entity_status: { not: EntityStatus.DELETED },
      status: query.status ?? OrderStatus.COMPLETED,
      paied: true,
      created_at: dateFilter,
      type: query.type ?? OrderType.DELIVERY, // Focus livraison uniquement
      ...(query.auto !== undefined && { auto: query.auto }),
    };

    const [
      kpiData,
      restaurantData,
      sourceData,
      typeData,
      topDishesRaw,
      reviewsAggregate,
      reviewsDistribution,
    ] = await Promise.all([
      // 1. KPIs
      this.prisma.order.aggregate({
        _count: { _all: true },
        _sum: { amount: true },
        where: baseWhere,
      }),

      // 2. Par restaurant
      this.prisma.order.groupBy({
        by: ['restaurant_id'],
        _count: { _all: true },
        _sum: { amount: true },
        where: baseWhere,
        orderBy: { _sum: { amount: 'desc' } },
      }),

      // 3. Par source
      this.prisma.order.groupBy({
        by: ['auto'],
        _count: { _all: true },
        _sum: { amount: true },
        where: baseWhere,
      }),

      // 4. Par type
      this.prisma.order.groupBy({
        by: ['type'],
        _count: { _all: true },
        _sum: { amount: true },
        where: baseWhere,
      } as any),

      // 5. Top 10 plats
      this.prisma.orderItem.groupBy({
        by: ['dish_id'],
        _sum: { quantity: true, amount: true },
        where: { order: baseWhere },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 10,
      }),

      // 6. Avis — moyenne + count
      this.prisma.comment.aggregate({
        _avg: { rating: true },
        _count: { _all: true },
        where: {
          entity_status: EntityStatus.ACTIVE,
          created_at: dateFilter,
        },
      }),

      // 7. Avis — distribution par note
      this.prisma.comment.groupBy({
        by: ['rating'],
        _count: { _all: true },
        where: {
          entity_status: EntityStatus.ACTIVE,
          created_at: dateFilter,
        },
      }),
    ]);

    // Résoudre les noms de restaurants
    const restaurantIds = restaurantData.map((r) => r.restaurant_id);
    const restaurants = await this.prisma.restaurant.findMany({
      where: { id: { in: restaurantIds } },
      select: { id: true, name: true },
    });
    const restaurantMap = new Map(restaurants.map((r) => [r.id, r.name]));

    // Résoudre les noms de plats
    const dishIds = topDishesRaw.map((d) => d.dish_id);
    const dishes = await this.prisma.dish.findMany({
      where: { id: { in: dishIds } },
      select: { id: true, name: true, price: true, promotion_price: true, is_promotion: true },
    });
    const dishMap = new Map(dishes.map((d) => [d.id, d]));

    const totalOrders = kpiData._count._all;
    const totalRevenue = kpiData._sum.amount ?? 0;

    const typeLabels: Record<string, string> = {
      DELIVERY: 'Livraison',
      PICKUP: 'Emporter',
      TABLE: 'Sur place',
    };

    const dateLabel = `${format(dateRange.startDate, 'dd/MM/yyyy', { locale: fr })} — ${format(dateRange.endDate, 'dd/MM/yyyy', { locale: fr })}`;

    // Distribution avis
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of reviewsDistribution) {
      const rating = Math.round(r.rating);
      if (rating >= 1 && rating <= 5) {
        distribution[rating] = r._count._all;
      }
    }

    return {
      dateLabel,
      kpis: {
        totalOrders,
        averageBasket: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0,
      },
      byRestaurant: restaurantData.map((r) => ({
        name: restaurantMap.get(r.restaurant_id) ?? 'Inconnu',
        orders: r._count._all,
        revenue: r._sum.amount ?? 0,
      })),
      bySource: sourceData.map((s) => ({
        source: s.auto ? 'Application' : 'Call Center',
        orders: s._count._all,
        revenue: s._sum.amount ?? 0,
      })),
      byType: typeData.map((t) => ({
        type: t.type,
        label: typeLabels[t.type] ?? t.type,
        orders: (t._count as any)?._all ?? 0,
        revenue: (t._sum as any)?.amount ?? 0,
      })),
      topDishes: topDishesRaw.map((d) => {
        const dish = dishMap.get(d.dish_id);
        const quantity = d._sum.quantity ?? 0;
        const revenue = d._sum.amount ?? 0;
        const actualUnitPrice = quantity > 0 ? Math.round(revenue / quantity) : 0;
        return {
          name: dish?.name ?? 'Plat inconnu',
          quantity,
          revenue,
          isPromotion: dish?.is_promotion ?? false,
          promotionPrice: dish?.promotion_price ?? null,
          price: actualUnitPrice, // Prix unitaire réel (CA / quantité)
          originalPrice: dish?.price ?? 0, // Prix catalogue
        };
      }),
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

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });

      const pdfBuffer = await page.pdf({
        format: 'A4',
        landscape: true,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
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
    const fmtPrice = (n: number) => new Intl.NumberFormat('fr-FR').format(Math.round(n));
    const totalSourceOrders = data.bySource.reduce((a, b) => a + b.orders, 0);

    const stars = (rating: number) => {
      const full = Math.round(rating);
      return '★'.repeat(full) + '☆'.repeat(5 - full);
    };

    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1a1a1a; background: #fff; font-size: 12px; }
    .header { background: linear-gradient(135deg, #F17922, #e06816); color: #fff; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 22px; font-weight: 700; }
    .header .date { font-size: 13px; opacity: 0.9; }
    .content { padding: 20px 30px; }
    .section { margin-bottom: 22px; }
    .section-title { font-size: 14px; font-weight: 700; color: #F17922; margin-bottom: 10px; border-bottom: 2px solid #F17922; padding-bottom: 4px; }

    .kpi-grid { display: flex; gap: 16px; margin-bottom: 22px; }
    .kpi-card { flex: 1; background: #f8f9fa; border-radius: 10px; padding: 16px; text-align: center; border: 1px solid #e9ecef; }
    .kpi-value { font-size: 28px; font-weight: 800; color: #F17922; }
    .kpi-label { font-size: 11px; color: #6c757d; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }

    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th { background: #f8f9fa; color: #495057; font-weight: 600; text-align: left; padding: 8px 10px; border-bottom: 2px solid #dee2e6; }
    td { padding: 7px 10px; border-bottom: 1px solid #f0f0f0; }
    tr:hover td { background: #fff8f2; }
    .text-right { text-align: right; }
    .text-center { text-align: center; }

    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
    .badge-promo { background: #fff3cd; color: #856404; }
    .badge-app { background: #d4edda; color: #155724; }
    .badge-call { background: #d1ecf1; color: #0c5460; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }

    .stars { color: #F17922; font-size: 14px; letter-spacing: 2px; }
    .review-bar { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
    .review-bar-fill { height: 8px; background: #F17922; border-radius: 4px; }
    .review-bar-bg { flex: 1; height: 8px; background: #e9ecef; border-radius: 4px; overflow: hidden; }

    .footer { text-align: center; color: #adb5bd; font-size: 10px; padding: 12px; border-top: 1px solid #e9ecef; margin-top: 10px; }

    .pct-bar { display: inline-block; height: 6px; background: #F17922; border-radius: 3px; margin-right: 6px; vertical-align: middle; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Rapport Marketing Livraison — Chicken Nation</h1>
      <div class="date">${data.dateLabel}</div>
    </div>
  </div>

  <div class="content">
    <!-- KPIs -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-value">${fmtPrice(data.kpis.totalOrders)}</div>
        <div class="kpi-label">Commandes</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${fmtPrice(data.kpis.averageBasket)} <span style="font-size:14px">FCFA</span></div>
        <div class="kpi-label">Panier moyen</div>
      </div>
    </div>

    <div class="grid-2">
      <!-- Par Restaurant -->
      <div class="section">
        <div class="section-title">Répartition par Restaurant</div>
        <table>
          <thead><tr><th>Restaurant</th><th class="text-center">Commandes</th><th class="text-right">CA</th></tr></thead>
          <tbody>
            ${data.byRestaurant.map((r) => `
              <tr>
                <td>${r.name}</td>
                <td class="text-center">${r.orders}</td>
                <td class="text-right">${fmtPrice(r.revenue)} FCFA</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Par Source -->
      <div class="section">
        <div class="section-title">Répartition par Source</div>
        <table>
          <thead><tr><th>Source</th><th class="text-center">Commandes</th><th class="text-center">%</th><th class="text-right">CA</th></tr></thead>
          <tbody>
            ${data.bySource.map((s) => {
              const pct = totalSourceOrders > 0 ? Math.round((s.orders / totalSourceOrders) * 100) : 0;
              return `
              <tr>
                <td><span class="badge ${s.source === 'Application' ? 'badge-app' : 'badge-call'}">${s.source}</span></td>
                <td class="text-center">${s.orders}</td>
                <td class="text-center"><span class="pct-bar" style="width:${pct}px"></span>${pct}%</td>
                <td class="text-right">${fmtPrice(s.revenue)} FCFA</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Top 10 Plats -->
    <div class="section">
      <div class="section-title">Top 10 Plats Vendus (Livraison)</div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Plat</th>
            <th class="text-center">Quantité</th>
            <th class="text-right">Prix unitaire</th>
            <th class="text-right">CA généré</th>
          </tr>
        </thead>
        <tbody>
          ${data.topDishes.map((d, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>
                ${d.name}
                ${d.isPromotion ? `<span class="badge badge-promo">Promo ${d.promotionPrice ? fmtPrice(d.promotionPrice) + ' FCFA' : ''}</span>` : ''}
              </td>
              <td class="text-center">${d.quantity}</td>
              <td class="text-right">${fmtPrice(d.price)} FCFA</td>
              <td class="text-right">${fmtPrice(d.revenue)} FCFA</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Avis Clients -->
    <div class="section">
      <div class="section-title">Avis Clients</div>
      <div style="display:flex; align-items:center; gap:30px;">
        <div style="text-align:center;">
          <div class="stars">${stars(data.reviews.average)}</div>
          <div style="font-size:22px; font-weight:800; color:#F17922; margin-top:4px;">${data.reviews.average.toFixed(1)}/5</div>
          <div style="font-size:11px; color:#6c757d;">${data.reviews.total} avis</div>
        </div>
        <div style="flex:1;">
          ${[5, 4, 3, 2, 1].map((n) => {
            const count = data.reviews.distribution[n] || 0;
            const pct = data.reviews.total > 0 ? Math.round((count / data.reviews.total) * 100) : 0;
            return `
            <div class="review-bar">
              <span style="width:14px; text-align:center; font-weight:600;">${n}</span>
              <span style="color:#F17922;">★</span>
              <div class="review-bar-bg"><div class="review-bar-fill" style="width:${pct}%"></div></div>
              <span style="width:30px; text-align:right; font-size:10px; color:#6c757d;">${count}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>
  </div>

  <div class="footer">
    Rapport généré automatiquement par Chicken Nation — ${format(new Date(), "dd/MM/yyyy 'à' HH:mm", { locale: fr })}
  </div>
</body>
</html>`;
  }
}
