import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User, UserRole } from '@prisma/client';
import { Observable, map } from 'rxjs';
import { masquerContacts } from './masquer-contact';
import { SANS_MASQUAGE } from './sans-masquage.decorator';

/**
 * Masque les coordonnées dans TOUTE réponse, pour les rôles qui consultent les
 * dossiers sans avoir à en relever les contacts.
 *
 * ⚠️ Posé sur la RÉPONSE, jamais à l'écran. Masquer à l'affichage ne protège
 * rien : la valeur part quand même, lisible dans l'onglet Réseau, et surtout
 * un bouton « copier » lit la réponse, pas le pixel — il rendrait le numéro
 * en clair pendant que l'écran montre des points.
 *
 * ⚠️ Enregistré GLOBALEMENT (`APP_INTERCEPTOR`) et non contrôleur par
 * contrôleur. Le marketing atteint onze contrôleurs qui charrient un contact
 * (cartes, CRM, clients, adresses, favoris, avis, fidélité, bons, prospects,
 * promotions, plats) : une liste à tenir à jour aurait fuité au douzième. La
 * règle est donc « masqué partout », et les rares dérogations se demandent
 * avec @SansMasquage(), ce qui se voit en relecture.
 *
 * Aujourd'hui le seul rôle concerné est le MARKETING : il gère les cartes, lit
 * le CRM et le fichier client, et n'a aucune raison d'en repartir avec les
 * numéros et les adresses. Les clients et les livreurs n'ont pas de rôle de
 * personnel : leurs réponses ne sont jamais touchées.
 */
const ROLES_SANS_COORDONNEES: UserRole[] = [UserRole.MARKETING];

@Injectable()
export class MasquerContactsInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) { }

  intercept(contexte: ExecutionContext, suite: CallHandler): Observable<unknown> {
    if (contexte.getType() !== 'http') return suite.handle();

    const dispense = this.reflector.getAllAndOverride<boolean>(SANS_MASQUAGE, [
      contexte.getHandler(),
      contexte.getClass(),
    ]);
    if (dispense) return suite.handle();

    const role = (contexte.switchToHttp().getRequest<{ user?: User }>().user)?.role;
    if (!role || !ROLES_SANS_COORDONNEES.includes(role)) return suite.handle();

    return suite.handle().pipe(map((donnees) => masquerContacts(donnees)));
  }
}
