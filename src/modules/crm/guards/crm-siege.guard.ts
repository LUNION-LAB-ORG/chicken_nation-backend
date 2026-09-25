import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { CrmAccessService } from '../services/crm-access.service';

/**
 * Routes réservées au siège : un compte de point de vente (User.type
 * RESTAURANT, le manager) reçoit 403 « Les campagnes se consultent au siège »,
 * quelle que soit l'action. Posé sur le contrôleur, après JwtAuthGuard (qui
 * fournit le compte) et avant UserPermissionsGuard : le message reste le même
 * sur une route que le rôle n'a pas (rapport, gestes). Il ne fait que refuser,
 * le garde des droits s'applique ensuite à tous les autres comptes.
 */
@Injectable()
export class CrmSiegeGuard implements CanActivate {
  constructor(private readonly access: CrmAccessService) {}

  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<{ user?: User }>();
    this.access.assertSiege(user);
    return true;
  }
}
