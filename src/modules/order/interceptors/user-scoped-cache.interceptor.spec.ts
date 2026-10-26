/**
 * Clé du cache des lectures de commandes (1 s) : jamais partagée entre
 * restaurants, ni entre rôles. `GET /orders/:id/livraison` ne rend le code de
 * retrait du client qu'à l'administrateur et au call center (26/10) : avec une
 * clé commune à tout le siège, un compte de suivi des livraisons recevait, dans
 * la seconde, la réponse gardée pour l'administrateur.
 */
import { Reflector } from '@nestjs/core';
import { UserRole, UserType } from '@prisma/client';

import { OrderController } from '../controllers/order.controller';
import { UserScopedCacheInterceptor } from './user-scoped-cache.interceptor';

const URL = '/api/v1/orders/11111111-1111-4111-8111-111111111111/livraison';

function cle(user: Record<string, unknown> | undefined, method = 'GET'): string | undefined {
  const intercepteur = new UserScopedCacheInterceptor({} as never, new Reflector());
  (intercepteur as unknown as { httpAdapterHost: unknown }).httpAdapterHost = {
    httpAdapter: { getRequestMethod: () => method, getRequestUrl: (r: { url: string }) => r.url },
  };
  const req = { method, url: URL, user };
  const contexte = {
    getHandler: () => OrderController.prototype.suiviDeLivraison,
    getClass: () => OrderController,
    getArgByIndex: () => req,
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
  return intercepteur.trackBy(contexte);
}

const siege = (role: UserRole) => ({ id: `u-${role}`, role, type: UserType.BACKOFFICE, restaurant_id: null });
const resto = (role: UserRole, restaurant_id: string, id = `u-${role}`) => ({
  id,
  role,
  type: UserType.RESTAURANT,
  restaurant_id,
});

describe('UserScopedCacheInterceptor : clé par restaurant ET par rôle', () => {
  it('au siège, chaque rôle a sa propre entrée', () => {
    const cles = [UserRole.ADMIN, UserRole.CALL_CENTER, UserRole.LIVRAISON_OPS, UserRole.MARKETING, UserRole.COMPTABLE].map(
      (role) => cle(siege(role)),
    );
    expect(new Set(cles).size).toBe(cles.length);
    expect(cle(siege(UserRole.ADMIN))).not.toBe(cle(siege(UserRole.LIVRAISON_OPS)));
  });

  it('deux comptes du même rôle et du même restaurant partagent la même entrée', () => {
    expect(cle(resto(UserRole.CAISSIER, 'r-angre', 'a'))).toBe(cle(resto(UserRole.CAISSIER, 'r-angre', 'b')));
    expect(cle({ ...siege(UserRole.CALL_CENTER), id: 'agent-1' })).toBe(cle({ ...siege(UserRole.CALL_CENTER), id: 'agent-2' }));
  });

  it('jamais partagée entre restaurants, ni entre rôles d’un même restaurant', () => {
    expect(cle(resto(UserRole.CAISSIER, 'r-angre'))).not.toBe(cle(resto(UserRole.CAISSIER, 'r-marcory')));
    expect(cle(resto(UserRole.CAISSIER, 'r-angre'))).not.toBe(cle(resto(UserRole.MANAGER, 'r-angre')));
  });

  it('garde l’adresse demandée dans la clé, et ne met rien en cache hors lecture', () => {
    expect(cle(siege(UserRole.ADMIN))).toBe(`${URL}::staff:BACKOFFICE:all:ADMIN`);
    expect(cle(siege(UserRole.ADMIN), 'PATCH')).toBeUndefined();
  });
});
