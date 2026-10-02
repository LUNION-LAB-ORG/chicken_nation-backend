import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { MESSAGE_TROP_DE_DEMANDES_IP } from '../helpers/envois-otp.helper';

/**
 * Limite par adresse IP des demandes de code client (POST /auth/customer/login).
 *
 * Complément seulement : `trust proxy` rend l'IP falsifiable, et beaucoup de
 * clients mobiles partagent l'adresse de leur opérateur (d'où un quota large).
 * Les vraies barrières sont les plafonds par numéro et global de
 * envois-otp.helper. Message en français, l'appli et le site l'affichent tel quel.
 */
@Injectable()
export class CodeClientThrottlerGuard extends ThrottlerGuard {
  protected async getErrorMessage(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<string> {
    return MESSAGE_TROP_DE_DEMANDES_IP;
  }
}
