import { ForbiddenException } from '@nestjs/common';
import { User, UserRole, UserType } from '@prisma/client';
import { isStoreRole, STORE_ROLES } from './staff-type.helper';

/**
 * Règles du module Personnel pour un compte qui n'est pas ADMIN.
 *
 * Revue 25/09 : un MANAGER ou un ASSISTANT_MANAGER (droits PERSONNELS
 * CREATE/READ/UPDATE) créait un ADMIN par POST /users, se promouvait ADMIN par
 * PATCH /users/<son id>, et réinitialisait, suspendait ou restaurait n'importe
 * quel compte du réseau, siège compris. Le mot de passe réinitialisé lui étant
 * renvoyé en clair, il prenait la main sur le compte de son choix.
 *
 * Règles retenues :
 *  - l'ADMIN gère tout le monde ;
 *  - les autres ne gèrent que le personnel de LEUR restaurant, et seulement un
 *    rang strictement inférieur au leur : un ASSISTANT_MANAGER ne touche pas un
 *    MANAGER, un MANAGER ne touche pas un autre MANAGER ;
 *  - personne, sauf l'ADMIN, ne touche un compte du siège ;
 *  - les rôles qu'un non-ADMIN peut attribuer suivent la même règle (ceux que
 *    proposait déjà le backoffice : un manager crée assistant, caissier et
 *    cuisine ; un assistant crée caissier et cuisine).
 */

export const MESSAGE_HORS_RESTAURANT =
  'Vous ne pouvez gérer que le personnel de votre restaurant.';

export const MESSAGE_ROLE_INTERDIT = "Vous n'avez pas le droit d'attribuer ce rôle.";

/**
 * UUID impossible : un compte de restaurant sans restaurant rattaché ne voit
 * aucun membre, au lieu de voir tout le réseau.
 */
export const AUCUN_RESTAURANT = '00000000-0000-0000-0000-000000000000';

/** Rang d'un rôle de point de vente. Les rôles du siège n'en ont pas. */
const RANG_MAGASIN: Partial<Record<UserRole, number>> = {
  [UserRole.MANAGER]: 3,
  [UserRole.ASSISTANT_MANAGER]: 2,
  [UserRole.CAISSIER]: 1,
  [UserRole.CUISINE]: 1,
};

/** Ce que les règles lisent d'un compte : jamais le mot de passe. */
export type ComptePersonnel = Pick<User, 'id' | 'role' | 'restaurant_id'> &
  Partial<Pick<User, 'type'>>;

export function estAdministrateur(compte: Pick<User, 'role'> | null | undefined): boolean {
  return compte?.role === UserRole.ADMIN;
}

function rang(role: UserRole): number {
  return RANG_MAGASIN[role] ?? 0;
}

/** Rôles qu'un compte peut donner, à la création comme à la modification. */
export function rolesAttribuables(acteur: ComptePersonnel): UserRole[] {
  if (estAdministrateur(acteur)) return Object.values(UserRole);
  const rangActeur = rang(acteur.role);
  if (!rangActeur || !acteur.restaurant_id) return [];
  return STORE_ROLES.filter((role) => rang(role) < rangActeur);
}

export function assertPeutAttribuerRole(acteur: ComptePersonnel, role: UserRole): void {
  if (!rolesAttribuables(acteur).includes(role)) {
    throw new ForbiddenException(MESSAGE_ROLE_INTERDIT);
  }
}

/**
 * Le compte `acteur` peut-il réinitialiser le mot de passe, suspendre,
 * restaurer, modifier ou supprimer le compte `cible` ?
 */
export function peutGererMembre(acteur: ComptePersonnel, cible: ComptePersonnel): boolean {
  if (estAdministrateur(acteur)) return true;
  const rangActeur = rang(acteur.role);
  const rangCible = rang(cible.role);
  return (
    rangActeur > 0 &&
    rangCible > 0 &&
    !!acteur.restaurant_id &&
    cible.restaurant_id === acteur.restaurant_id &&
    rangCible < rangActeur
  );
}

export function assertPeutGererMembre(acteur: ComptePersonnel, cible: ComptePersonnel): void {
  if (!peutGererMembre(acteur, cible)) {
    throw new ForbiddenException(MESSAGE_HORS_RESTAURANT);
  }
}

/** Compte rattaché à un point de vente, par son type ou par son rôle. */
export function estCompteDeRestaurant(compte: ComptePersonnel): boolean {
  return compte.type === UserType.RESTAURANT || isStoreRole(compte.role);
}

/**
 * Restaurant dont la liste du personnel est visible (GET /users).
 *  - compte de restaurant : TOUJOURS le sien, le paramètre reçu est ignoré ;
 *  - compte du siège : le filtre de l'onglet, ou tout le réseau sans filtre.
 */
export function restaurantDuPersonnelVisible(
  acteur: ComptePersonnel,
  restaurantDemande?: string,
): string | undefined {
  if (estCompteDeRestaurant(acteur)) {
    return acteur.restaurant_id ?? AUCUN_RESTAURANT;
  }
  return restaurantDemande || undefined;
}

/**
 * Restaurant de rattachement d'un nouveau membre.
 *  - ADMIN : celui qu'il choisit (à défaut, le sien si `restaurantParDefaut`) ;
 *  - autres : TOUJOURS le leur. Un autre restaurant demandé est refusé.
 * Un rôle du siège n'est rattaché à aucun restaurant.
 */
export function restaurantDuNouveauMembre(
  acteur: ComptePersonnel,
  role: UserRole,
  restaurantDemande: string | null | undefined,
  options: { restaurantParDefaut?: boolean } = {},
): string | null {
  if (!estAdministrateur(acteur)) {
    if (restaurantDemande && restaurantDemande !== acteur.restaurant_id) {
      throw new ForbiddenException(MESSAGE_HORS_RESTAURANT);
    }
    return isStoreRole(role) ? acteur.restaurant_id ?? null : null;
  }
  if (!isStoreRole(role)) return null;
  if (restaurantDemande) return restaurantDemande;
  return options.restaurantParDefaut ? acteur.restaurant_id ?? null : null;
}
