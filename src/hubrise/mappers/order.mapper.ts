/**
 * Mapper bidirectionnel : HubRise Order ↔ Chicken Nation Order.
 *
 * Gère les transformations de :
 * - Statuts (HubriseOrderStatus ↔ OrderStatus)
 * - Types de service (service_type ↔ OrderType)
 * - Format monétaire ("8.90 EUR" → Float)
 * - Adresses (champs plats ↔ JSON)
 * - Items (HubriseOrderItem ↔ OrderItem avec Dish.reference)
 */

import { OrderStatus, OrderType } from '@prisma/client';
import {
  HUBRISE_TO_CN_STATUS,
  HUBRISE_TO_CN_ORDER_TYPE,
  CN_TO_HUBRISE_STATUS,
  CN_TO_HUBRISE_ORDER_TYPE,
  HubriseOrderStatus,
  HubriseServiceType,
} from '../constants/hubrise-status-mapping.constant';
import {
  HubriseOrder,
  HubriseOrderItem,
  HubriseAddress,
  HubriseMoney,
} from '../interfaces/hubrise-order.interface';

// ─── Utilitaires monétaires ──────────────────────────────────────────

/**
 * Parse un montant HubRise ("8.90 EUR") en nombre flottant.
 * Retourne 0 si le format est invalide.
 */
export function parseHubriseMoney(money: HubriseMoney | undefined | null): number {
  if (!money) return 0;
  // Format attendu : "8.90 EUR" ou "8.90"
  const parts = money.trim().split(/\s+/);
  const amount = parseFloat(parts[0]);
  return isNaN(amount) ? 0 : amount;
}

/**
 * Convertit un montant numérique en format HubRise ("8.90 XOF").
 * On utilise XOF car Chicken Nation opère en Franc CFA.
 */
export function toHubriseMoney(amount: number, currency = 'XOF'): HubriseMoney {
  return `${amount.toFixed(2)} ${currency}`;
}

// ─── Mapping des statuts ─────────────────────────────────────────────

/**
 * Convertit un statut HubRise en statut Chicken Nation.
 */
export function mapHubriseStatusToCN(status: HubriseOrderStatus): OrderStatus {
  return HUBRISE_TO_CN_STATUS[status] ?? OrderStatus.PENDING;
}

/**
 * Convertit un statut Chicken Nation en statut HubRise.
 */
export function mapCNStatusToHubrise(status: OrderStatus): HubriseOrderStatus {
  return CN_TO_HUBRISE_STATUS[status] ?? 'received';
}

// ─── Mapping des types de commande ───────────────────────────────────

/**
 * Convertit un service_type HubRise en OrderType Chicken Nation.
 */
export function mapHubriseServiceTypeToCN(
  serviceType: HubriseServiceType | undefined,
): OrderType {
  if (!serviceType) return OrderType.DELIVERY;
  return HUBRISE_TO_CN_ORDER_TYPE[serviceType] ?? OrderType.DELIVERY;
}

/**
 * Convertit un OrderType Chicken Nation en service_type HubRise.
 */
export function mapCNOrderTypeToHubrise(type: OrderType): HubriseServiceType {
  return CN_TO_HUBRISE_ORDER_TYPE[type] ?? 'delivery';
}

// ─── Mapping des adresses ────────────────────────────────────────────

/**
 * Transforme une adresse HubRise (champs plats) en JSON d'adresse Chicken Nation.
 * Format CN : { title, address, street?, city?, longitude, latitude, note }
 */
export function mapHubriseAddressToCN(
  address: HubriseAddress | undefined,
  note?: string,
): Record<string, unknown> {
  if (!address) {
    return {
      title: 'Adresse inconnue',
      address: '',
      longitude: 0,
      latitude: 0,
      note: note ?? '',
    };
  }

  const fullAddress = [address.address_1, address.address_2]
    .filter(Boolean)
    .join(', ');

  return {
    title: fullAddress || 'Adresse HubRise',
    address: fullAddress,
    street: address.address_1 ?? undefined,
    city: address.city ?? undefined,
    longitude: address.longitude ? parseFloat(address.longitude) : 0,
    latitude: address.latitude ? parseFloat(address.latitude) : 0,
    note: note ?? '',
  };
}

/**
 * Transforme une adresse CN (JSON) en adresse HubRise (champs plats).
 */
export function mapCNAddressToHubrise(
  addressJson: string | Record<string, unknown> | null,
): HubriseAddress | undefined {
  if (!addressJson) return undefined;

  const addr =
    typeof addressJson === 'string'
      ? (JSON.parse(addressJson) as Record<string, unknown>)
      : addressJson;

  return {
    address_1: (addr.address as string) || (addr.street as string) || '',
    city: (addr.city as string) || undefined,
    latitude: addr.latitude ? String(addr.latitude) : undefined,
    longitude: addr.longitude ? String(addr.longitude) : undefined,
  };
}

// ─── Mapping des items de commande ───────────────────────────────────

/**
 * Structure intermédiaire pour créer un OrderItem CN à partir d'un item HubRise.
 * Le dish_id sera résolu plus tard via Dish.reference.
 */
export interface MappedOrderItem {
  /** Référence du produit HubRise (correspond à Dish.reference) */
  dishReference: string | null;
  /** Nom du produit (fallback si pas de référence) */
  productName: string;
  /** Quantité */
  quantity: number;
  /** Montant total de l'item */
  amount: number;
  /** Suppléments sous forme JSON (compatible avec OrderItem.supplements) */
  supplements: Array<{
    name: string;
    ref?: string | null;
    price: number;
    quantity: number;
  }>;
}

/**
 * Transforme un item de commande HubRise en structure intermédiaire pour CN.
 * La résolution du dish_id se fait dans le service de sync.
 */
export function mapHubriseItemToCN(item: HubriseOrderItem): MappedOrderItem {
  const unitPrice = parseHubriseMoney(item.price);
  const qty = parseInt(item.quantity, 10) || 1;

  // Mapping des options → suppléments CN
  const supplements = (item.options ?? []).map((opt) => ({
    name: opt.name,
    ref: opt.ref ?? null,
    price: parseHubriseMoney(opt.price),
    quantity: opt.quantity ?? 1,
  }));

  // Calcul du montant total (prix unitaire × quantité + suppléments)
  const supplementsTotal = supplements.reduce(
    (sum, s) => sum + s.price * s.quantity,
    0,
  );
  const amount = (unitPrice + supplementsTotal) * qty;

  return {
    dishReference: item.sku_ref || item.ref || null,
    productName: item.product_name || item.sku_name || 'Produit inconnu',
    quantity: qty,
    amount,
    supplements,
  };
}

// ─── Mapping global d'une commande ───────────────────────────────────

/**
 * Structure intermédiaire pour créer une commande CN à partir d'une commande HubRise.
 * Les IDs (customer_id, restaurant_id, dish_id) seront résolus dans le service de sync.
 */
export interface MappedOrder {
  /** ID HubRise de la commande (pour le suivi) */
  hubriseOrderId: string;
  /** Statut CN */
  status: OrderStatus;
  /** Type de commande CN */
  type: OrderType;
  /** Montant total (net, hors livraison) */
  netAmount: number;
  /** Montant total (tous frais compris) */
  totalAmount: number;
  /** Frais de livraison */
  deliveryFee: number;
  /** Réduction */
  discount: number;
  /** Adresse JSON format CN */
  address: Record<string, unknown>;
  /** Note du client */
  note: string | null;
  /** Infos client pour le rapprochement */
  customer: {
    phone: string | null;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
  };
  /** Items mappés */
  items: MappedOrderItem[];
  /** Date de création */
  createdAt: string | null;
}

/**
 * Transforme une commande HubRise complète en structure intermédiaire CN.
 */
export function mapHubriseOrderToCN(order: HubriseOrder): MappedOrder {
  // Calcul des frais de livraison depuis les charges
  const deliveryCharge = order.charges?.find(
    (c) => c.type === 'delivery' || c.name?.toLowerCase().includes('livraison'),
  );
  const deliveryFee = deliveryCharge ? parseHubriseMoney(deliveryCharge.price) : 0;

  // Calcul des remises
  const discount = (order.discounts ?? []).reduce(
    (sum, d) => sum + Math.abs(parseHubriseMoney(d.price_off)),
    0,
  );

  // Total
  const totalAmount = parseHubriseMoney(order.total);
  const netAmount = totalAmount - deliveryFee;

  // Nom complet du client
  const firstName = order.customer?.first_name ?? null;
  const lastName = order.customer?.last_name ?? null;
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;

  return {
    hubriseOrderId: order.id,
    status: mapHubriseStatusToCN(order.status),
    type: mapHubriseServiceTypeToCN(order.service_type),
    netAmount: Math.max(netAmount, 0),
    totalAmount,
    deliveryFee,
    discount,
    address: mapHubriseAddressToCN(order.customer?.address, order.customer_notes),
    note: order.customer_notes ?? null,
    customer: {
      phone: order.customer?.phone ?? null,
      email: order.customer?.email ?? null,
      firstName,
      lastName,
      fullName,
    },
    items: (order.items ?? []).map(mapHubriseItemToCN),
    createdAt: order.created_at ?? null,
  };
}
