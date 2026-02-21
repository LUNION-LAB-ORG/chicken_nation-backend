import { UserRole } from '@prisma/client';
import { Modules } from '../enums/module-enum';
import { Action } from '../enums/action.enum';

export interface RolePermissions {
  modules: Partial<Record<Modules, string[]>>;
  exclusions?: Modules[];
}

export const permissionsByRole: Record<UserRole, RolePermissions> = {

  /* ===================== ADMIN ===================== */
  [UserRole.ADMIN]: {
    modules: {
      [Modules.ALL]: Object.values(Action),
    },
  },

  /* ===================== MARKETING ===================== */
  [UserRole.MARKETING]: {
    modules: {
      [Modules.DASHBOARD]: [Action.READ],

      [Modules.MENUS]: [Action.CREATE, Action.READ, Action.UPDATE],
      [Modules.INVENTAIRE]: [Action.CREATE, Action.READ, Action.UPDATE],
      [Modules.PROMOTIONS]: [Action.CREATE, Action.READ, Action.UPDATE, Action.DELETE],
      [Modules.FIDELITE]: [Action.CREATE, Action.READ, Action.UPDATE],
      [Modules.CARD_NATION]: [Action.CREATE, Action.READ, Action.UPDATE],

      [Modules.CLIENTS]: [Action.READ],
      [Modules.COMMANDES]: [Action.READ],
      [Modules.MARKETING]: [Action.CREATE, Action.READ, Action.UPDATE, Action.REPORT],
    },
  },

  /* ===================== COMPTABLE ===================== */
  [UserRole.COMPTABLE]: {
    modules: {
      [Modules.DASHBOARD]: [Action.READ; Action.EXPORT],

      [Modules.COMMANDES]: [Action.READ, Action.EXPORT, Action.REPORT],
      [Modules.MENUS]: [Action.READ],
      [Modules.INVENTAIRE]: [Action.READ],
      [Modules.PROMOTIONS]: [Action.READ],
      [Modules.FIDELITE]: [Action.READ],

      [Modules.RESTAURANTS]: [Action.READ],
    },
  },

  /* ===================== CALL CENTER ===================== */
  [UserRole.CALL_CENTER]: {
    modules: {

      [Modules.COMMANDES]: [
        Action.CREATE,
        Action.READ,
        Action.UPDATE,
        Action.PRINT,
      ],

      [Modules.DASHBOARD]: [Action.READ],

      [Modules.CLIENTS]: [Action.CREATE, Action.READ, Action.UPDATE],
      [Modules.MENUS]: [Action.READ],
      [Modules.INVENTAIRE]: [Action.READ],
      [Modules.PROMOTIONS]: [Action.READ],
      [Modules.FIDELITE]: [Action.READ, Action.UPDATE],
      [Modules.CARD_NATION]: [Action.READ, Action.CREATE],

      [Modules.MESSAGES]: [Action.READ, Action.CREATE, Action.UPDATE],
    },
  },

  /* ===================== MANAGER (PDV) ===================== */
  [UserRole.MANAGER]: {
    modules: {
      [Modules.DASHBOARD]: [Action.READ],

      [Modules.COMMANDES]: [Action.READ, Action.UPDATE, Action.PRINT],
      [Modules.INVENTAIRE]: [Action.READ, Action.UPDATE],
      [Modules.PERSONNELS]: [Action.CREATE, Action.READ, Action.UPDATE],
      [Modules.MENUS]: [Action.READ],
      [Modules.CLIENTS]: [Action.READ],
    },
  },

  /* ===================== ASSISTANT MANAGER ===================== */
  [UserRole.ASSISTANT_MANAGER]: {
    modules: {
      [Modules.DASHBOARD]: [Action.READ],
      [Modules.COMMANDES]: [Action.READ, Action.UPDATE, Action.PRINT],
      [Modules.INVENTAIRE]: [Action.READ, Action.UPDATE],
      [Modules.PERSONNELS]: [Action.CREATE, Action.READ, Action.UPDATE],
      [Modules.MENUS]: [Action.READ],
      [Modules.CLIENTS]: [Action.READ],
    },
  },

  /* ===================== CAISSIER ===================== */
  [UserRole.CAISSIER]: {
    modules: {
      [Modules.COMMANDES]: [
        Action.CREATE,
        Action.READ,
        Action.UPDATE,
        Action.PRINT,
      ],
      [Modules.MENUS]: [Action.READ],
      [Modules.CLIENTS]: [Action.READ],
      [Modules.CARD_NATION]: [Action.READ],
    },
  },

  /* ===================== CUISINE ===================== */
  [UserRole.CUISINE]: {
    modules: {
      [Modules.COMMANDES]: [Action.READ, Action.UPDATE],
    },
  },
};
