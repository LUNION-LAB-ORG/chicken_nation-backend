import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { MESSAGE_TROP_D_ESSAIS_IP } from '../helpers/envois-otp.helper';

/**
 * Limite par adresse IP des essais de code client (POST /auth/customer/verify-otp).
 *
 * Complément du verrou par numéro (5 essais puis 15 minutes), qui reste la
 * vraie barrière : `trust proxy` rend l'IP falsifiable, et beaucoup de clients
 * mobiles partagent l'adresse de leur opérateur (d'où un quota large). Message
 * en français, l'appli et le site l'affichent tel quel.
 */
@Injectable()
export class VerificationCodeThrottlerGuard extends ThrottlerGuard {
  protected async getErrorMessage(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<string> {
    return MESSAGE_TROP_D_ESSAIS_IP;
  }
}
