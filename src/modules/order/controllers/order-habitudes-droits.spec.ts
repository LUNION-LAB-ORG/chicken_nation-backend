/**
 * Habitudes du client à la prise de commande : qui peut les lire, et sur
 * quelles commandes. Vraie garde, vraie table des droits, vrai contrôleur.
 */
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { DishAudience, EntityStatus, LoyaltyLevel, OrderStatus, OrderType, ProfileType, User, UserRole, UserType } from '@prisma/client';
import { REQUIRE_PERMISSION_KEY } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { HABITUDES_FENETRE } from '../helpers/habitudes-client.rules';
import { OrderModule } from '../order.module';
import { OrderHabitudesService } from '../services/order-habitudes.service';
import { OrderHabitudesController } from './order-habitudes.controller';
import { OrderController } from './order.controller';

const route = OrderHabitudesController.prototype.duClient;

const garde = new UserPermissionsGuard(new Reflector());
function autorise(role: UserRole): boolean {
  const contexte = {
    getHandler: () => route,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  return garde.canActivate(contexte);
}

describe('GET /orders/habitudes/client/:customerId : droits', () => {
  it('exige COMMANDES CREATE', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, route)).toEqual({
      module: Modules.COMMANDES,
      action: Action.CREATE,
    });
  });

  it('est ouvert à ceux qui prennent une commande : ADMIN, CALL_CENTER et CAISSIER', () => {
    for (const role of [UserRole.ADMIN, UserRole.CALL_CENTER, UserRole.CAISSIER]) {
      expect(autorise(role)).toBe(true);
    }
  });

  it('est refusé aux autres rôles', () => {
    for (const role of [
      UserRole.MANAGER,
      UserRole.ASSISTANT_MANAGER,
      UserRole.CUISINE,
      UserRole.MARKETING,
      UserRole.COMPTABLE,
    ]) {
      expect(autorise(role)).toBe(false);
    }
  });

  it('jeton puis droit', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OrderHabitudesController)).toEqual([
      JwtAuthGuard,
      UserPermissionsGuard,
    ]);
  });

  it('le contrôleur est déclaré avant celui des commandes', () => {
    const controleurs: unknown[] = Reflect.getMetadata('controllers', OrderModule);
    expect(controleurs.indexOf(OrderHabitudesController)).toBeGreaterThanOrEqual(0);
    expect(controleurs.indexOf(OrderHabitudesController)).toBeLessThan(controleurs.indexOf(OrderController));
  });
});

describe('OrderHabitudesService.duClient', () => {
  const CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const RESTAURANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const ligne = (dishId: string, nom: string, supplements: unknown[] = []) => ({
    dish_id: dishId,
    quantity: 1,
    amount: 4000,
    epice: false,
    supplements,
    options: [],
    dish: { name: nom, image: null },
  });

  const commandes = [
    {
      id: 'o2',
      reference: 'ORD-2',
      created_at: new Date(2026, 10, 20),
      type: OrderType.DELIVERY,
      amount: 7500,
      restaurant: { id: RESTAURANT, name: 'CHICKEN NATION ANGRÉ' },
      order_items: [ligne('burger', 'Burger Patron', [{ id: 'sauce', quantity: 1 }]), ligne('campus', 'Menu Campus')],
    },
    {
      id: 'o1',
      reference: 'ORD-1',
      created_at: new Date(2026, 10, 10),
      type: OrderType.DELIVERY,
      amount: 7500,
      restaurant: { id: RESTAURANT, name: 'CHICKEN NATION ANGRÉ' },
      order_items: [ligne('burger', 'Burger Patron'), ligne('campus', 'Menu Campus')],
    },
  ];

  function monter(client: Record<string, unknown> | null = {}) {
    const prisma = {
      customer: {
        findUnique: jest.fn().mockResolvedValue(
          client && {
            id: CLIENT,
            profile_type: null,
            loyalty_level: LoyaltyLevel.STANDARD,
            entity_status: EntityStatus.ACTIVE,
            ...client,
          },
        ),
      },
      order: { findMany: jest.fn().mockResolvedValue(commandes) },
      // Le plat « campus » n'est plus au menu pour ce client.
      dish: { findMany: jest.fn().mockResolvedValue([{ id: 'burger' }]) },
      supplement: { findMany: jest.fn().mockResolvedValue([{ id: 'sauce' }]) },
      dishExcludedSupplement: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { prisma, service: new OrderHabitudesService(prisma as never) };
  }

  const agent = { id: 'agent-1', type: UserType.BACKOFFICE, role: UserRole.CALL_CENTER } as User;
  const caissier = {
    id: 'caisse-1',
    type: UserType.RESTAURANT,
    role: UserRole.CAISSIER,
    restaurant_id: RESTAURANT,
  } as User;

  it('lit les 30 dernières commandes qui comptent du client, jamais les annulées', async () => {
    const { prisma, service } = monter();
    await service.duClient(agent, CLIENT);
    const appel = prisma.order.findMany.mock.calls[0][0];
    expect(appel.where).toMatchObject({
      customer_id: CLIENT,
      entity_status: { not: EntityStatus.DELETED },
      status: { not: OrderStatus.CANCELLED },
    });
    // Le panier de l'application non payé ne compte pas.
    expect(appel.where.NOT).toMatchObject({ paied: false, status: OrderStatus.PENDING });
    expect(appel.orderBy).toEqual({ created_at: 'desc' });
    expect(appel.take).toBe(HABITUDES_FENETRE);
    // Centre d'appels : tous les restaurants.
    expect(appel.where).not.toHaveProperty('restaurant_id');
  });

  it('caissier : seulement les commandes de son restaurant, lu du jeton', async () => {
    const { prisma, service } = monter();
    await service.duClient(caissier, CLIENT);
    expect(prisma.order.findMany.mock.calls[0][0].where.restaurant_id).toBe(RESTAURANT);
  });

  it('ne propose que les plats de la grille de ce client : actifs, non privés, dans son audience', async () => {
    const { prisma, service } = monter({ profile_type: ProfileType.ETUDIANT, loyalty_level: LoyaltyLevel.VIP });
    const habitudes = await service.duClient(agent, CLIENT);
    expect(prisma.dish.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['burger', 'campus'] },
      entity_status: EntityStatus.ACTIVE,
      private: false,
      AND: [
        {
          OR: [
            { audiences: { isEmpty: true } },
            { audiences: { hasSome: [DishAudience.ETUDIANT, DishAudience.VIP] } },
          ],
        },
      ],
    });
    expect(habitudes.plats.map((p) => p.dish_id)).toEqual(['burger']);
    expect(habitudes.plats[0]).toMatchObject({ fois: 2, supplements: [{ id: 'sauce', quantity: 1 }] });
    expect(habitudes.derniere?.lignes.map((l) => [l.dish_id, l.disponible])).toEqual([
      ['burger', true],
      ['campus', false],
    ]);
  });

  it('client sans commande : rien, et le catalogue n’est pas lu', async () => {
    const { prisma, service } = monter();
    prisma.order.findMany.mockResolvedValue([]);
    await expect(service.duClient(agent, CLIENT)).resolves.toEqual({ commandes: 0, plats: [], derniere: null });
    expect(prisma.dish.findMany).not.toHaveBeenCalled();
  });

  it('client inconnu ou supprimé : 404', async () => {
    await expect(monter(null).service.duClient(agent, CLIENT)).rejects.toThrow(NotFoundException);
    await expect(
      monter({ entity_status: EntityStatus.DELETED }).service.duClient(agent, CLIENT),
    ).rejects.toThrow('Client introuvable.');
  });
});
