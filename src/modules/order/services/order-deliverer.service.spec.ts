import { CourseStatut, DeliveryStatut } from '@prisma/client';

import { OrderDelivererService } from './order-deliverer.service';

/**
 * Historique des commandes du livreur : le numéro du client n'y reste que
 * pour une livraison encore en cours, dans une course encore ouverte.
 */

type Ligne = {
  id: string;
  phone: string | null;
  fullname: string;
  customer: { id: string; phone: string | null } | null;
  delivery: { statut: DeliveryStatut; course: { statut: CourseStatut } } | null;
};

function ligne(id: string, statutLivraison: DeliveryStatut, statutCourse: CourseStatut): Ligne {
  return {
    id,
    phone: `+225070000${id}`,
    fullname: 'Awa Koné',
    customer: { id: `c${id}`, phone: `+225010000${id}` },
    delivery: { statut: statutLivraison, course: { statut: statutCourse } },
  };
}

function service(lignes: Ligne[]) {
  const prisma = {
    order: {
      findMany: jest.fn().mockResolvedValue(lignes),
      count: jest.fn().mockResolvedValue(lignes.length),
    },
  };
  return { service: new OrderDelivererService(prisma as never), prisma };
}

describe('OrderDelivererService.getHistory', () => {
  it('course en cours : le numéro reste pour une livraison pas encore finie', async () => {
    const { service: s } = service([ligne('01', DeliveryStatut.IN_ROUTE, CourseStatut.IN_DELIVERY)]);
    const r = await s.getHistory('d1', {} as never);
    expect(r.items[0].phone).toBe('+22507000001');
    expect(r.items[0].customer?.phone).toBe('+22501000001');
  });

  it('course terminée : plus aucun numéro du client', async () => {
    const { service: s } = service([
      ligne('01', DeliveryStatut.DELIVERED, CourseStatut.COMPLETED),
      ligne('02', DeliveryStatut.FAILED, CourseStatut.COMPLETED),
      ligne('03', DeliveryStatut.IN_ROUTE, CourseStatut.CANCELLED),
      ligne('04', DeliveryStatut.PENDING, CourseStatut.EXPIRED),
    ]);
    const r = await s.getHistory('d1', {} as never);
    expect(r.items.map((c) => [c.phone, c.customer?.phone])).toEqual([
      [null, null],
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(r.items[0].fullname).toBe('Awa Koné');
  });

  it('livraison terminée dans une course encore en cours : absent pour cet arrêt, présent pour les autres', async () => {
    const { service: s } = service([
      ligne('01', DeliveryStatut.DELIVERED, CourseStatut.IN_DELIVERY),
      ligne('02', DeliveryStatut.ARRIVED, CourseStatut.IN_DELIVERY),
    ]);
    const r = await s.getHistory('d1', {} as never);
    expect(r.items.map((c) => c.phone)).toEqual([null, '+22507000002']);
    expect(r.items.map((c) => c.customer?.phone)).toEqual([null, '+22501000002']);
  });

  it('client sans compte : le numéro de la commande part quand même', async () => {
    const l = ligne('01', DeliveryStatut.DELIVERED, CourseStatut.COMPLETED);
    l.customer = null;
    const { service: s } = service([l]);
    const r = await s.getHistory('d1', {} as never);
    expect(r.items[0].phone).toBeNull();
    expect(r.items[0].customer).toBeNull();
  });

  it('lit le statut de la livraison et de la course, sans le rendre', async () => {
    const { service: s, prisma } = service([ligne('01', DeliveryStatut.DELIVERED, CourseStatut.COMPLETED)]);
    const r = await s.getHistory('d1', {} as never);
    const select = (prisma.order.findMany.mock.calls[0][0] as { select: Record<string, unknown> }).select;
    expect(select.delivery).toEqual({ select: { statut: true, course: { select: { statut: true } } } });
    expect(r.items[0]).not.toHaveProperty('delivery');
  });
});
