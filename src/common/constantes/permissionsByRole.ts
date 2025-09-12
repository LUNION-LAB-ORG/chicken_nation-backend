import { UserRole } from '@prisma/client';
import { Modules } from '../enum/module-enum';
 // chemin selon ton projet

export interface RolePermissions {
 modules: Partial<Record<Modules, string[]>>;
  exclusions?: Modules[];
}

export const permissionsByRole: Record<UserRole, RolePermissions> = {
  [UserRole.CAISSIER]: {
    modules: {
      [Modules.COMMANDES]: ['read', 'update'],
      [Modules.DASHBOARD]: ['read'],
    },
  },
  [UserRole.MANAGER]: {
    modules: {
      [Modules.DASHBOARD]: ['read'],
      [Modules.MENU]: ['read'],
      [Modules.PROMOTIONS]: ['read'],
    },
  },
  [UserRole.CALL_CENTER]: {
    modules: {
      [Modules.COMMANDES]: ['read', 'update'],
      [Modules.MESSAGES]: ['read'],
    },
  },
  [UserRole.ADMIN]: {
    modules: {
      [Modules.ALL]: ['create', 'read', 'update', 'delete'],
    },
    exclusions: [Modules.COMMANDES, Modules.CLIENTS],
  },
  [UserRole.MARKETING]: {
    modules: {
      [Modules.DASHBOARD]: ['read'],
      [Modules.CATEGORIES]: ['create', 'read', 'update', 'delete'],
      [Modules.PLATS]: ['create', 'read', 'update', 'delete'],
      [Modules.PROMOTIONS]: ['create', 'read', 'update', 'delete'],
    },
    exclusions: [Modules.CHIFFRE_AFFAIRES],
  },
  [UserRole.COMPTABLE]: {
    modules: {
      [Modules.COMMANDES]: ['read'],
      [Modules.CHIFFRE_AFFAIRES]: ['read'],
    },
  },
  [UserRole.CUISINE]: {
    modules: {
      [Modules.COMMANDES]: ['read', 'update'],
    },
  },
};
