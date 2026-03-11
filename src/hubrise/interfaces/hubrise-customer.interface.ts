/**
 * Interfaces TypeScript pour les clients HubRise.
 * Basé sur la documentation : https://developers.hubrise.com/api/customers
 *
 * La clé de rapprochement principale avec Chicken Nation est le téléphone (Customer.phone).
 * HubRise permet aussi l'email, mais dans CN le phone est obligatoire et unique.
 *
 * ⚠️ Les clients HubRise sans téléphone ne peuvent pas être synchronisés avec CN.
 */

import { HubriseAddress } from './hubrise-order.interface';

// === Client HubRise complet ===
export interface HubriseCustomer {
  /** ID unique dans HubRise */
  id: string;
  /** Référence privée (peut stocker l'ID CN) */
  private_ref?: string | null;
  /** Prénom — correspond à Customer.first_name dans CN */
  first_name?: string | null;
  /** Nom — correspond à Customer.last_name dans CN */
  last_name?: string | null;
  /** Email — correspond à Customer.email dans CN (unique mais optionnel) */
  email?: string | null;
  /** Téléphone — CLÉ PRINCIPALE de rapprochement avec CN (Customer.phone, unique, obligatoire) */
  phone?: string | null;
  /** Numéro alternatif */
  phone_access_code?: string | null;
  /** Adresse par défaut */
  address?: HubriseAddress;
  /** Liste d'adresses */
  addresses?: HubriseAddress[];
  /** Nombre de commandes passées */
  order_count?: number;
  /** Montant total dépensé */
  order_total?: string;
  /** Solde fidélité */
  loyalty_balance?: string;
  /** Cartes de fidélité */
  loyalty_cards?: HubriseLoyaltyCard[];
  /** Informations personnalisées */
  custom_fields?: Record<string, unknown>;
  /** Date de création */
  created_at?: string;
  /** Date de dernière modification */
  updated_at?: string;
}

// === Carte de fidélité HubRise ===
export interface HubriseLoyaltyCard {
  /** Nom du programme */
  name?: string;
  /** Référence */
  ref?: string;
  /** Solde de points */
  balance?: string;
}

// === Payload pour créer/mettre à jour un client HubRise ===
export interface HubriseCustomerPayload {
  /** Référence privée (ID CN) */
  private_ref?: string;
  /** Prénom */
  first_name?: string;
  /** Nom */
  last_name?: string;
  /** Email */
  email?: string;
  /** Téléphone */
  phone?: string;
  /** Adresse */
  address?: HubriseAddress;
}

// === Réponse paginée de la liste des clients ===
export interface HubriseCustomerListResponse {
  data: HubriseCustomer[];
  cursor?: string;
}
