import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { resolveRestaurantScope } from 'src/modules/order/helpers/restaurant-scope.helper';

/**
 * Guard GÉNÉRIQUE de cloisonnement par restaurant pour les endpoints LISTE staff
 * qui acceptent un `?restaurantId` optionnel (stats, liste clients, etc.).
 *
 * Force `req.query.restaurantId` au restaurant du JWT pour les utilisateurs
 * `UserType.RESTAURANT` (caissier, manager…) → ils ne peuvent voir que LEUR
 * restaurant, même en omettant ou en falsifiant le param. Le BACKOFFICE garde
 * le filtre libre. La décision de scope vit dans `resolveRestaurantScope`
 * (partagé avec /orders et les stats).
 *
 * ⚠️ Express 5 : `req.query` est un GETTER qui re-parse l'URL → une simple
 * affectation `req.query.x = …` est IGNORÉE. On REMPLACE donc la propriété par
 * un objet fixe via Object.defineProperty (mécanisme validé empiriquement).
 *
 * À combiner avec `UserScopedCacheInterceptor` sur le contrôleur (sinon le cache
 * URL-keyed ressert la réponse « tous restaurants » d'un admin à un caissier).
 */
@Injectable()
export class RestaurantQueryScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const currentQuery = (req?.query ?? {}) as Record<string, unknown>;
    const scoped = resolveRestaurantScope(
      req?.user as User | undefined,
      currentQuery.restaurantId as string | undefined,
    );
    if (scoped !== undefined) {
      Object.defineProperty(req, 'query', {
        value: { ...currentQuery, restaurantId: scoped },
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    return true;
  }
}
