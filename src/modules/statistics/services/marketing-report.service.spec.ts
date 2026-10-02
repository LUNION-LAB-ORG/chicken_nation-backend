/**
 * Rapport marketing : le site web a sa ligne dans « Répartition par source »
 * et sa colonne dans « Détail par restaurant ». Ses commandes ne sont plus
 * comptées « Application ». Services et Prisma simulés, aucun PDF produit.
 */
import { OrderChannel } from '@prisma/client';
import { MarketingReportService } from './marketing-report.service';

const canal = (totalOrders: number, revenue: number, newClientsRate: number) => ({
  totalOrders,
  revenue,
  averageBasket: totalOrders > 0 ? revenue / totalOrders : 0,
  newClientsOrders: 0,
  recurringClientsOrders: totalOrders,
  newClientsRate,
});

function monter() {
  const prisma = {
    order: {
      groupBy: jest.fn().mockResolvedValue([
        { restaurant_id: 'r1', auto: true, channel: null, _count: { _all: 6 }, _sum: { net_amount: 60000 } },
        { restaurant_id: 'r1', auto: true, channel: OrderChannel.WEB, _count: { _all: 2 }, _sum: { net_amount: 30000 } },
        { restaurant_id: 'r1', auto: false, channel: null, _count: { _all: 2 }, _sum: { net_amount: 10000 } },
      ]),
      aggregate: jest.fn().mockResolvedValue({
        _sum: { amount: 0, discount: 0, tax: 0, delivery_fee: 0 },
      }),
    },
    restaurant: { findMany: jest.fn().mockResolvedValue([{ id: 'r1', name: 'Riviera' }]) },
  };
  const ordersService = {
    getOrdersOverview: jest.fn().mockResolvedValue({
      totalRevenue: 100000, totalOrders: 10, averageBasket: 10000,
      cancellationRate: 0, cancelledOrders: 0, evolution: '0.0%', byType: [],
    }),
    getOrdersByChannel: jest.fn().mockResolvedValue({
      app: canal(6, 60000, 10),
      web: canal(2, 30000, 50),
      callCenter: canal(2, 10000, 0),
      dailyTrend: [],
    }),
  };
  const productsService = { getTopProducts: jest.fn().mockResolvedValue({ items: [] }) };
  const clientsService = {
    getClientsOverview: jest.fn().mockResolvedValue({ newClients: 0, recurringClients: 0, newClientsRate: 0 }),
    getBasketComparison: jest.fn().mockResolvedValue({ newClientsBasket: 0, recurringClientsBasket: 0 }),
    getRevenueConcentration: jest.fn().mockResolvedValue({ top10Percentage: 0, top20Percentage: 0 }),
  };
  const service = new MarketingReportService(
    prisma as never,
    ordersService as never,
    productsService as never,
    clientsService as never,
  );
  return { prisma, service };
}

describe('MarketingReportService : canal site web', () => {
  it('ventile le détail par restaurant sur trois canaux', async () => {
    const { prisma, service } = monter();
    const data = await service.collectReportData({ startDate: '2026-10-01', endDate: '2026-10-02' });

    expect(prisma.order.groupBy.mock.calls[0][0].by).toEqual(['restaurant_id', 'auto', 'channel']);
    expect(data.byRestaurant.items[0]).toMatchObject({
      name: 'Riviera', appOrders: 6, webOrders: 2, callOrders: 2, totalOrders: 10,
    });
    expect(data.byRestaurant).toMatchObject({ totalApp: 6, totalWeb: 2, totalCall: 2, totalOrders: 10 });
  });

  it('calcule la part de chaque source sur les trois canaux', async () => {
    const { service } = monter();
    const data = await service.collectReportData({ startDate: '2026-10-01', endDate: '2026-10-02' });

    expect(data.channel.app).toMatchObject({ orders: 6, percentage: 60 });
    expect(data.channel.web).toMatchObject({ orders: 2, percentage: 20, revenue: 30000, newRate: 50 });
    expect(data.channel.call).toMatchObject({ orders: 2, percentage: 20 });
  });

  it('affiche « Site web » dans les deux tableaux du PDF', async () => {
    const { service } = monter();
    const data = await service.collectReportData({ startDate: '2026-10-01', endDate: '2026-10-02' });
    const html: string = (service as unknown as { buildHtml: (d: typeof data) => string }).buildHtml(data);

    expect(html).toContain('<th class="text-center">Site web</th>');
    expect(html).toContain('<span class="badge badge-web">Site web</span>');
  });
});
