/**
 * Statistiques des commandes par canal : les commandes du site (channel WEB)
 * forment un canal « Site web » à part et ne sont plus comptées « App ». Les
 * commandes antérieures (channel vide) gardent la règle fondée sur `auto`.
 * Prisma simulé, aucune base.
 */
import { EntityStatus, OrderChannel, OrderStatus, OrderType } from '@prisma/client';
import { estVente, FILTRE_COMMANDE_ACCEPTEE, FILTRE_VENTE } from '../helpers/statistics.helper';
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

describe('commandes comptées dès leur acceptation (écran Statistiques Commandes)', () => {
  const commande = (o: Record<string, unknown>) => ({
    id: 'o',
    restaurant_id: 'r1',
    customer_id: 'c1',
    auto: true,
    channel: null,
    net_amount: 1000,
    paied: false,
    status: OrderStatus.ACCEPTED,
    type: OrderType.DELIVERY,
    ready_at: null,
    collected_at: null,
    created_at: JOUR_1(12),
    ...o,
  });

  it('la règle : acceptée jusqu’à terminée, jamais en attente, annulée ni supprimée', () => {
    const statuts: OrderStatus[] = FILTRE_COMMANDE_ACCEPTEE.status.in;

    expect(statuts).not.toContain(OrderStatus.PENDING);
    expect(statuts).not.toContain(OrderStatus.CANCELLED);
    expect(statuts).toEqual(expect.arrayContaining([
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PROGRESS,
      OrderStatus.READY,
      OrderStatus.PICKED_UP,
      OrderStatus.COLLECTED,
      OrderStatus.COMPLETED,
    ]));
    expect(FILTRE_COMMANDE_ACCEPTEE.entity_status).toEqual({ not: EntityStatus.DELETED });
  });

  it('une vente est toujours une commande acceptée : le CA escompté contient le CA', () => {
    expect(FILTRE_COMMANDE_ACCEPTEE.status.in).toEqual(expect.arrayContaining(FILTRE_VENTE.status.in));
  });

  it('estVente suit FILTRE_VENTE', () => {
    expect(estVente({ paied: true, status: OrderStatus.COMPLETED })).toBe(true);
    expect(estVente({ paied: true, status: OrderStatus.COLLECTED })).toBe(true);
    expect(estVente({ paied: false, status: OrderStatus.COMPLETED })).toBe(false);
    expect(estVente({ paied: true, status: OrderStatus.READY })).toBe(false);
    expect(estVente({ paied: true, status: OrderStatus.CANCELLED })).toBe(false);
  });

  describe('vue d’ensemble', () => {
    function monterVue() {
      const order = {
        // Dans l'ordre du calcul : ventes, annulées, acceptées de la période précédente.
        count: jest.fn().mockResolvedValueOnce(57).mockResolvedValueOnce(2).mockResolvedValueOnce(60),
        // Ventes, ventes de la période précédente, acceptées.
        aggregate: jest
          .fn()
          .mockResolvedValueOnce({ _sum: { net_amount: 454500 }, _avg: { net_amount: 7974 } })
          .mockResolvedValueOnce({ _sum: { net_amount: 500000 } })
          .mockResolvedValueOnce({ _count: 72, _sum: { net_amount: 600000 } }),
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ type: OrderType.DELIVERY, _count: 72, _sum: { net_amount: 600000 } }]),
      };
      return { order, service: monterService({ order }) };
    }

    it('écran : compte les acceptées, le CA reste celui des ventes, le CA escompté s’ajoute', async () => {
      const { order, service } = monterVue();

      const r = await service.getOrdersOverview(PERIODE, 'acceptees');

      expect(r.totalOrders).toBe(72);
      expect(r.acceptedOrders).toBe(72);
      expect(r.completedOrders).toBe(57);
      expect(r.expectedRevenue).toBe(600000);
      expect(r.totalRevenue).toBe(454500);
      expect(r.averageBasket).toBe(7974);
      expect(r.byType[0]).toMatchObject({ count: 72, percentage: 100 });
      expect(order.groupBy.mock.calls[1][0].where.status).toEqual(FILTRE_COMMANDE_ACCEPTEE.status);
    });

    it('rapport marketing et caisse : `totalOrders` reste le nombre de ventes', async () => {
      const { order, service } = monterVue();

      const r = await service.getOrdersOverview(PERIODE);

      expect(r.totalOrders).toBe(57);
      expect(order.groupBy.mock.calls[1][0].where).toMatchObject(FILTRE_VENTE);
    });
  });

  it('tableau de bord : les volumes comptent les acceptées', async () => {
    const service = monterService({});
    const espion = (nom: keyof StatisticsOrdersService) =>
      jest.spyOn(service, nom as never).mockResolvedValue({} as never);
    const vue = espion('getOrdersOverview');
    const canal = espion('getOrdersByChannel');
    const parType = espion('getOrdersByRestaurantAndType');
    const parSource = espion('getOrdersByRestaurantAndSource');
    const temps = espion('getOrdersProcessingTime');
    espion('getLateOrders');
    espion('getRestaurantPunctuality');

    await service.getOrdersDashboard(PERIODE);

    for (const methode of [vue, canal, parType, parSource]) {
      expect(methode).toHaveBeenCalledWith(PERIODE, 'acceptees');
    }
    expect(temps).toHaveBeenCalledWith(PERIODE);
  });

  it('canaux : la commande acceptée compte, son montant n’entre dans le CA qu’une fois vendue', async () => {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([
          commande({ id: 'o1', net_amount: 1000, paied: true, status: OrderStatus.COMPLETED }),
          commande({ id: 'o2', net_amount: 9000, status: OrderStatus.IN_PROGRESS }),
        ]),
        groupBy: jest.fn().mockResolvedValue([{ customer_id: 'c1', _count: 1 }]),
      },
    };

    const r = await monterService(prisma).getOrdersByChannel(PERIODE, 'acceptees');

    expect(prisma.order.findMany.mock.calls[0][0].where.status).toEqual(FILTRE_COMMANDE_ACCEPTEE.status);
    expect(r.app).toMatchObject({ totalOrders: 2, revenue: 1000, averageBasket: 1000, recurringClientsOrders: 2 });
  });

  it('histogramme : commandes et CA escompté sur les acceptées, CA, panier et ponctualité sur les ventes', async () => {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([
          commande({
            net_amount: 2000,
            paied: true,
            status: OrderStatus.COMPLETED,
            ready_at: JOUR_1(12),
            collected_at: new Date(2026, 9, 1, 12, 30),
          }),
          // Payée mais pas finie, partie depuis longtemps : ni vente, ni retard compté.
          commande({
            net_amount: 8000,
            paied: true,
            status: OrderStatus.PICKED_UP,
            ready_at: JOUR_1(12),
            collected_at: JOUR_1(15),
          }),
        ]),
      },
      restaurant: { findMany: jest.fn().mockResolvedValue([{ id: 'r1', name: 'Riviera' }]) },
    };

    const r = await monterService(prisma).getDailyTrendByRestaurant(PERIODE);

    expect(prisma.order.findMany.mock.calls[0][0].where.status).toEqual(FILTRE_COMMANDE_ACCEPTEE.status);
    const attendu = { count: 2, expectedRevenue: 10000, revenue: 2000, avgBasket: 2000, onTimeRate: 100 };
    expect(r.data[0].byRestaurant.r1).toEqual(attendu);
    expect(r.data[0].total).toEqual(attendu);
  });
});
