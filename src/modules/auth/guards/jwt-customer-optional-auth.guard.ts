import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Customer, EntityStatus } from '@prisma/client';

/**
 * Guard client OPTIONNEL.
 *
 * Contrairement à {@link JwtCustomerAuthGuard} (strict), il n'échoue JAMAIS :
 *  - JWT client valide présent → `req.user` = Customer ;
 *  - token absent / invalide / client inactif|supprimé → `req.user` = undefined (invité).
 *
 * Usage : listes de plats. Le service filtre par audience si un client est
 * connecté, et ne renvoie que les plats PUBLIC pour un invité — sans casser la
 * navigation non authentifiée (onglets guest).
 */
@Injectable()
export class JwtCustomerOptionalAuthGuard extends AuthGuard('jwt-customer') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // Token absent/invalide → invité. On laisse passer.
    }
    // Un client inactif/supprimé est traité comme un invité (pas d'erreur).
    const request = context.switchToHttp().getRequest();
    const customer = request.user as Customer | undefined;
    if (
      customer &&
      (customer.entity_status === EntityStatus.INACTIVE ||
        customer.entity_status === EntityStatus.DELETED)
    ) {
      request.user = undefined;
    }
    return true;
  }

  // Ne JAMAIS rejeter : pas de user = invité (undefined).
  handleRequest(_err: any, user: any) {
    return user ?? undefined;
  }
}
