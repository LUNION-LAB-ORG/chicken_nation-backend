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

// ============================================================
// APPELS AVEC LES LIVREURS (demande du 24/10)
// ============================================================

/**
 * Réglage (table des réglages) : appels dans l'appli avec les livreurs.
 * `1` (ou absent) : actifs ; `0` : les routes livreur répondent
 * `APPELS_LIVREURS_DESACTIVES` et l'appli passe au téléphone.
 */
export const CALLS_LIVREURS_ACTIF_KEY = 'calls.livreurs_actif';

/** Nature de la cible quand le service client appelle un livreur. */
export const CIBLE_LIVREUR = 'DELIVERER';

/** `callerType` des événements et de l'historique quand c'est un livreur qui appelle. */
export const APPELANT_LIVREUR = 'DELIVERER';

/** Ce que voit le livreur de l'autre côté de la ligne. */
export const LIBELLE_SERVICE_CLIENT = 'Service client';

/** Numéro du service client : repli de l'appli quand l'appel dans l'appli est impossible. */
export const TELEPHONE_SERVICE_CLIENT = '+2252721712130';

/**
 * Sonnerie d'un appel avec un livreur : sans réponse au bout de 45 s, l'appel
 * est manqué (MISSED) et les deux côtés reçoivent `call:ended` (`no-answer`).
 * Même durée que la sonnerie du backoffice.
 */
export const SONNERIE_LIVREUR_MS = 45_000;

/** Marge après la sonnerie avant qu'un appel encore « RINGING » soit tenu pour manqué (serveur redémarré). */
export const MARGE_SONNERIE_LIVREUR_MS = 15_000;

/** Au-delà, un appel ONGOING est un appel fantôme (appli fermée sans raccrocher). */
export const APPEL_FANTOME_MS = 4 * 60 * 60 * 1000;

/**
 * Jeton de participant d'un livreur : aussi long que l'appel le plus long
 * toléré (4 h, `APPEL_FANTOME_MS`). Le SDK Lunion se reconnecte avec le jeton
 * d'origine (coupure de réseau, changement d'antenne) et le serveur Lunion
 * refuse un jeton échu : avec 30 min, un appel plus long, sonnerie comprise,
 * était coupé à la première coupure (relecture du 24/10). Le jeton ne vaut
 * que pour la salle de CET appel.
 */
export const TTL_JETON_LIVREUR_S = APPEL_FANTOME_MS / 1000;

/** Rôles du personnel qui appellent un livreur : le service client et l'admin. */
export const ROLES_APPEL_LIVREUR: readonly UserRole[] = [UserRole.ADMIN, UserRole.CALL_CENTER];

/** Codes machine des refus vus par l'appli du livreur (champ `code` du corps d'erreur). */
export const CODES_APPEL_LIVREUR = {
  /** Réglage `calls.livreurs_actif` à 0. */
  DESACTIVES: 'APPELS_LIVREURS_DESACTIVES',
  /** Le livreur a déjà un appel qui sonne ou en cours. */
  EN_COURS: 'APPEL_EN_COURS',
  /** Personne au service client à faire sonner. */
  AUCUN_AGENT: 'AUCUN_AGENT',
  /** Lunion Meet ne répond pas : pas de salle, pas de jeton. */
  INDISPONIBLES: 'APPELS_INDISPONIBLES',
} as const;

/** Raison de fin portée par `call:ended`. */
export type RaisonFinAppel = 'hangup' | 'no-answer' | 'cancelled' | 'rejected';

// ============================================================
// APPELS AVEC LES CLIENTS, DANS L'APPLI CHICKEN NATION (demande du 26/11)
// ============================================================

/**
 * Réglage (table des réglages) : appels dans l'appli avec les clients.
 * `1` (ou absent) : actifs ; `0` : les routes client répondent
 * `APPELS_CLIENTS_DESACTIVES` et l'appli passe au téléphone.
 */
export const CALLS_CLIENTS_ACTIF_KEY = 'calls.clients_actif';

/** Nature de la cible quand le service client appelle un client. */
export const CIBLE_CLIENT = 'CUSTOMER';

/** `callerType` des événements et de l'historique quand c'est un client qui appelle. */
export const APPELANT_CLIENT = 'CUSTOMER';

/** Ce que voient le personnel et le livreur de l'autre côté de la ligne. */
export const LIBELLE_CLIENT = 'Client';

/** Ce que voit le client quand il appelle le livreur de sa commande. */
export const LIBELLE_LIVREUR = 'Votre livreur';

/** Qui le client a au bout du fil : le service client ou le livreur de sa commande. */
export type CorrespondantClient = 'SERVICE_CLIENT' | 'LIVREUR';

/** Rôles du personnel qui appellent un client dans l'appli : le service client et l'admin. */
export const ROLES_APPEL_CLIENT: readonly UserRole[] = [UserRole.ADMIN, UserRole.CALL_CENTER];

/** Jeton de participant d'un client : comme celui d'un livreur (durée de l'appel le plus long toléré). */
export const TTL_JETON_CLIENT_S = TTL_JETON_LIVREUR_S;

/**
 * L'appli du client dit qu'elle sait prendre un appel à chaque ouverture
 * (`Customer.appels_appli_at`). Sans nouvelle depuis ce délai (appli
 * désinstallée, téléphone changé), le service client appelle au téléphone.
 */
export const APPLI_CLIENT_PRETE_JOURS = 45;

/** `appels_appli_at` n'est réécrit qu'une fois par jour au plus. */
export const APPLI_CLIENT_RAFRAICHIE_MS = 24 * 60 * 60 * 1000;

/**
 * Un client passe au plus 6 appels en 10 minutes (service client et livreur
 * confondus) : au-delà, l'appli passe au téléphone. Chaque appel fait sonner
 * tous les postes du service client.
 */
export const APPELS_CLIENT_MAX = 6;
export const APPELS_CLIENT_FENETRE_MS = 10 * 60 * 1000;

/** Codes machine des refus vus par l'appli du client et par le back-office. */
export const CODES_APPEL_CLIENT = {
  /** Réglage `calls.clients_actif` à 0. */
  DESACTIVES: 'APPELS_CLIENTS_DESACTIVES',
  /** Le client a déjà un appel qui sonne ou en cours. */
  EN_COURS: 'APPEL_EN_COURS',
  /** Personne au service client à faire sonner. */
  AUCUN_AGENT: 'AUCUN_AGENT',
  /** Lunion Meet ne répond pas : pas de salle, pas de jeton. */
  INDISPONIBLES: 'APPELS_INDISPONIBLES',
  /** Pas de livreur de chez nous sur cette commande (pas encore parti, déjà livré, livreur partenaire). */
  LIVREUR_INJOIGNABLE: 'LIVREUR_INJOIGNABLE',
  /** Le livreur est déjà en ligne. */
  LIVREUR_OCCUPE: 'LIVREUR_OCCUPE',
  /** L'appli du client ne sait pas (ou plus) prendre un appel : téléphone. */
  SANS_APPLI: 'CLIENT_SANS_APPLI',
  /** Trop d'appels du même client en peu de temps : téléphone. */
  TROP_D_APPELS: 'TROP_D_APPELS',
} as const;
