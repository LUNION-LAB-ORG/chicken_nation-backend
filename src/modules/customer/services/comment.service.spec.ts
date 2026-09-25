import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CommentService } from './comment.service';

const date = new Date('2026-09-01T10:00:00Z');

function monter() {
  const prisma = {
    comment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _avg: { rating: null } }),
    },
    dish: {
      findFirst: jest.fn().mockResolvedValue({ id: 'd1', name: 'Burger' }),
    },
  };
  return { prisma, service: new CommentService(prisma as unknown as PrismaService) };
}

describe('CommentService.getBestComments (route publique du site)', () => {
  it('lit la liste blanche, plafonne limit et ne renvoie que prénom et initiale', async () => {
    const { prisma, service } = monter();
    prisma.comment.findMany.mockResolvedValue([
      {
        id: 'a1',
        message: 'Parfait',
        rating: 5,
        created_at: date,
        customer: { first_name: 'Awa', last_name: 'Koné' },
      },
    ]);
    prisma.comment.count.mockResolvedValue(1);

    const res = await service.getBestComments({ page: 1, limit: 100000 });

    const requete = prisma.comment.findMany.mock.calls[0][0];
    expect(requete.take).toBe(50);
    expect(requete.include).toBeUndefined();
    expect(requete.select.customer).toEqual({ select: { first_name: true, last_name: true } });
    expect(requete.where).toEqual({ entity_status: 'ACTIVE', site_visible: true });

    expect(res.data).toEqual([
      { id: 'a1', message: 'Parfait', rating: 5, created_at: date, customer: { first_name: 'Awa', last_name: 'K' } },
    ]);
    expect(res.meta).toEqual({ total: 1, page: 1, limit: 50, totalPages: 1 });
  });
});

describe('CommentService.getCommentById (personnel)', () => {
  const avis = () => ({
    id: 'a1',
    message: 'Bien',
    rating: 4,
    customer_id: 'c1',
    order_id: 'o1',
    created_at: date,
    updated_at: date,
    site_visible: false,
    customer: { id: 'c1', first_name: 'Awa', last_name: 'Koné', phone: '+2250700000000', image: null },
    order: { id: 'o1', reference: 'CN-0001', created_at: date, restaurant_id: 'r1' },
  });

  it("refuse l'avis d'une commande d'un autre restaurant", async () => {
    const { prisma, service } = monter();
    prisma.comment.findFirst.mockResolvedValue(avis());
    await expect(service.getCommentById('a1', 'r2')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sert le personnel du bon restaurant et le siège, sans exposer le restaurant', async () => {
    const { prisma, service } = monter();
    prisma.comment.findFirst.mockResolvedValue(avis());
    const duRestaurant = await service.getCommentById('a1', 'r1');
    expect(duRestaurant.order).toEqual({ id: 'o1', reference: 'CN-0001', created_at: date });

    prisma.comment.findFirst.mockResolvedValue(avis());
    const duSiege = await service.getCommentById('a1', undefined);
    expect(duSiege.id).toBe('a1');
    expect(JSON.stringify(duSiege)).not.toContain('restaurant_id');
  });
});

describe('CommentService.getDishComments (fiche plat du personnel)', () => {
  it('limite un compte de restaurant à SON restaurant et plafonne limit à 100', async () => {
    const { prisma, service } = monter();
    prisma.comment.aggregate.mockResolvedValue({ _count: { _all: 3 }, _avg: { rating: 4.333 } });

    const res = await service.getDishComments('d1', { page: 1, limit: 100000 }, 'r1');

    const requete = prisma.comment.findMany.mock.calls[0][0];
    expect(requete.take).toBe(100);
    expect(requete.where.order.restaurant_id).toBe('r1');
    expect(requete.include.customer.select.phone).toBeUndefined();
    expect(prisma.comment.aggregate.mock.calls[0][0].where.order.restaurant_id).toBe('r1');
    expect(res.total_comments).toBe(3);
    expect(res.average_rating).toBe(4.3);
  });

  it('siège : tous les restaurants', async () => {
    const { prisma, service } = monter();
    await service.getDishComments('d1', { page: 1, limit: 10 }, undefined);
    expect(prisma.comment.findMany.mock.calls[0][0].where.order.restaurant_id).toBeUndefined();
  });
});

describe('CommentService, listes du personnel par client et par commande', () => {
  it('plafonnent limit à 100, comme GET /comments', async () => {
    const { prisma, service } = monter();

    await service.getCustomerComments('c1', { page: 1, limit: 100000 });
    expect(prisma.comment.findMany.mock.calls[0][0].take).toBe(100);

    await service.getOrderComments('o1', { page: 1, limit: 100000 });
    expect(prisma.comment.findMany.mock.calls[1][0].take).toBe(100);

    await service.getCustomerComments('c1', { page: 2, limit: 20 });
    expect(prisma.comment.findMany.mock.calls[2][0]).toMatchObject({ take: 20, skip: 20 });
  });
});
