import { UserRole } from '@prisma/client';

// 🔹 Exporter l'interface pour qu'elle puisse être utilisée ailleurs
export interface RolePermissions {
  modules: Record<string, string[]>;
  exclusions?: string[];
}

export const permissionsByRole: Record<UserRole, RolePermissions> = {
  [UserRole.CAISSIER]: {
    modules: {
      commandes: ['read', 'update'],
      dashboard: ['read'],
    },
  },
  [UserRole.MANAGER]: {
    modules: {
      dashboard: ['read'],
      menu: ['read'],
      promotions: ['read'],
    },
  },
  [UserRole.CALL_CENTER]: {
    modules: {
      commandes: ['read', 'update'],
      messages: ['read'],
    },
  },
  [UserRole.ADMIN]: {
    modules: {
      all: ['create', 'read', 'update', 'delete'],
    },
    exclusions: ['commandes', 'clients'],
  },
  [UserRole.MARKETING]: {
    modules: {
      dashboard: ['read'],
      categories: ['create', 'read', 'update', 'delete'],
      plats: ['create', 'read', 'update', 'delete'],
      promotions: ['create', 'read', 'update', 'delete'],
    },
    exclusions: ['chiffre_affaires'],
  },
  [UserRole.COMPTABLE]: {
    modules: {
      commandes: ['read'],
      chiffre_affaires: ['read'],
    },
  },
  [UserRole.CUISINE]: {
    modules: {
      commandes: ['read', 'update'],
    },
  },
};
