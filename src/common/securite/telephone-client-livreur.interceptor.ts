import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { sansTelephoneClientTermine } from './telephone-client-livreur';

/**
 * Retire le numéro du client des livraisons terminées dans TOUTE réponse
 * d'un contrôleur du livreur (voir `telephone-client-livreur.ts`).
 *
 * Posé sur le contrôleur entier et non route par route : la prochaine route
 * qui rendra une course au livreur sera couverte sans qu'on y pense.
 * ⚠️ Jamais sur un contrôleur du personnel ou du client : eux gardent le
 * numéro.
 */
@Injectable()
export class TelephoneClientLivreurInterceptor implements NestInterceptor {
  intercept(_contexte: ExecutionContext, suite: CallHandler): Observable<unknown> {
    return suite.handle().pipe(map((donnees) => sansTelephoneClientTermine(donnees)));
  }
}
