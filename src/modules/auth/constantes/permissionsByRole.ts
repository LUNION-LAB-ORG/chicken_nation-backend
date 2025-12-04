import { UserRole } from '@prisma/client';
import { Modules } from '../enums/module-enum';

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
      [Modules.ALL]: ['create', 'read', 'update', 'delete'],
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
    // exclusions: [Modules.COMMANDES, Modules.CLIENTS],
  },
  [UserRole.MARKETING]: {
    modules: {
      [Modules.DASHBOARD]: ['read'],
      [Modules.INVENTAIRE]: ['create', 'read', 'update', 'delete'],
      [Modules.PLATS]: ['create', 'read', 'update', 'delete'],
      [Modules.PROMOTIONS]: ['create', 'read', 'update', 'delete'],
    },
    exclusions: [Modules.DASHBOARD],
  },
  [UserRole.COMPTABLE]: {
    modules: {
      [Modules.COMMANDES]: ['read'],
      [Modules.DASHBOARD]: ['read'],
    },
  },
  [UserRole.CUISINE]: {
    modules: {
      [Modules.COMMANDES]: ['read', 'update'],
    },
  },
  [UserRole.ASSISTANT_MANAGER]: {
    modules: {
      [Modules.COMMANDES]: ['read', 'update'],
    },
  },
};

