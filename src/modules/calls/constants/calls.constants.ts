import { UserRole, UserType } from '@prisma/client';

/** Clé Setting (JSON) du routage configurable des appels (admin uniquement). */
export const CALLS_ROLES_CONFIG_KEY = 'calls.roles_config';

/** Nature de la cible d'un appel. */
export type CallTargetKind = 'RESTAURANT' | 'CALL_CENTER';

/**
 * Config de routage pour un type d'appelant.
 * - `canCall`       : ce type peut-il initier un appel ?
 * - `targetKind`    : nature de la cible (un restaurant précis, ou le call center).
 * - `receiverType`  : type d'utilisateur des receveurs.
 * - `receiverRoles` : rôles éligibles à recevoir (vide = tous les rôles du type).
 */
export interface CallerRoleConfig {
  canCall: boolean;
  targetKind: CallTargetKind;
  receiverType: UserType;
  receiverRoles: UserRole[];
}

export type CallsRolesConfig = Record<UserType, CallerRoleConfig>;

/**
 * Config par défaut (cahier des charges CEO) :
 * - un appelant BACKOFFICE appelle un RESTAURANT → sonne CAISSIER, MANAGER, ASSISTANT_MANAGER
 * - un appelant RESTAURANT appelle le CALL CENTER → sonne le rôle CALL_CENTER (BACKOFFICE)
 * Surchargeable via le Setting `calls.roles_config` (Paramètres → Appels, admin seul).
 */
export const DEFAULT_CALLS_ROLES_CONFIG: CallsRolesConfig = {
  [UserType.BACKOFFICE]: {
    canCall: true,
    targetKind: 'RESTAURANT',
    receiverType: UserType.RESTAURANT,
    receiverRoles: [UserRole.CAISSIER, UserRole.MANAGER, UserRole.ASSISTANT_MANAGER],
  },
  [UserType.RESTAURANT]: {
    canCall: true,
    targetKind: 'CALL_CENTER',
    receiverType: UserType.BACKOFFICE,
    receiverRoles: [UserRole.CALL_CENTER],
  },
};

/** Événements Socket.io du cycle de vie d'un appel (namespace /app). */
export const CALL_EVENTS = {
  INCOMING: 'call:incoming', // → receveurs : un appel arrive (sonnerie)
  ACCEPTED: 'call:accepted', // → appelant : un receveur a décroché
  TAKEN: 'call:taken', // → autres receveurs : appel déjà pris, arrêter de sonner
  REJECTED: 'call:rejected', // → appelant : un receveur a refusé (info non bloquante)
  CANCELLED: 'call:cancelled', // → receveurs : l'appelant a annulé avant décrochage
  ENDED: 'call:ended', // → l'autre partie : appel terminé
} as const;
