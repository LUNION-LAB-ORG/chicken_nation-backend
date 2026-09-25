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
  /**
   * Lecture seule sur les menus Menu, Base de données (Clients, Notes et avis,
   * CRM), Fidélisation, Inventaire, Restaurant, Marketing et Notifications :
   * il voit tout, il ne crée, ne modifie, ne supprime et n'exporte rien
   * (demande du 25/09). REPORT = statistiques en lecture. Seule exception,
   * voulue : les Diffusions de messages, qu'il continue d'envoyer.
   */
  [UserRole.MARKETING]: {
    modules: {
      [Modules.DASHBOARD]: [Action.READ],

      [Modules.MENUS]: [Action.READ],
      [Modules.INVENTAIRE]: [Action.READ],
      [Modules.PROMOTIONS]: [Action.READ],
      [Modules.FIDELITE]: [Action.READ],
      [Modules.CARD_NATION]: [Action.READ, Action.REPORT],
      [Modules.RESTAURANTS]: [Action.READ],

      [Modules.CLIENTS]: [Action.READ],
      [Modules.COMMENTAIRES]: [Action.READ],
      [Modules.COMMANDES]: [Action.READ],
      [Modules.MARKETING]: [Action.READ, Action.REPORT],
      [Modules.NOTIFICATIONS]: [Action.READ],
      [Modules.BASE_DONNEES]: [Action.READ, Action.REPORT],
      // CRM en consultation : tableaux de bord, contacts et fiches (téléphone
      // compris), campagnes, coupons, ventes et réglages, sans aucun geste.
      [Modules.CRM]: [Action.READ, Action.REPORT],
      // Diffusions de messages : il garde la création et l'envoi.
      [Modules.DIFFUSIONS]: [Action.READ, Action.CREATE, Action.UPDATE],
    },
  },

  /* ===================== COMPTABLE ===================== */
  [UserRole.COMPTABLE]: {
    modules: {
      [Modules.DASHBOARD]: [Action.READ, Action.EXPORT],

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
        Action.UPDATE_FULL,
        Action.PRINT,
      ],

      [Modules.DASHBOARD]: [Action.READ],

      [Modules.CLIENTS]: [Action.CREATE, Action.READ, Action.UPDATE, Action.EXPORT],
      [Modules.MENUS]: [Action.READ],
      [Modules.INVENTAIRE]: [Action.READ],
      [Modules.PROMOTIONS]: [Action.READ],
      [Modules.FIDELITE]: [Action.READ, Action.UPDATE],
      [Modules.CARD_NATION]: [Action.READ, Action.CREATE],
      // Export CSV des avis gardé (le bouton exige désormais EXPORT).
      [Modules.COMMENTAIRES]: [Action.READ, Action.EXPORT],

      [Modules.MESSAGES]: [Action.READ, Action.CREATE, Action.UPDATE],

      // Appels internes : le call center appelle les restaurants et reçoit leurs appels.
      [Modules.CALLS]: [Action.READ],

      // Acquisition Glovo/Yango : le call center a les MÊMES droits que l'admin
      // sur ce module (tableau de bord, contacts + fiche, vérification/file J+1,
      // coupons, ventes, export, capture, suppression). Limité à BASE_DONNEES.
      [Modules.BASE_DONNEES]: Object.values(Action),

      // CRM : l'agent traite SES contacts et la file commune Glovo/Yango
      // (appel, raison, commentaire, coupon), et consulte les tableaux de bord.
      // Ni création de campagne, ni réglages, ni export : le cahier réserve ces
      // gestes à la direction. Le pilote d'une campagne gère en plus son
      // équipe, contrôlé au cas par cas côté service.
      [Modules.CRM]: [Action.READ, Action.UPDATE, Action.REPORT],
    },
  },

  /* ===================== MANAGER (PDV) ===================== */
  [UserRole.MANAGER]: {
    modules: {
      [Modules.DASHBOARD]: [Action.READ],

      // Store : lecture + saisie des contacts (aucune autre action)
      [Modules.BASE_DONNEES]: [Action.READ, Action.CREATE],
      [Modules.COMMANDES]: [Action.READ, Action.UPDATE, Action.UPDATE_FULL, Action.PRINT],
      [Modules.INVENTAIRE]: [Action.READ, Action.UPDATE],
      [Modules.PERSONNELS]: [Action.CREATE, Action.READ, Action.UPDATE],
      [Modules.MENUS]: [Action.READ],
      /**
       * Base de données, en lecture et pour SON restaurant seulement (demande du
       * 25/09) : Clients (déjà cloisonné, export gardé), Notes et avis et CRM
       * en consultation. Le cloisonnement se fait côté serveur sur le
       * restaurant du compte (UserType.RESTAURANT), jamais sur un paramètre.
       */
      [Modules.CLIENTS]: [Action.READ, Action.EXPORT],
      [Modules.COMMENTAIRES]: [Action.READ],
      [Modules.CRM]: [Action.READ, Action.REPORT],
      /**
       * Messagerie : indispensable pour les GROUPES internes, que seuls les
       * responsables peuvent ouvrir. Sans ce droit, un gestionnaire ne pouvait
       * même pas atteindre l'écran Messages, et la règle « les gestionnaires
       * créent les groupes » serait restée lettre morte.
       *
       * ⚠️ READ et CREATE seulement, et c'est délibéré : la messagerie
       * n'utilise rien d'autre, tandis que `Modules.MESSAGES` garde AUSSI les
       * catégories de tickets du support, où UPDATE et DELETE donneraient le
       * routage des tickets de tout le réseau. On n'accorde que le strict
       * nécessaire.
       */
      [Modules.MESSAGES]: [Action.READ, Action.CREATE],
      // Appels internes : le manager appelle le call center et reçoit ses appels.
      [Modules.CALLS]: [Action.READ],
    },
  },

  /* ===================== ASSISTANT MANAGER ===================== */
  [UserRole.ASSISTANT_MANAGER]: {
    modules: {
      [Modules.DASHBOARD]: [Action.READ],
      // Store : lecture + saisie des contacts (aucune autre action)
      [Modules.BASE_DONNEES]: [Action.READ, Action.CREATE],
      [Modules.COMMANDES]: [Action.READ, Action.UPDATE, Action.UPDATE_FULL, Action.PRINT],
      [Modules.INVENTAIRE]: [Action.READ, Action.UPDATE],
      [Modules.PERSONNELS]: [Action.CREATE, Action.READ, Action.UPDATE],
      [Modules.MENUS]: [Action.READ],
      [Modules.CLIENTS]: [Action.READ, Action.EXPORT],
      /**
       * Messagerie : indispensable pour les GROUPES internes, que seuls les
       * responsables peuvent ouvrir. Sans ce droit, un gestionnaire ne pouvait
       * même pas atteindre l'écran Messages, et la règle « les gestionnaires
       * créent les groupes » serait restée lettre morte.
       *
       * ⚠️ READ et CREATE seulement, et c'est délibéré : la messagerie
       * n'utilise rien d'autre, tandis que `Modules.MESSAGES` garde AUSSI les
       * catégories de tickets du support, où UPDATE et DELETE donneraient le
       * routage des tickets de tout le réseau. On n'accorde que le strict
       * nécessaire.
       */
      [Modules.MESSAGES]: [Action.READ, Action.CREATE],
      // Appels internes : l'assistant manager appelle le call center et reçoit ses appels.
      [Modules.CALLS]: [Action.READ],
    },
  },

  /* ===================== CAISSIER ===================== */
  [UserRole.CAISSIER]: {
    modules: {
      [Modules.COMMANDES]: [
        Action.CREATE,
        Action.READ,
        Action.UPDATE,
        Action.UPDATE_FULL,
        Action.PRINT,
      ],
      [Modules.MENUS]: [Action.READ],
      [Modules.CLIENTS]: [Action.READ, Action.EXPORT],
      [Modules.CARD_NATION]: [Action.READ],
      // Export CSV des avis gardé (le bouton exige désormais EXPORT).
      [Modules.COMMENTAIRES]: [Action.READ, Action.EXPORT],
      [Modules.MESSAGES]: [Action.READ, Action.CREATE, Action.UPDATE],

      // Appels internes : le caissier appelle le call center et reçoit ses appels.
      [Modules.CALLS]: [Action.READ],

      // Store : lecture + saisie des contacts (aucune autre action)
      [Modules.BASE_DONNEES]: [Action.READ, Action.CREATE],
    },
  },

  /* ===================== CUISINE ===================== */
  [UserRole.CUISINE]: {
    modules: {
      [Modules.COMMANDES]: [Action.READ, Action.UPDATE],
    },
  },
};
