/**
 * Interfaces TypeScript pour les callbacks (webhooks) HubRise.
 * Basé sur la documentation : https://developers.hubrise.com/api/callbacks
 *
 * HubRise envoie des requêtes POST à l'URL de callback configurée.
 * Chaque requête porte l'en-tête X-HubRise-Hmac-SHA256 : HMAC-SHA256 en
 * hexadécimal du corps brut, clé = client_secret.
 *
 * Relance (réponse 5xx ou délai de 20 s dépassé) : 6 tentatives, attente
 * d'une minute doublée à chaque essai, 32 minutes au plus. Tout code 200 à
 * 499 vaut accusé de réception.
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
  /** Signature HMAC-SHA256 du body brut, en hexadécimal, clé = client_secret (header X-HubRise-Hmac-SHA256) */
  'x-hubrise-hmac-sha256'?: string;
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
