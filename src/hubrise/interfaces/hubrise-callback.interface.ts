/**
 * Interfaces TypeScript pour les callbacks (webhooks) HubRise.
 * Basé sur la documentation : https://developers.hubrise.com/api/callbacks
 *
 * HubRise envoie des requêtes POST à l'URL de callback configurée.
 * Chaque requête contient un header X-HubRise-Hmac pour la vérification HMAC-SHA256.
 *
 * Mécanisme de retry : 6 tentatives avec backoff exponentiel
 * (10s, 30s, 90s, 270s, 810s, 2430s).
 */

import { HubriseCallbackEvent } from '../constants/hubrise-status-mapping.constant';

// === Payload reçu lors d'un callback HubRise ===
export interface HubriseCallbackPayload {
  /** ID de la ressource concernée (commande, client, catalogue) */
  resource_id: string;
  /** Type de ressource */
  resource_type: 'order' | 'customer' | 'catalog' | 'location';
  /** Type d'événement (ex: "order.create", "order.update") */
  event_type: HubriseCallbackEvent;
  /** ID du compte HubRise */
  account_id: string;
  /** ID du location HubRise */
  location_id: string;
  /** Timestamp de l'événement */
  timestamp: string;
  /** URL de la ressource pour récupérer les détails */
  resource_url?: string;
}

// === Configuration d'un callback HubRise ===
// Format HubRise : events est un objet { resource: ["action", ...] }
// Exemple : { "order": ["create", "update"], "customer": ["create"] }
export interface HubriseCallbackConfig {
  /** URL de destination (notre endpoint webhook) */
  url: string;
  /** Événements auxquels s'abonner — objet imbriqué, pas un tableau plat */
  events: Record<string, string[]>;
  /** Clé secrète pour la vérification HMAC */
  secret?: string;
}

// === Réponse de création d'un callback ===
export interface HubriseCallbackResponse {
  /** ID du callback créé */
  id: string;
  /** URL configurée */
  url: string;
  /** Événements souscrits */
  events: string[];
  /** Clé HMAC (retournée uniquement à la création) */
  secret?: string;
}

// === Headers de vérification du callback ===
export interface HubriseCallbackHeaders {
  /** Signature HMAC-SHA256 du body (header X-HubRise-Hmac) */
  'x-hubrise-hmac'?: string;
  /** Timestamp du callback */
  'x-hubrise-timestamp'?: string;
}

// === Réponse attendue par HubRise après traitement du callback ===
export interface HubriseCallbackAck {
  /** Confirme le traitement (HubRise attend un 200 OK) */
  received: boolean;
  /** Détails optionnels */
  message?: string;
}
