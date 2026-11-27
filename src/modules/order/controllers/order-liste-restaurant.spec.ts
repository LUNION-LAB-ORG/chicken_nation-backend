/**
 * `GET /orders` : un compte de point de vente ne lit que SON restaurant
 * (27/11). La liste se fiait au `restaurantId` envoyé par l'écran : en
 * l'omettant, un caissier recevait les commandes du réseau, et la recherche
 * par nom ou par numéro lui aurait ouvert les clients des autres restaurants.
 * Même règle que les opérations et les statistiques
 * (restaurant-scope.helper.ts).
 */

import { User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { OrderController } from './order.controller';

const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTAURANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUCUN = '00000000-0000-0000-0000-000000000000';

function monter() {
  const service = {
    findAll: jest.fn(async (_filtres: Record<string, unknown>, _user: User) => ({
      data: [],
      meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
    })),
  };
  const controleur = new OrderController({} as never, service as never, {} as never, {} as never, {} as never);
  /** Filtres réellement transmis au service pour ce compte et cette demande. */
  const filtres = async (user: User, demande: Record<string, unknown>) => {
    await controleur.findAll({ user } as unknown as Request, demande as never);
    return service.findAll.mock.calls[service.findAll.mock.calls.length - 1][0];
  };
  return { filtres };
}

const compte = (role: UserRole, type: UserType, restaurant_id: string | null) =>
  ({ id: `u-${role}`, role, type, restaurant_id }) as unknown as User;

describe('GET /orders : restaurant imposé par le compte', () => {
  it('point de vente : son restaurant, même sans le demander', async () => {
    const { filtres } = monter();
    const caissier = compte(UserRole.CAISSIER, UserType.RESTAURANT, RESTAURANT_A);
    expect((await filtres(caissier, { search: 'Koné' })).restaurantId).toBe(RESTAURANT_A);
  });

  it("point de vente : un autre restaurant demandé est ignoré", async () => {
    const { filtres } = monter();
    const manager = compte(UserRole.MANAGER, UserType.RESTAURANT, RESTAURANT_A);
    const lus = await filtres(manager, { restaurantId: RESTAURANT_B, search: '0707070707' });
    expect(lus.restaurantId).toBe(RESTAURANT_A);
    expect(lus.search).toBe('0707070707');
  });

  it('point de vente sans restaurant : aucune commande, jamais tout le réseau', async () => {
    const { filtres } = monter();
    const orphelin = compte(UserRole.CAISSIER, UserType.RESTAURANT, null);
    expect((await filtres(orphelin, {})).restaurantId).toBe(AUCUN);
  });

  it('siège : le restaurant choisi, ou tous', async () => {
    const { filtres } = monter();
    const agent = compte(UserRole.CALL_CENTER, UserType.BACKOFFICE, null);
    expect((await filtres(agent, { restaurantId: RESTAURANT_B })).restaurantId).toBe(RESTAURANT_B);
    expect((await filtres(agent, {})).restaurantId).toBeUndefined();
  });
});
