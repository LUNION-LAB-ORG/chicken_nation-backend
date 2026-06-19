import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { resolveRestaurantScope } from 'src/modules/order/helpers/restaurant-scope.helper';

/**
 * Cloisonne TOUTES les statistiques par restaurant pour les utilisateurs
 * `UserType.RESTAURANT` (caissier, manager, assistant, cuisine).
 *
 * Avant : le module statistics ne filtrait que sur un `?restaurantId` OPTIONNEL
 * fourni par le client → un user RESTAURANT pouvait OMETTRE le param et lire les
 * stats de TOUS les restaurants (CA, top clients avec téléphones, zones de
 * livraison…). C'est la même faille que celle corrigée sur `/orders/*`.
 *
 * Ce guard force `req.query.restaurantId` au restaurant du JWT pour les users
 * RESTAURANT (et neutralise toute tentative de cibler un autre restaurant). Le
 * BACKOFFICE garde le filtre libre (onglet « par restaurant » ou « tous »).
 *
 * Les guards s'exécutant AVANT les pipes, le DTO `@Query()` reçoit la valeur
 * forcée ; tous les services stats filtrent déjà via `buildRestaurantFilter`.
 * À COMBINER avec `UserScopedCacheInterceptor` (sinon le cache URL-keyed ressert
 * la réponse « tous restaurants » d'un admin à un caissier).
 */
@Injectable()
export class StatsRestaurantScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const currentQuery = (req?.query ?? {}) as Record<string, unknown>;
    const scoped = resolveRestaurantScope(
      req?.user as User | undefined,
      currentQuery.restaurantId as string | undefined,
    );
    // RESTAURANT → id de SON resto (ou sentinelle si aucun) ; BACKOFFICE ciblé →
    // le param tel quel. `undefined` = BACKOFFICE sans filtre (tous restaurants)
    // → on n'impose rien.
    if (scoped !== undefined) {
      // ⚠️ Express 5 : `req.query` est un GETTER qui RE-PARSE l'URL à chaque
      // accès → une simple affectation `req.query.x = …` est ignorée (testé).
      // On REMPLACE donc la propriété par un objet fixe pour forcer le scope.
      const forcedQuery = { ...currentQuery, restaurantId: scoped };
      Object.defineProperty(req, 'query', {
        value: forcedQuery,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    return true;
  }
}
