import { ForbiddenException } from '@nestjs/common';
import { User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { DishService } from 'src/modules/menu/services/dish.service';
import { RestaurantService } from '../services/restaurant.service';
import { RestaurantController } from './restaurant.controller';

function monter() {
  const service = {
    getRestaurantUsers: jest.fn().mockResolvedValue([]),
    getRestaurantManager: jest.fn().mockResolvedValue(null),
    getRestaurantCustomers: jest.fn().mockResolvedValue([]),
  };
  const controller = new RestaurantController(
    service as unknown as RestaurantService,
    {} as DishService,
  );
  return { service, controller };
}

const req = (user: Partial<User>) => ({ user }) as unknown as Request;
const manager = { role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: 'r1' };
const admin = { role: UserRole.ADMIN, type: UserType.BACKOFFICE, restaurant_id: null };

describe('RestaurantController, cloisonnement des routes du personnel', () => {
  it("GET /restaurants/:id/users : refusé pour le personnel d'un autre restaurant", async () => {
    const { service, controller } = monter();
    await expect(controller.getRestaurantUsers(req(manager), 'r2')).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.getRestaurantUsers).not.toHaveBeenCalled();

    await controller.getRestaurantUsers(req(manager), 'r1');
    await controller.getRestaurantUsers(req(admin), 'r2');
    expect(service.getRestaurantUsers).toHaveBeenCalledTimes(2);
  });

  it("GET /restaurants/:id/manager : refusé pour le personnel d'un autre restaurant", async () => {
    const { service, controller } = monter();
    await expect(controller.getRestaurantManager(req(manager), 'r2')).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.getRestaurantManager).not.toHaveBeenCalled();

    await controller.getRestaurantManager(req(admin), 'r2');
    expect(service.getRestaurantManager).toHaveBeenCalledWith('r2');
  });

  it('GET /restaurants/:id/clients : cloisonné, recherche et page transmises au service', async () => {
    const { service, controller } = monter();
    await expect(
      controller.getRestaurantCustomers(req(manager), 'r2', 'awa', '1', '50'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await controller.getRestaurantCustomers(req(manager), 'r1', 'awa', '2', '20');
    expect(service.getRestaurantCustomers).toHaveBeenCalledWith('r1', { search: 'awa', page: '2', limit: '20' });
  });
});

describe('RestaurantService.getRestaurantCustomers', () => {
  it('page bornée, champs limités, clients actifs du restaurant', async () => {
    const prisma = { customer: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new RestaurantService(prisma as never, {} as never, {} as never, {} as never);

    await service.getRestaurantCustomers('r1', { search: 'Awa', page: '1', limit: '100000' });

    const requete = prisma.customer.findMany.mock.calls[0][0];
    expect(requete.take).toBe(100);
    expect(requete.skip).toBe(0);
    expect(requete.select).toEqual({
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      image: true,
    });
    expect(requete.where.entity_status).toBe('ACTIVE');
    expect(requete.where.orders).toEqual({ some: { restaurant_id: 'r1' } });
    expect(requete.where.AND).toHaveLength(1);
  });

  it('restaurant sans gérant : null, sans requête Prisma invalide', async () => {
    const prisma = {
      restaurant: { findFirst: jest.fn().mockResolvedValue({ id: 'r1', manager: null }) },
      user: { findUnique: jest.fn() },
    };
    const service = new RestaurantService(prisma as never, {} as never, {} as never, {} as never);
    await expect(service.getRestaurantManager('r1')).resolves.toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
