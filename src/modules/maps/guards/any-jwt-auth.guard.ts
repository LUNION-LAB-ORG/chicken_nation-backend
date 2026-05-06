import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Guard Maps — accepte TOUT JWT valide (customer, deliverer ou admin).
 *
 * Les endpoints `/maps/*` sont des utilitaires partagés entre les 3 apps.
 * On ne vérifie que la validité du token, pas le rôle.
 * Passport tente les stratégies dans l'ordre et s'arrête au 1er succès.
 */
@Injectable()
export class AnyJwtAuthGuard extends AuthGuard(['jwt-customer', 'jwt-deliverer', 'jwt']) {
  handleRequest(err: any, user: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('Authentification requise');
    }
    return user;
  }
}
