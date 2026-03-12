/**
 * Constantes des endpoints de l'API HubRise.
 * Base URL : https://api.hubrise.com/v1
 * Documentation : https://developers.hubrise.com/api/general-concepts
 *
 * ⚠️ IMPORTANT : Quand on utilise un token scopé à un location (ce qui est le cas
 * après OAuth), les URLs utilisent `/location/` (singulier, sans ID).
 * HubRise résout automatiquement le location depuis le token.
 *
 * Format : /v1/location/orders   (pas /v1/locations/{id}/orders)
 */

// URL de base de l'API HubRise
export const HUBRISE_API_BASE_URL = 'https://api.hubrise.com/v1';

// URL de base OAuth HubRise
export const HUBRISE_OAUTH_BASE_URL = 'https://manager.hubrise.com/oauth2/v1';

// === Endpoints OAuth ===
export const HUBRISE_OAUTH = {
  /** Page d'autorisation — redirige l'utilisateur pour connexion */
  AUTHORIZE: `${HUBRISE_OAUTH_BASE_URL}/authorize`,
  /** Échange du code d'autorisation contre un access_token */
  TOKEN: `${HUBRISE_OAUTH_BASE_URL}/token`,
  /** Révocation d'un token (POST avec Basic Auth) */
  REVOKE: `${HUBRISE_OAUTH_BASE_URL}/revoke`,
} as const;

// === Endpoints Commandes (token-scoped → /location/) ===
export const HUBRISE_ORDERS = {
  /** Liste les commandes du location (GET) */
  LIST: `${HUBRISE_API_BASE_URL}/location/orders`,
  /** Crée une commande (POST) */
  CREATE: `${HUBRISE_API_BASE_URL}/location/orders`,
  /** Récupère une commande par ID (GET) */
  GET: (orderId: string) =>
    `${HUBRISE_API_BASE_URL}/location/orders/${orderId}`,
  /** Met à jour une commande (PUT/PATCH) */
  UPDATE: (orderId: string) =>
    `${HUBRISE_API_BASE_URL}/location/orders/${orderId}`,
} as const;

// === Endpoints Catalogue ===
export const HUBRISE_CATALOGS = {
  /** Récupère un catalogue complet (GET) */
  GET: (catalogId: string) =>
    `${HUBRISE_API_BASE_URL}/catalogs/${catalogId}`,
  /** Pousse (met à jour) un catalogue entier (PUT) */
  PUSH: (catalogId: string) =>
    `${HUBRISE_API_BASE_URL}/catalogs/${catalogId}`,
} as const;

// === Endpoints Clients (token-scoped) ===
export const HUBRISE_CUSTOMERS = {
  /** Liste les listes de clients du location (GET) */
  CUSTOMER_LISTS: `${HUBRISE_API_BASE_URL}/location/customer_lists`,
  /** Liste les clients d'une customer_list (GET) */
  LIST: (customerListId: string) =>
    `${HUBRISE_API_BASE_URL}/customer_lists/${customerListId}/customers`,
  /** Recherche un client (GET avec paramètres) */
  SEARCH: (customerListId: string) =>
    `${HUBRISE_API_BASE_URL}/customer_lists/${customerListId}/customers`,
  /** Récupère un client par ID (GET) */
  GET: (customerListId: string, customerId: string) =>
    `${HUBRISE_API_BASE_URL}/customer_lists/${customerListId}/customers/${customerId}`,
  /** Crée un client (POST) */
  CREATE: (customerListId: string) =>
    `${HUBRISE_API_BASE_URL}/customer_lists/${customerListId}/customers`,
  /** Met à jour un client (PUT) */
  UPDATE: (customerListId: string, customerId: string) =>
    `${HUBRISE_API_BASE_URL}/customer_lists/${customerListId}/customers/${customerId}`,
} as const;

// === Endpoints Callback (webhook) — token-scoped ===
export const HUBRISE_CALLBACKS = {
  /** Récupère le callback actif (GET) */
  GET: `${HUBRISE_API_BASE_URL}/callback`,
  /** Crée ou met à jour le callback (POST) */
  CREATE: `${HUBRISE_API_BASE_URL}/callback`,
  /** Supprime le callback (DELETE) */
  DELETE: `${HUBRISE_API_BASE_URL}/callback`,
  /** Récupère les événements en attente — polling (GET) */
  EVENTS: `${HUBRISE_API_BASE_URL}/callback/events`,
} as const;

// === Endpoints Location (token-scoped) ===
export const HUBRISE_LOCATIONS = {
  /** Récupère les infos du location associé au token (GET) */
  GET: `${HUBRISE_API_BASE_URL}/location`,
} as const;

// === Limites API ===
export const HUBRISE_RATE_LIMIT = {
  /** Nombre max de requêtes par période (sliding window de 30 secondes) */
  MAX_REQUESTS: 500,
  /** Période en millisecondes (30 secondes) */
  WINDOW_MS: 30_000,
} as const;
