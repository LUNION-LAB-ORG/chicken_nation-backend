import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';

import { MESSAGE_TROP_DE_DEMANDES } from '../helpers/tentatives-livreur.helper';

/**
 * Limite de débit des routes publiques d'authentification des livreurs.
 *
 * Même garde que ThrottlerGuard, posée MÉTHODE PAR MÉTHODE (jamais sur la
 * classe : refresh-token, me, logout et la gestion du compte doivent rester
 * libres), avec un message en français au lieu de
 * « ThrottlerException: Too Many Requests », que l'appli afficherait tel quel.
 * Le quota vient du décorateur @Throttle de chaque route.
 *
 * Complément seulement : l'adresse IP est falsifiable (`trust proxy`). La vraie
 * protection est le compteur par téléphone (TentativesLivreurService).
 */
@Injectable()
export class LivreurThrottlerGuard extends ThrottlerGuard {
  protected async getErrorMessage(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<string> {
    return MESSAGE_TROP_DE_DEMANDES;
  }
}
