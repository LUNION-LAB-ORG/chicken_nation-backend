/**
 * Mapper bidirectionnel : HubRise Customer ↔ Chicken Nation Customer.
 *
 * Correspondances :
 * - HubriseCustomer.phone ↔ Customer.phone (CLÉ UNIQUE et obligatoire dans CN)
 * - HubriseCustomer.first_name ↔ Customer.first_name
 * - HubriseCustomer.last_name ↔ Customer.last_name
 * - HubriseCustomer.email ↔ Customer.email (unique mais optionnel dans CN)
 * - HubriseCustomer.address → Customer.addresses[] (modèle Address)
 *
 * ⚠️ Contraintes :
 * - Un client HubRise SANS téléphone ne peut pas être synchronisé avec CN.
 * - Le téléphone CN doit être au format international (ex: +22901234567).
 * - Si un client HubRise a un email déjà utilisé dans CN par un autre compte,
 *   on ne synchronise pas l'email pour éviter les conflits d'unicité.
 */

import {
  HubriseCustomer,
  HubriseCustomerPayload,
} from '../interfaces/hubrise-customer.interface';
import { HubriseAddress } from '../interfaces/hubrise-order.interface';

// ─── Customer mapping ────────────────────────────────────────────────

/**
 * Structure intermédiaire pour un client importé depuis HubRise.
 */
export interface MappedCustomer {
  /** ID HubRise du client (pour le suivi) */
  hubriseCustomerId: string;
  /** Téléphone — clé de rapprochement principale */
  phone: string | null;
  /** Prénom */
  firstName: string | null;
  /** Nom */
  lastName: string | null;
  /** Email (optionnel dans CN) */
  email: string | null;
  /** Adresses à synchroniser */
  addresses: MappedAddress[];
}

/**
 * Structure intermédiaire pour une adresse importée depuis HubRise.
 */
export interface MappedAddress {
  /** Titre/label de l'adresse */
  title: string;
  /** Adresse complète */
  address: string;
  /** Rue */
  street: string | null;
  /** Ville */
  city: string | null;
  /** Latitude */
  latitude: number;
  /** Longitude */
  longitude: number;
}

/**
 * Normalise un numéro de téléphone pour correspondre au format CN.
 * Ajoute le préfixe + si manquant, supprime les espaces/tirets.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // Supprimer espaces, tirets, points, parenthèses
  let cleaned = phone.replace(/[\s\-\.\(\)]/g, '');
  // Ajouter le + si manquant et que ça commence par un indicatif pays
  if (!cleaned.startsWith('+') && cleaned.length >= 10) {
    cleaned = `+${cleaned}`;
  }
  return cleaned || null;
}

/**
 * Transforme une adresse HubRise en adresse CN.
 */
function mapHubriseAddressToMapped(addr: HubriseAddress): MappedAddress {
  const fullAddress = [addr.address_1, addr.address_2]
    .filter(Boolean)
    .join(', ');

  return {
    title: fullAddress || 'Adresse HubRise',
    address: fullAddress,
    street: addr.address_1 ?? null,
    city: addr.city ?? null,
    latitude: addr.latitude ? parseFloat(addr.latitude) : 0,
    longitude: addr.longitude ? parseFloat(addr.longitude) : 0,
  };
}

/**
 * Transforme un client HubRise en structure intermédiaire CN.
 */
export function mapHubriseCustomerToCN(customer: HubriseCustomer): MappedCustomer {
  // Collecter toutes les adresses
  const addresses: MappedAddress[] = [];
  if (customer.address) {
    addresses.push(mapHubriseAddressToMapped(customer.address));
  }
  if (customer.addresses) {
    addresses.push(...customer.addresses.map(mapHubriseAddressToMapped));
  }

  return {
    hubriseCustomerId: customer.id,
    phone: normalizePhone(customer.phone),
    firstName: customer.first_name ?? null,
    lastName: customer.last_name ?? null,
    email: customer.email ?? null,
    addresses,
  };
}

/**
 * Transforme un client CN en payload HubRise (pour le push client).
 */
export function mapCNCustomerToHubrise(customer: {
  id: string;
  phone: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  addresses?: Array<{
    address: string;
    street?: string | null;
    city?: string | null;
    latitude: number;
    longitude: number;
  }>;
}): HubriseCustomerPayload {
  // Prendre la première adresse comme adresse par défaut
  const firstAddr = customer.addresses?.[0];

  return {
    private_ref: customer.id,
    first_name: customer.first_name ?? undefined,
    last_name: customer.last_name ?? undefined,
    email: customer.email ?? undefined,
    phone: customer.phone,
    address: firstAddr
      ? {
          address_1: firstAddr.address || firstAddr.street || '',
          city: firstAddr.city ?? undefined,
          latitude: String(firstAddr.latitude),
          longitude: String(firstAddr.longitude),
        }
      : undefined,
  };
}

/**
 * Vérifie si un client HubRise peut être synchronisé avec CN.
 * Condition principale : le téléphone doit être présent.
 */
export function canSyncCustomer(customer: HubriseCustomer): boolean {
  return !!normalizePhone(customer.phone);
}
