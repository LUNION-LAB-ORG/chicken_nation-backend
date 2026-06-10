import { CacheInterceptor } from '@nestjs/cache-manager';
import { ExecutionContext, Injectable } from '@nestjs/common';

/**
 * CacheInterceptor cloisonné par utilisateur.
 *
 * PROBLÈME résolu : le `CacheInterceptor` par défaut de NestJS met en cache les
 * réponses GET avec l'URL comme SEULE clé. Sur des endpoints scopés par
 * restaurant (`/orders/operations/active`, `/orders/statistics`, `/orders/:id`),
 * deux utilisateurs de restaurants différents partagent la même URL → le
 * premier (ex. un admin voyant tout le réseau) remplit le cache, et un caissier
 * reçoit ensuite cette réponse « tous restaurants » sans que le scoping serveur
 * ne s'exécute. = fuite inter-restaurants.
 *
 * FIX : on ajoute la « signature de scope » de l'utilisateur authentifié à la
 * clé de cache. Un user RESTAURANT n'a donc jamais accès à une entrée mise en
 * cache pour un autre scope (autre restaurant, BACKOFFICE, ou anonyme). Comme
 * les guards s'exécutent AVANT les interceptors, `req.user` est déjà résolu ici.
 *
 * Les requêtes non-GET ne sont pas mises en cache (super.trackBy → undefined),
 * donc cet interceptor n'affecte que les lectures.
 */
@Injectable()
export class UserScopedCacheInterceptor extends CacheInterceptor {
  trackBy(context: ExecutionContext): string | undefined {
    const key = super.trackBy(context);
    if (!key) return undefined; // non cacheable (POST/PATCH/…) → inchangé

    const req = context.switchToHttp().getRequest();
    const u = req?.user as
      | { id?: string; type?: string; restaurant_id?: string | null }
      | undefined;

    let scope = 'anon';
    if (u) {
      if (u.type === 'RESTAURANT' || u.type === 'BACKOFFICE') {
        // Staff : le contenu ne dépend que du restaurant (et du type pour le
        // « tout voir » BACKOFFICE) → les users du même restaurant partagent
        // la même entrée, jamais entre restaurants.
        scope = `staff:${u.type}:${u.restaurant_id ?? 'all'}`;
      } else if (u.id) {
        // Client / livreur : clé par principal.
        scope = `principal:${u.id}`;
      }
    }

    return `${key}::${scope}`;
  }
}
