import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { MESSAGE_TROP_DE_CONNEXIONS } from '../helpers/connexion-echecs.helper';

/**
 * Limite de débit des routes de connexion du personnel.
 *
 * Même garde que ThrottlerGuard, posée ROUTE PAR ROUTE (jamais en APP_GUARD :
 * cela limiterait aussi les webhooks et les rappels des partenaires), avec un
 * message en français au lieu de « ThrottlerException: Too Many Requests ».
 * Le quota vient du décorateur @Throttle de la route.
 */
@Injectable()
export class ConnexionThrottlerGuard extends ThrottlerGuard {
  protected async getErrorMessage(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<string> {
    return MESSAGE_TROP_DE_CONNEXIONS;
  }
}
