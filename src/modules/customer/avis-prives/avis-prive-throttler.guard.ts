import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { cleSiteValide } from './avis-prive-cle-site.guard';
import { MESSAGE_PLAFOND_IP } from './avis-prive.rules';

/**
 * Adresse comptée par la limite par IP :
 *  - requête du serveur du site (clé valide) : l'adresse du visiteur, que le
 *    site place en tête de X-Forwarded-For ;
 *  - toute autre requête : l'adresse vue par notre nginx, c'est-à-dire la
 *    DERNIÈRE de la chaîne X-Forwarded-For (nginx l'y ajoute), sinon celle de
 *    la connexion. Jamais la première, que l'appelant écrit lui-même.
 */
export function adresseSuivie(req: Record<string, any>): string {
  const ips: string[] = Array.isArray(req?.ips) ? req.ips : [];
  if (cleSiteValide(req)) return ips[0] ?? req?.ip ?? req?.socket?.remoteAddress ?? 'inconnue';
  return ips[ips.length - 1] ?? req?.socket?.remoteAddress ?? req?.ip ?? 'inconnue';
}

/**
 * Limite par adresse IP de l'envoi public d'un avis (POST /avis-prives), posée
 * sur la route seule (jamais en APP_GUARD), APRÈS AvisPriveCleSiteGuard, avec
 * un message en français que le site affiche tel quel. Le quota vient du
 * `@Throttle` de la route.
 *
 * L'adresse du visiteur n'est crue que sur une requête du serveur du site
 * (clé valide, voir `adresseSuivie`). Les autres barrières sont celles
 * d'AvisPriveLimitesService (doublon, par numéro, global).
 */
@Injectable()
export class AvisPriveThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return adresseSuivie(req);
  }

  protected async getErrorMessage(_context: ExecutionContext, _detail: ThrottlerLimitDetail): Promise<string> {
    return MESSAGE_PLAFOND_IP;
  }
}
