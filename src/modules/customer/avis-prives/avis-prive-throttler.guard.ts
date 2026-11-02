import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { MESSAGE_PLAFOND_IP } from './avis-prive.rules';

/**
 * Limite par adresse IP de l'envoi public d'un avis (POST /avis-prives), posée
 * sur la route seule (jamais en APP_GUARD), avec un message en français que le
 * site affiche tel quel. Le quota vient du `@Throttle` de la route.
 *
 * Complément seulement : l'IP vient de X-Forwarded-For (`trust proxy`, le
 * serveur du site y met celle du visiteur), donc falsifiable. Les vraies
 * barrières sont celles d'AvisPriveLimitesService (doublon, par numéro, global).
 */
@Injectable()
export class AvisPriveThrottlerGuard extends ThrottlerGuard {
  protected async getErrorMessage(_context: ExecutionContext, _detail: ThrottlerLimitDetail): Promise<string> {
    return MESSAGE_PLAFOND_IP;
  }
}
