import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Deliverer, EntityStatus } from '@prisma/client';

@Injectable()
export class JwtDelivererRefreshAuthGuard extends AuthGuard('jwt-deliverer-refresh') {
  async canActivate(context: ExecutionContext) {
    const result = (await super.canActivate(context)) as boolean;

    const request = context.switchToHttp().getRequest();
    const deliverer = request.user as Deliverer;

    if (deliverer.entity_status === EntityStatus.INACTIVE) {
      throw new UnauthorizedException('Compte livreur inactif');
    }
    if (deliverer.entity_status === EntityStatus.DELETED) {
      throw new UnauthorizedException('Compte livreur supprimé');
    }

    return result;
  }

  handleRequest(err, user) {
    if (err || !user) {
      throw err || new UnauthorizedException('Authentication required');
    }
    return user;
  }
}
