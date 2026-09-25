import { NotFoundException } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import { UserScopedCacheInterceptor } from 'src/modules/order/interceptors/user-scoped-cache.interceptor';
import { FavoriteController } from '../controllers/favorite.controller';
import { FAVORIS_LIMITE_MAX, FavoriteService, paginationFavoris } from './favorite.service';

function monter() {
  const prisma = {
    favorite: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(25),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    dish: { findUnique: jest.fn() },
  };
  return { prisma, service: new FavoriteService(prisma as unknown as PrismaService) };
}

describe('paginationFavoris', () => {
  it('convertit les chaînes reçues en nombres et borne la taille', () => {
    expect(paginationFavoris('2', '10')).toEqual({ page: 2, limit: 10 });
    expect(paginationFavoris(undefined, undefined)).toEqual({ page: 1, limit: 10 });
    expect(paginationFavoris('0', '-3')).toEqual({ page: 1, limit: 10 });
    expect(paginationFavoris('abc', '100000')).toEqual({ page: 1, limit: FAVORIS_LIMITE_MAX });
  });
});

describe('FavoriteService.findByCustomer', () => {
  it('renvoie une page numérique : la page suivante de l’application vaut 2, pas « 11 »', async () => {
    const { prisma, service } = monter();
    const res = await service.findByCustomer('c1', '1', '10');
    expect(res.meta).toEqual({ total: 25, page: 1, limit: 10, totalPages: 3 });
    expect(res.meta.page + 1).toBe(2);
    expect(prisma.favorite.findMany.mock.calls[0][0]).toMatchObject({
      where: { customer_id: 'c1' },
      skip: 0,
      take: 10,
    });
  });
});

describe('FavoriteService, favori d’un autre client', () => {
  it('refuse la modification et la suppression du favori d’un autre client', async () => {
    const { prisma, service } = monter();
    prisma.favorite.findFirst.mockResolvedValue(null);

    await expect(service.update('c2', 'f1', { dish_id: 'd2' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove('c2', 'f1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.favorite.findFirst).toHaveBeenCalledWith({
      where: { id: 'f1', customer_id: 'c2' },
      select: { id: true },
    });
    expect(prisma.favorite.update).not.toHaveBeenCalled();
    expect(prisma.favorite.delete).not.toHaveBeenCalled();
  });

  it('laisse le propriétaire supprimer son favori', async () => {
    const { prisma, service } = monter();
    prisma.favorite.findFirst.mockResolvedValue({ id: 'f1' });
    await service.remove('c1', 'f1');
    expect(prisma.favorite.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });
  });
});

describe('FavoriteController', () => {
  it('met en cache par utilisateur, et non par URL', () => {
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, FavoriteController)).toEqual([UserScopedCacheInterceptor]);
  });

  it('lit les favoris du jeton, jamais ceux de l’identifiant de l’URL', async () => {
    const service = { findByCustomer: jest.fn().mockResolvedValue({}), update: jest.fn(), remove: jest.fn() };
    const controller = new FavoriteController(service as unknown as FavoriteService);
    const req = { user: { id: 'c1' } } as unknown as Request;

    await controller.findByCustomer(req, 'c2', '1', '10');
    expect(service.findByCustomer).toHaveBeenCalledWith('c1', '1', '10');

    await controller.remove(req, 'f1');
    expect(service.remove).toHaveBeenCalledWith('c1', 'f1');
    await controller.update(req, 'f1', { dish_id: 'd1' });
    expect(service.update).toHaveBeenCalledWith('c1', 'f1', { dish_id: 'd1' });
  });
});
