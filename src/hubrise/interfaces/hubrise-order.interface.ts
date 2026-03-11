/**
 * Interfaces TypeScript pour les commandes HubRise.
 * Basé sur la documentation : https://developers.hubrise.com/api/orders
 *
 * Le format monétaire HubRise est une chaîne "montant devise", ex: "8.90 EUR".
 * Les dates sont au format ISO 8601.
 */

import { HubriseOrderStatus, HubriseServiceType } from '../constants/hubrise-status-mapping.constant';

// === Montant HubRise (ex: "8.90 EUR") ===
export type HubriseMoney = string;

// === Item d'une commande HubRise ===
export interface HubriseOrderItem {
  /** Identifiant unique de l'item dans HubRise */
  product_name: string;
  /** Référence du produit dans le catalogue (correspond à Dish.reference dans CN) */
  sku_ref?: string | null;
  /** Nom du SKU */
  sku_name?: string | null;
  /** Référence du produit */
  ref?: string | null;
  /** Prix unitaire (format "8.90 EUR") */
  price: HubriseMoney;
  /** Quantité commandée */
  quantity: string;
  /** Sous-total (prix × quantité) */
  subtotal?: HubriseMoney;
  /** Options sélectionnées (suppléments dans CN) */
  options?: HubriseOrderItemOption[];
}

// === Option d'un item (correspond aux Supplements dans CN) ===
export interface HubriseOrderItemOption {
  /** Nom du groupe d'options */
  option_list_name?: string;
  /** Nom de l'option choisie */
  name: string;
  /** Référence de l'option (correspond au Supplement.id ou nom dans CN) */
  ref?: string | null;
  /** Prix additionnel */
  price?: HubriseMoney;
  /** Quantité */
  quantity?: number;
}

// === Paiement d'une commande HubRise ===
export interface HubrisePayment {
  /** Type de paiement (cash, online, etc.) */
  type?: string;
  /** Nom du moyen de paiement */
  name?: string;
  /** Référence externe */
  ref?: string;
  /** Montant payé */
  amount: HubriseMoney;
  /** Informations complémentaires */
  info?: Record<string, unknown>;
}

// === Remise sur une commande ===
export interface HubriseDiscount {
  /** Nom de la remise */
  name: string;
  /** Référence */
  ref?: string;
  /** Montant de la réduction (négatif) */
  price_off: HubriseMoney;
}

// === Frais additionnels (livraison, service, etc.) ===
export interface HubriseCharge {
  /** Type de frais */
  type?: string;
  /** Nom du frais */
  name: string;
  /** Référence */
  ref?: string;
  /** Montant */
  price: HubriseMoney;
}

// === Livraison d'une commande ===
export interface HubriseDelivery {
  /** ID du livreur */
  driver_id?: string;
  /** Nom du livreur */
  driver_name?: string;
  /** Heure estimée de récupération */
  estimated_pickup_at?: string;
  /** Heure estimée de livraison */
  estimated_delivery_at?: string;
  /** Lien de suivi */
  tracking_url?: string;
}

// === Adresse client dans une commande HubRise ===
export interface HubriseAddress {
  /** Première ligne d'adresse */
  address_1?: string;
  /** Complément d'adresse */
  address_2?: string;
  /** Code postal */
  postal_code?: string;
  /** Ville */
  city?: string;
  /** Pays */
  country?: string;
  /** Latitude */
  latitude?: string;
  /** Longitude */
  longitude?: string;
}

// === Client associé à une commande HubRise ===
export interface HubriseOrderCustomer {
  /** ID du client dans HubRise */
  id?: string;
  /** Prénom */
  first_name?: string;
  /** Nom */
  last_name?: string;
  /** Email */
  email?: string;
  /** Téléphone (clé de rapprochement principale avec CN) */
  phone?: string;
  /** Adresse de livraison */
  address?: HubriseAddress;
}

// === Commande HubRise complète ===
export interface HubriseOrder {
  /** ID unique HubRise (ex: "5dpm9") */
  id: string;
  /** Référence privée (utilisée par le POS) */
  private_ref?: string;
  /** Statut de la commande */
  status: HubriseOrderStatus;
  /** Type de service */
  service_type?: HubriseServiceType;
  /** Référence de la collection (si besoin) */
  collection_code?: string;
  /** Items de la commande */
  items: HubriseOrderItem[];
  /** Paiements */
  payments?: HubrisePayment[];
  /** Remises */
  discounts?: HubriseDiscount[];
  /** Frais additionnels (livraison, etc.) */
  charges?: HubriseCharge[];
  /** Informations de livraison */
  delivery?: HubriseDelivery;
  /** Client */
  customer?: HubriseOrderCustomer;
  /** Montant total */
  total?: HubriseMoney;
  /** Note du client */
  customer_notes?: string;
  /** Note du restaurant */
  seller_notes?: string;
  /** Nombre de couverts */
  couvert?: number;
  /** Heure souhaitée (ASAP ou ISO 8601) */
  expected_time?: string;
  /** Heure de confirmation */
  confirmed_time?: string;
  /** Date de création */
  created_at?: string;
  /** Informations personnalisées */
  custom_fields?: Record<string, unknown>;
}

// === Réponse paginée de la liste des commandes ===
export interface HubriseOrderListResponse {
  data: HubriseOrder[];
  /** Curseur pour la pagination */
  cursor?: string;
}
