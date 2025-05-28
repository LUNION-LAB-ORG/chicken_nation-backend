import { Injectable } from '@nestjs/common/decorators';
import { AuthGuard } from '@nestjs/passport';
import { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { EntityStatus } from '@prisma/client';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
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
    const user = request.user;

    // Si l'utilisateur est inactif
    if (user.entity_status === EntityStatus.INACTIVE) {
      throw new UnauthorizedException('Utilisateur inactif');
    }
    // Si l'utilisateur est supprimé
    if (user.entity_status === EntityStatus.DELETED) {
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
