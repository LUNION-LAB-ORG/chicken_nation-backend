/**
 * Constantes des endpoints de l'API HubRise.
 * Base URL : https://api.hubrise.com/v1
 * Documentation : https://developers.hubrise.com/api/general-concepts
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
} as const;

// === Endpoints Commandes ===
export const HUBRISE_ORDERS = {
  /** Liste les commandes d'un location (GET) */
  LIST: (locationId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/orders`,
  /** Récupère une commande par ID (GET) */
  GET: (locationId: string, orderId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/orders/${orderId}`,
  /** Met à jour le statut d'une commande (PUT) */
  UPDATE: (locationId: string, orderId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/orders/${orderId}`,
} as const;

// === Endpoints Catalogue ===
export const HUBRISE_CATALOGS = {
  /** Liste les catalogues d'un account (GET) */
  LIST: (accountId: string) =>
    `${HUBRISE_API_BASE_URL}/accounts/${accountId}/catalogs`,
  /** Récupère un catalogue complet (GET) */
  GET: (catalogId: string) =>
    `${HUBRISE_API_BASE_URL}/catalogs/${catalogId}`,
  /** Pousse (met à jour) un catalogue entier (PUT) */
  PUSH: (catalogId: string) =>
    `${HUBRISE_API_BASE_URL}/catalogs/${catalogId}`,
} as const;

// === Endpoints Clients ===
export const HUBRISE_CUSTOMERS = {
  /** Liste les clients d'un location (GET) */
  LIST: (locationId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/customer_lists/default/customers`,
  /** Recherche un client (GET avec paramètres) */
  SEARCH: (locationId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/customer_lists/default/customers`,
  /** Récupère un client par ID (GET) */
  GET: (locationId: string, customerId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/customer_lists/default/customers/${customerId}`,
  /** Crée un client (POST) */
  CREATE: (locationId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/customer_lists/default/customers`,
  /** Met à jour un client (PUT) */
  UPDATE: (locationId: string, customerId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/customer_lists/default/customers/${customerId}`,
} as const;

// === Endpoints Callbacks (webhooks) ===
export const HUBRISE_CALLBACKS = {
  /** Liste les callbacks d'un location (GET) */
  LIST: (locationId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/callbacks`,
  /** Crée un callback (POST) */
  CREATE: (locationId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/callbacks`,
  /** Supprime un callback (DELETE) */
  DELETE: (locationId: string, callbackId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}/callbacks/${callbackId}`,
} as const;

// === Endpoints Location ===
export const HUBRISE_LOCATIONS = {
  /** Récupère les infos d'un location (GET) */
  GET: (locationId: string) =>
    `${HUBRISE_API_BASE_URL}/locations/${locationId}`,
} as const;

// === Limites API ===
export const HUBRISE_RATE_LIMIT = {
  /** Nombre max de requêtes par période (sliding window de 30 secondes) */
  MAX_REQUESTS: 500,
  /** Période en millisecondes (30 secondes) */
  WINDOW_MS: 30_000,
} as const;
