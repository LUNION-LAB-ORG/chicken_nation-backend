import { UserRole, UserType } from '@prisma/client';
import { permissionsByRole } from 'src/modules/auth/constantes/permissionsByRole';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';

/**
 * Téléphones des détenteurs de cadeaux, dans GET usages-cadeau.
 *
 * La route se lit avec MENUS READ, que portent sept rôles. Or elle nomme les
 * clients qui détiennent encore un cadeau sur ce plat, où qu'ils aient
 * commandé : en parcourant les plats (dont les identifiants sont publics), un
 * rôle sans accès au fichier clients récupérait nom et téléphone de tous ces
 * clients. Le téléphone ne sort donc qu'avec CLIENTS READ, le droit qui ouvre
 * déjà la fiche client.
 *
 * Compte de restaurant (caissier, manager, assistant manager) : jamais de
 * téléphone, même avec CLIENTS READ. Son fichier clients se limite à SON
 * restaurant, alors que ces cadeaux ne sont liés à aucun restaurant : la
 * liste lui aurait livré les téléphones de clients de tout le réseau. Il n'a
 * de toute façon pas le droit de modifier le plat (MENUS UPDATE).
 *
 * Même règle que `UserPermissionsGuard` : exclusions d'abord, puis le module
 * lui-même, sinon `Modules.ALL`. Lecture seule de `permissionsByRole`.
 */
export function peutVoirTelephonesClients(
  user: { role?: UserRole | string | null; type?: UserType | string | null } | null | undefined,
): boolean {
  const role = user?.role;
  if (!role || !Object.prototype.hasOwnProperty.call(permissionsByRole, role)) return false;
  if (user?.type === UserType.RESTAURANT) return false;

  const droits = permissionsByRole[role as UserRole];
  if (droits.exclusions?.includes(Modules.CLIENTS)) return false;

  const actions = droits.modules[Modules.CLIENTS] || droits.modules[Modules.ALL];
  return !!actions && actions.includes(Action.READ);
}

/** Un cadeau distribué tel que le décrit `usagesCadeau`. */
export interface CadeauDistribue {
  id: string;
  client: string;
  telephone: string | null;
}

/**
 * Retire le téléphone de chaque cadeau quand `avecTelephones` est faux. Le nom
 * reste : sans lui, le gestionnaire ne saurait pas ce qui bloque le plat.
 */
export function masquerTelephones<T extends CadeauDistribue>(cadeaux: T[], avecTelephones: boolean): T[] {
  if (avecTelephones) return cadeaux;
  return cadeaux.map((c) => ({ ...c, telephone: null }));
}
