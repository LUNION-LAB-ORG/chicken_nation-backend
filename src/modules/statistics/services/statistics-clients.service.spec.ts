/**
 * Statistiques clients par canal : les clients du site (channel WEB) sont
 * comptés à part, et le canal préféré peut valoir WEB. Les commandes
 * antérieures (channel vide) gardent la règle fondée sur `auto`.
 * Prisma et cache simulés, aucune base.
 */
import { OrderChannel } from '@prisma/client';
import { StatisticsClientsService } from './statistics-clients.service';

const PERIODE = { startDate: '2026-10-01', endDate: '2026-10-02' };

function monterService(prisma: Record<string, unknown>) {
  return new StatisticsClientsService(prisma as never, {} as never);
}

describe('StatisticsClientsService.getClientsOverview', () => {
  it('compte les clients du site web à part', async () => {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([
          { customer_id: 'c1', auto: true, channel: null, net_amount: 1000 },
          { customer_id: 'c1', auto: true, channel: OrderChannel.WEB, net_amount: 2000 },
          { customer_id: 'c2', auto: true, channel: OrderChannel.WEB, net_amount: 3000 },
          { customer_id: 'c3', auto: false, channel: null, net_amount: 4000 },
        ]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      customer: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const r = await monterService(prisma).getClientsOverview(PERIODE);

    expect(prisma.order.findMany.mock.calls[0][0].select).toMatchObject({ auto: true, channel: true });
    // c1 a commandé sur l'appli et sur le site : compté dans les deux
    expect(r).toMatchObject({ appClients: 1, webClients: 2, callCenterClients: 1, totalClients: 3 });
  });
});

describe('StatisticsClientsService.getTopClients', () => {
  it('groupe par canal et peut désigner le site comme canal préféré', async () => {
    const groupBy = jest
      .fn()
      // Top clients de la période
      .mockResolvedValueOnce([
        { customer_id: 'c1', _count: { _all: 3 }, _sum: { net_amount: 9000 }, _avg: { net_amount: 3000 }, _max: { created_at: null } },
        { customer_id: 'c2', _count: { _all: 2 }, _sum: { net_amount: 4000 }, _avg: { net_amount: 2000 }, _max: { created_at: null } },
      ])
      // Commandes par client et par canal
      .mockResolvedValueOnce([
        { customer_id: 'c1', auto: true, channel: OrderChannel.WEB, _count: { _all: 2 } },
        { customer_id: 'c1', auto: true, channel: null, _count: { _all: 1 } },
        { customer_id: 'c2', auto: true, channel: OrderChannel.WEB, _count: { _all: 1 } },
        { customer_id: 'c2', auto: false, channel: null, _count: { _all: 1 } },
      ]);
    const prisma = {
      order: { groupBy },
      customer: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const r = await monterService(prisma).getTopClients(PERIODE);

    expect(groupBy.mock.calls[1][0].by).toEqual(['customer_id', 'auto', 'channel']);
    expect(r.items.map((i) => i.preferredChannel)).toEqual(['WEB', 'MIXED']);
  });
});
