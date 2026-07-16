import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Customer, EntityStatus, User } from '@prisma/client';

/**
 * Guard OPTIONNEL « client OU staff ».
 *
 * N'échoue JAMAIS (aucun token → invité). Sert les lectures de plats/catégories
 * qui doivent se comporter différemment selon l'appelant :
 *  - CLIENT app (token `jwt-customer`)  → `req.user` = Customer  → filtre par lui ;
 *  - STAFF backoffice (token `jwt`)      → `req.user` = User      → PAS de filtre
 *    en gestion des menus ; filtre par un client CIBLE seulement si `customerId`
 *    est fourni (prise de commande) — résolu dans {@link DishService.resolveAudience} ;
 *  - invité (rien / token invalide)      → `req.user` = undefined → plats PUBLIC.
 *
 * Passport tente `jwt-customer` puis `jwt`, 1er succès gagne. On distingue ensuite
 * Customer vs User par la présence du champ `role` (staff uniquement).
 */
@Injectable()
export class JwtCustomerOrStaffOptionalAuthGuard extends AuthGuard([
  'jwt-customer',
  'jwt',
]) {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // Aucun token valide → invité. On laisse passer.
    }
    const request = context.switchToHttp().getRequest();
    const principal = request.user as (Customer | User) | undefined;
    // Un CLIENT inactif/supprimé est traité comme un invité (le staff n'a pas de
    // statut pertinent ici : un User authentifié reste staff).
    if (principal && !('role' in principal)) {
      const customer = principal as Customer;
      if (
        customer.entity_status === EntityStatus.INACTIVE ||
        customer.entity_status === EntityStatus.DELETED
      ) {
        request.user = undefined;
      }
    }
    return true;
  }

  // Ne JAMAIS rejeter : pas de principal = invité (undefined).
  handleRequest(_err: any, user: any) {
    return user ?? undefined;
  }
}
