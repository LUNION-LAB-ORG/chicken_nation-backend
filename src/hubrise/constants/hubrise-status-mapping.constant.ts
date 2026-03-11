/**
 * Mapping bidirectionnel des statuts de commande entre HubRise et Chicken Nation.
 *
 * HubRise utilise des statuts en snake_case minuscules.
 * Chicken Nation utilise l'enum Prisma OrderStatus en SCREAMING_SNAKE_CASE.
 *
 * Statuts CN :
 * - PENDING = Brouillon (commande pas encore validée)
 * - ACCEPTED = Nouvelle commande (reçue et validée)
 * - IN_PROGRESS = Restaurant a accepté, en préparation
 * - READY = Préparation terminée
 * - PICKED_UP = Livreur a récupéré (livraison uniquement)
 * - COLLECTED = Client a reçu (tous types de commande)
 * - COMPLETED = Clôture de la commande
 * - CANCELLED = Commande annulée
 */

import { OrderStatus, OrderType } from '@prisma/client';

// === Statuts de commande HubRise ===
export type HubriseOrderStatus =
  | 'new'
  | 'received'
  | 'accepted'
  | 'in_preparation'
  | 'awaiting_shipment'
  | 'awaiting_collection'
  | 'in_delivery'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'delivery_failed';

// === HubRise → Chicken Nation ===
// new/received dans HubRise = commande nouvelle → ACCEPTED dans CN (pas PENDING qui est brouillon)
export const HUBRISE_TO_CN_STATUS: Record<HubriseOrderStatus, OrderStatus> = {
  new: OrderStatus.ACCEPTED,            // Nouvelle commande reçue → ACCEPTED (nouvelle dans CN)
  received: OrderStatus.ACCEPTED,       // Vue par le restaurant → ACCEPTED
  accepted: OrderStatus.IN_PROGRESS,    // Restaurant a accepté → IN_PROGRESS (en préparation)
  in_preparation: OrderStatus.IN_PROGRESS, // En préparation → IN_PROGRESS
  awaiting_shipment: OrderStatus.READY, // En attente d'expédition → READY
  awaiting_collection: OrderStatus.READY, // En attente de retrait → READY
  in_delivery: OrderStatus.PICKED_UP,   // En livraison → PICKED_UP
  completed: OrderStatus.COMPLETED,     // Terminée → COMPLETED
  rejected: OrderStatus.CANCELLED,      // Rejetée → CANCELLED
  cancelled: OrderStatus.CANCELLED,     // Annulée → CANCELLED
  delivery_failed: OrderStatus.CANCELLED, // Échec livraison → CANCELLED
};

// === Chicken Nation → HubRise ===
// PENDING (brouillon) ne devrait pas être envoyé à HubRise, on met 'new' par défaut
export const CN_TO_HUBRISE_STATUS: Record<OrderStatus, HubriseOrderStatus> = {
  [OrderStatus.PENDING]: 'new',           // Brouillon → new (pas encore traitée)
  [OrderStatus.ACCEPTED]: 'received',     // Nouvelle commande → received (prête à traiter)
  [OrderStatus.IN_PROGRESS]: 'in_preparation', // En préparation → in_preparation
  [OrderStatus.READY]: 'awaiting_collection',  // Préparation terminée → awaiting_collection
  [OrderStatus.PICKED_UP]: 'in_delivery',      // Livreur a récupéré → in_delivery
  [OrderStatus.COLLECTED]: 'completed',         // Client a reçu → completed
  [OrderStatus.COMPLETED]: 'completed',         // Clôturée → completed
  [OrderStatus.CANCELLED]: 'cancelled',         // Annulée → cancelled
};

// === Types de service HubRise ===
export type HubriseServiceType = 'delivery' | 'collection' | 'eat_in';

// === HubRise service_type → Chicken Nation OrderType ===
export const HUBRISE_TO_CN_ORDER_TYPE: Record<HubriseServiceType, OrderType> = {
  delivery: OrderType.DELIVERY,
  collection: OrderType.PICKUP,
  eat_in: OrderType.TABLE,
};

// === Chicken Nation OrderType → HubRise service_type ===
export const CN_TO_HUBRISE_ORDER_TYPE: Record<OrderType, HubriseServiceType> = {
  [OrderType.DELIVERY]: 'delivery',
  [OrderType.PICKUP]: 'collection',
  [OrderType.TABLE]: 'eat_in',
};

// === Modes de paiement HubRise → description ===
export const HUBRISE_PAYMENT_TYPES: Record<string, string> = {
  cash: 'Espèces',
  online: 'En ligne',
  card: 'Carte bancaire',
  mobile_money: 'Mobile Money',
};

// === Événements de callback HubRise ===
export const HUBRISE_CALLBACK_EVENTS = {
  ORDER_CREATE: 'order.create',
  ORDER_UPDATE: 'order.update',
  CUSTOMER_CREATE: 'customer.create',
  CUSTOMER_UPDATE: 'customer.update',
  CATALOG_UPDATE: 'catalog.update',
} as const;

export type HubriseCallbackEvent =
  (typeof HUBRISE_CALLBACK_EVENTS)[keyof typeof HUBRISE_CALLBACK_EVENTS];
