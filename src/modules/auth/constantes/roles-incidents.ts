import { UserRole } from '@prisma/client';

/**
 * Rôles des incidents sur commande (11/11), gardés par listes comme les avis
 * privés et les courses : aucun droit nouveau à distribuer, personne n'a à
 * se reconnecter.
 *
 * - VOIR : le siège sur tout le réseau, un compte de restaurant sur le sien
 *   (cloisonnement fait par le service sur `user.type`).
 * - SIGNALER et noter : ceux qui prennent ou servent les commandes.
 * - TRAITER partout : administrateur et call center. Manager et assistant
 *   traitent les incidents de LEUR restaurant confiés au restaurant
 *   (contrôlé au cas par cas dans `incident.rules.ts`).
 *
 * Le back-office lit ses droits dans la fiche (`droits`) : une seule règle,
 * celle du serveur.
 */
export const ROLES_LECTURE_INCIDENT = [
  UserRole.ADMIN,
  UserRole.CALL_CENTER,
  UserRole.MARKETING,
  UserRole.LIVRAISON_OPS,
  UserRole.MANAGER,
  UserRole.ASSISTANT_MANAGER,
  UserRole.CAISSIER,
] as const;

export const ROLES_SIGNALEMENT_INCIDENT = [
  UserRole.ADMIN,
  UserRole.CALL_CENTER,
  UserRole.MANAGER,
  UserRole.ASSISTANT_MANAGER,
  UserRole.CAISSIER,
] as const;

/** Traitent tous les incidents, changent le responsable, rouvrent. */
export const ROLES_SIEGE_INCIDENT = [UserRole.ADMIN, UserRole.CALL_CENTER] as const;

/** Traitent les incidents de leur restaurant confiés au restaurant. */
export const ROLES_RESTAURANT_INCIDENT = [UserRole.MANAGER, UserRole.ASSISTANT_MANAGER] as const;

/** Tous ceux qui peuvent traiter au moins un incident (garde des routes ; le service tranche). */
export const ROLES_TRAITEMENT_INCIDENT = [...ROLES_SIEGE_INCIDENT, ...ROLES_RESTAURANT_INCIDENT] as const;
