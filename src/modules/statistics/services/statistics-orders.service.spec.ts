/**
 * Statistiques des commandes par canal : les commandes du site (channel WEB)
 * forment un canal « Site web » à part et ne sont plus comptées « App ». Les
 * commandes antérieures (channel vide) gardent la règle fondée sur `auto`.
 * Prisma simulé, aucune base.
 */
import { OrderChannel } from '@prisma/client';
import { StatisticsOrdersService } from './statistics-orders.service';

// Heures locales : le découpage par jour suit le fuseau de la machine.
const JOUR_1 = (h: number) => new Date(2026, 9, 1, h);
const JOUR_2 = (h: number) => new Date(2026, 9, 2, h);
const PERIODE = { startDate: '2026-10-01', endDate: '2026-10-02' };

function monterService(prisma: Record<string, unknown>) {
  return new StatisticsOrdersService(prisma as never);
}

describe('StatisticsOrdersService.getOrdersByChannel', () => {
  const commandes = [
    // c1 avait déjà commandé avant la période : récurrent
    { id: 'o1', customer_id: 'c1', auto: true, channel: null, net_amount: 1000, created_at: JOUR_1(10) },
    { id: 'o2', customer_id: 'c2', auto: true, channel: OrderChannel.WEB, net_amount: 2000, created_at: JOUR_1(12) },
    { id: 'o3', customer_id: 'c3', auto: false, channel: null, net_amount: 3000, created_at: JOUR_2(9) },
    { id: 'o4', customer_id: 'c1', auto: true, channel: OrderChannel.WEB, net_amount: 4000, created_at: JOUR_2(15) },
  ];

  function monter() {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue(commandes),
        groupBy: jest.fn().mockResolvedValue([{ customer_id: 'c1', _count: 3 }]),
      },
    };
    return { prisma, service: monterService(prisma) };
  }

  it('lit le canal de chaque commande', async () => {
    const { prisma, service } = monter();
    await service.getOrdersByChannel(PERIODE);
    expect(prisma.order.findMany.mock.calls[0][0].select).toMatchObject({ auto: true, channel: true });
  });

  it('compte le site web à part, sans le compter « App »', async () => {
    const { service } = monter();
    const r = await service.getOrdersByChannel(PERIODE);

    expect(r.app).toEqual({
      totalOrders: 1, revenue: 1000, averageBasket: 1000,
      newClientsOrders: 0, recurringClientsOrders: 1, newClientsRate: 0,
    });
    expect(r.web).toEqual({
      totalOrders: 2, revenue: 6000, averageBasket: 3000,
      newClientsOrders: 1, recurringClientsOrders: 1, newClientsRate: 50,
    });
    expect(r.callCenter).toEqual({
      totalOrders: 1, revenue: 3000, averageBasket: 3000,
      newClientsOrders: 1, recurringClientsOrders: 0, newClientsRate: 100,
    });
    expect(r.app.totalOrders + r.web.totalOrders + r.callCenter.totalOrders).toBe(commandes.length);
  });

  it('ventile la tendance du jour sur les trois canaux', async () => {
    const { service } = monter();
    const { dailyTrend } = await service.getOrdersByChannel(PERIODE);

    expect(dailyTrend).toHaveLength(2);
    expect(dailyTrend[0]).toMatchObject({
      date: '2026-10-01',
      newViaApp: 0, recurringViaApp: 1,
      newViaWeb: 1, recurringViaWeb: 0,
      newViaCallCenter: 0, recurringViaCallCenter: 0,
      total: 2,
    });
    expect(dailyTrend[1]).toMatchObject({
      date: '2026-10-02',
      newViaApp: 0, recurringViaApp: 0,
      newViaWeb: 0, recurringViaWeb: 1,
      newViaCallCenter: 1, recurringViaCallCenter: 0,
      total: 2,
    });
  });

  it('renvoie un canal web vide quand il n\'y a aucune commande', async () => {
    const prisma = { order: { findMany: jest.fn().mockResolvedValue([]), groupBy: jest.fn() } };
    const r = await monterService(prisma).getOrdersByChannel(PERIODE);
    expect(r.web.totalOrders).toBe(0);
    expect(r.dailyTrend).toEqual([]);
  });
});

describe('StatisticsOrdersService.getOrdersByRestaurantAndSource', () => {
  it('groupe aussi par canal et ajoute la colonne web', async () => {
    const prisma = {
      order: {
        groupBy: jest.fn().mockResolvedValue([
          { restaurant_id: 'r1', auto: true, channel: null, _count: 5 },
          { restaurant_id: 'r1', auto: true, channel: OrderChannel.WEB, _count: 2 },
          { restaurant_id: 'r1', auto: false, channel: null, _count: 1 },
          { restaurant_id: 'r2', auto: true, channel: OrderChannel.APP, _count: 3 },
        ]),
      },
      restaurant: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'r1', name: 'Riviera' },
          { id: 'r2', name: 'Cocody' },
        ]),
      },
    };
    const r = await monterService(prisma).getOrdersByRestaurantAndSource(PERIODE);

    expect(prisma.order.groupBy.mock.calls[0][0].by).toEqual(['restaurant_id', 'auto', 'channel']);
    expect(r.items).toEqual([
      { restaurantId: 'r1', restaurantName: 'Riviera', app: 5, web: 2, callCenter: 1, total: 8 },
      { restaurantId: 'r2', restaurantName: 'Cocody', app: 3, web: 0, callCenter: 0, total: 3 },
    ]);
  });
});
