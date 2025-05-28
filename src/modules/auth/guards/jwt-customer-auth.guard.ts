import { Injectable } from '@nestjs/common/decorators';
import { AuthGuard } from '@nestjs/passport';
import { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Customer, EntityStatus } from '@prisma/client';

@Injectable()
export class JwtCustomerAuthGuard extends AuthGuard('jwt-customer') {
  constructor() {
    super();
  }

  // Gestion de l'authentification
  async canActivate(context: ExecutionContext) {
    const result = (await super.canActivate(
      context,
    )) as unknown as Promise<boolean>;

    // Si l'utilisateur est authentifié
    const request = context.switchToHttp().getRequest();
    const customer = request.user as Customer;

    // Si l'utilisateur est inactif
    if (customer.entity_status === EntityStatus.INACTIVE) {
      throw new UnauthorizedException('Utilisateur inactif');
    }
    // Si l'utilisateur est supprimé
    if (customer.entity_status === EntityStatus.DELETED) {
      throw new UnauthorizedException('Utilisateur supprimé');
    }
    return result;
  }

  // Gestion de la requête
  handleRequest(err, user, info) {
    if (err || !user) {
      throw err || new UnauthorizedException('Authentication required');
    }
    return user;
  }
}
