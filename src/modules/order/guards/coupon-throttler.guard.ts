import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';

/** Quota des routes de réduction, par agent : 30 appels par minute. */
export const LIMITE_COUPON = { default: { limit: 30, ttl: 60_000 } };

export const MESSAGE_TROP_DE_VERIFICATIONS =
  'Trop de vérifications en peu de temps. Patientez une minute puis réessayez.';

/**
 * Limite de débit des routes `/orders/coupon/*`, comptée PAR AGENT et non par
 * adresse IP : tout un centre d'appel sort souvent par la même adresse. Elle
 * freine l'essai de codes au hasard (coupons CRM, bons d'autres clients) ; les
 * refus restent en plus dans le journal d'audit.
 *
 * Posée APRÈS la garde d'authentification : `req.user` est alors connu.
 */
@Injectable()
export class CouponThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const agent = req?.user?.id;
    return agent ? `agent:${agent}` : `ip:${req?.ip ?? 'inconnue'}`;
  }

  protected async getErrorMessage(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<string> {
    return MESSAGE_TROP_DE_VERIFICATIONS;
  }
}

/**
 * Même quota sur `POST /orders/create`, mais SEULEMENT quand la commande porte
 * un code. La création vérifie le code avec les mêmes refus que l'aperçu :
 * sans ce quota, elle servait à essayer des codes sans limite, et la limite de
 * l'aperçu ne protégeait rien. Une commande sans code n'est jamais freinée.
 *
 * Compteur distinct de celui de l'aperçu (clé par route) : un agent qui vérifie
 * puis enregistre consomme un appel de chaque côté.
 */
@Injectable()
export class CouponCreationThrottlerGuard extends CouponThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const corps = context.switchToHttp().getRequest()?.body;
    const code = typeof corps?.code_promo === 'string' ? corps.code_promo.trim() : '';
    return code === '';
  }
}
