/**
 * Fin du flux OAuth HubRise : qui a le droit de relier un restaurant, et où
 * renvoyer le navigateur.
 *
 * Fonctions pures, testées dans `retour-oauth.util.spec.ts`.
 */

import { UserRole } from '@prisma/client';
import { permissionsByRole } from 'src/modules/auth/constantes/permissionsByRole';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import type { MotifRefusEtat } from './etat-oauth.util';

/**
 * Motifs d'échec transmis au backoffice. Liste FERMÉE : le backoffice traduit
 * chaque motif en message et ne montre jamais la valeur brute.
 */
export type MotifRetour =
  | MotifRefusEtat
  | 'refuse'
  | 'droit_insuffisant'
  | 'deja_relie'
  | 'echec';

/** Backoffice de production, si `BACKOFFICE_URL` n'est pas posée. */
export const BACKOFFICE_URL_DEFAUT = 'https://admin-private.chicken-nation.com';

/**
 * URL de retour dans le backoffice, succès (`motif` nul) ou échec.
 * Ne porte AUCUN identifiant HubRise (la location est une donnée réservée).
 */
export function urlRetourBackoffice(base: string | undefined, motif: MotifRetour | null): string {
  const racine = (base?.trim() || BACKOFFICE_URL_DEFAUT).replace(/\/+$/, '');
  return motif
    ? `${racine}/gestion?hubrise=erreur&motif=${motif}`
    : `${racine}/gestion?hubrise=connecte`;
}

/**
 * Même règle que `UserPermissionsGuard` pour RESTAURANTS CREATE, le droit
 * exigé par `POST /hubrise/auth/connect` : exclusions d'abord, puis le module
 * lui-même, sinon `Modules.ALL`. Lecture seule de `permissionsByRole`.
 *
 * Le retour OAuth n'a pas de jeton (c'est HubRise qui y renvoie le
 * navigateur) : on relit donc en base l'utilisateur inscrit dans le `state`
 * et on revérifie son droit à ce moment-là.
 */
export function peutConnecterHubrise(role: UserRole | string | null | undefined): boolean {
  if (!role || !Object.prototype.hasOwnProperty.call(permissionsByRole, role)) return false;

  const droits = permissionsByRole[role as UserRole];
  if (droits.exclusions?.includes(Modules.RESTAURANTS)) return false;

  const actions = droits.modules[Modules.RESTAURANTS] || droits.modules[Modules.ALL];
  return !!actions && actions.includes(Action.CREATE);
}
