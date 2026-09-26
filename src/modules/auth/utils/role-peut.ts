import { UserRole } from '@prisma/client';
import { permissionsByRole } from '../constantes/permissionsByRole';
import { Action } from '../enums/action.enum';
import { Modules } from '../enums/module-enum';

/**
 * Ce rôle a-t-il le droit `action` sur `module` ?
 *
 * Même règle, au caractère près, que `UserPermissionsGuard` : exclusions
 * d'abord, puis les droits du module, à défaut ceux de `Modules.ALL`. Elle est
 * reprise ici sous forme de fonction pure pour les décisions prises HORS d'une
 * requête : qui peut être mentionné dans une conversation, qui est prévenu.
 * Un test compare les deux sur tous les rôles, pour qu'elles ne divergent pas.
 *
 * Rôle inconnu ou absent : non. On ne donne rien par défaut.
 */
export function rolePeut(
  role: UserRole | string | null | undefined,
  module: Modules,
  action: Action | string,
): boolean {
  if (!role) return false;
  const permissions = permissionsByRole[role as UserRole];
  if (!permissions) return false;
  if (permissions.exclusions?.includes(module)) return false;
  const droits = permissions.modules[module] || permissions.modules[Modules.ALL];
  return !!droits?.includes(action);
}
