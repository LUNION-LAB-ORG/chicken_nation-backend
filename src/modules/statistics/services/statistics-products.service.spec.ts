/**
 * Ventes par canal : les plats commandés sur le site (channel WEB) forment un
 * canal « Site web » à part, plus compté « App ». Le reste suit `auto`.
 * Prisma simulé, aucune base.
 */
import { OrderChannel } from '@prisma/client';
import { StatisticsProductsService } from './statistics-products.service';

const PERIODE = { startDate: '2026-10-01', endDate: '2026-10-02' };
const plat = (price: number) => ({ price, promotion_price: null, is_promotion: false });

describe('StatisticsProductsService.getChannelBreakdown', () => {
  function monter() {
    const prisma = {
      orderItem: {
        findMany: jest.fn().mockResolvedValue([
          { quantity: 2, dish: plat(1000), order: { auto: true, channel: null } },
          { quantity: 3, dish: plat(2000), order: { auto: true, channel: OrderChannel.WEB } },
          { quantity: 1, dish: plat(5000), order: { auto: false, channel: null } },
          { quantity: 4, dish: plat(500), order: { auto: true, channel: OrderChannel.APP } },
        ]),
      },
    };
    return { prisma, service: new StatisticsProductsService(prisma as never) };
  }

  it('lit le canal de la commande de chaque ligne', async () => {
    const { prisma, service } = monter();
    await service.getChannelBreakdown(PERIODE);
    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.orderItem.findMany.mock.calls[0][0].select.order).toEqual({
      select: { auto: true, channel: true },
    });
  });

  it('range le site web à part et garde les totaux', async () => {
    const { service } = monter();
    const r = await service.getChannelBreakdown(PERIODE);

    expect(r).toEqual({
      appSold: 6,
      appRevenue: 4000,
      webSold: 3,
      webRevenue: 6000,
      callCenterSold: 1,
      callCenterRevenue: 5000,
      appPercentage: 60,
      webPercentage: 30,
      callCenterPercentage: 10,
      totalSold: 10,
    });
  });

  it('renvoie des zéros sans vente', async () => {
    const prisma = { orderItem: { findMany: jest.fn().mockResolvedValue([]) } };
    const r = await new StatisticsProductsService(prisma as never).getChannelBreakdown(PERIODE);
    expect(r).toMatchObject({ webSold: 0, webRevenue: 0, webPercentage: 0, totalSold: 0 });
  });
});
