import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Deliverer } from '@prisma/client';

/**
 * Guard complémentaire à utiliser APRÈS JwtDelivererAuthGuard.
 * Bloque les endpoints qui nécessitent un livreur opérationnel
 * (compte validé par admin + restaurant affecté + is_operational = true).
 *
 * Usage :
 *   @UseGuards(JwtDelivererAuthGuard, DelivererOperationalGuard)
 */
@Injectable()
export class DelivererOperationalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const deliverer = request.user as Deliverer;

    if (!deliverer?.is_operational) {
      throw new ForbiddenException(
        'Compte livreur non opérationnel. En attente de validation ou d\'affectation.',
      );
    }

    return true;
  }
}
