import { UserRole, UserType } from '@prisma/client';

/**
 * Rôles rattachés à un point de vente (restaurant). Un user avec l'un de ces
 * rôles DOIT être `type = RESTAURANT` et rattaché à un restaurant.
 */
export const STORE_ROLES: UserRole[] = [
  UserRole.MANAGER,
  UserRole.ASSISTANT_MANAGER,
  UserRole.CAISSIER,
  UserRole.CUISINE,
];

export function isStoreRole(role: UserRole): boolean {
  return STORE_ROLES.includes(role);
}

/**
 * Le `type` d'un staff découle TOUJOURS de son rôle — jamais d'un paramètre
 * envoyé par le client ni du type du créateur. Garantit qu'un caissier ne peut
 * pas se retrouver `type = BACKOFFICE` (et donc voir tout le réseau).
 */
export function resolveStaffType(role: UserRole): UserType {
  return isStoreRole(role) ? UserType.RESTAURANT : UserType.BACKOFFICE;
}
