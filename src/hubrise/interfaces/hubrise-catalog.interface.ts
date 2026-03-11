/**
 * Interfaces TypeScript pour le catalogue HubRise.
 * Basé sur la documentation : https://developers.hubrise.com/api/catalogs
 *
 * Le catalogue HubRise contient :
 * - Catégories → correspondent aux Category de CN
 * - Produits → correspondent aux Dish de CN
 * - Options (option_lists) → correspondent aux Supplement + DishSupplement de CN
 *
 * La clé de rapprochement est le champ `ref` de HubRise
 * qui doit correspondre à `Dish.reference` et `Category.reference` dans CN.
 */

import { HubriseMoney } from './hubrise-order.interface';

// === SKU (variante d'un produit) ===
export interface HubriseSku {
  /** Nom du SKU (ex: "Taille L") */
  name?: string;
  /** Référence unique — correspond à Dish.reference dans CN */
  ref?: string | null;
  /** Prix (format "8.90 EUR") */
  price: HubriseMoney;
  /** Listes d'options disponibles pour ce SKU */
  option_list_refs?: string[];
}

// === Produit HubRise (correspond à un Dish dans CN) ===
export interface HubriseProduct {
  /** Nom du produit */
  name: string;
  /** Référence du produit — correspond à Dish.reference dans CN */
  ref?: string | null;
  /** Description */
  description?: string;
  /** URL de l'image */
  image_url?: string;
  /** Tags / étiquettes */
  tags?: string[];
  /** Variantes (SKUs) — la plupart des plats CN ont un seul SKU */
  skus: HubriseSku[];
  /** Catégorie parente (ref de la catégorie HubRise) */
  category_ref?: string;
}

// === Option dans une liste d'options (correspond à un Supplement dans CN) ===
export interface HubriseOption {
  /** Nom de l'option (ex: "Sauce piquante") */
  name: string;
  /** Référence — peut être utilisé pour matcher avec Supplement.id ou nom */
  ref?: string | null;
  /** Prix additionnel (format "0.50 EUR") */
  price?: HubriseMoney;
  /** Sélectionnée par défaut */
  default?: boolean;
}

// === Liste d'options (groupe de suppléments, ex: "Sauces", "Boissons") ===
export interface HubriseOptionList {
  /** Nom du groupe d'options */
  name: string;
  /** Référence unique du groupe */
  ref?: string | null;
  /** Nombre minimum de sélections */
  min?: number;
  /** Nombre maximum de sélections */
  max?: number;
  /** Options disponibles */
  options: HubriseOption[];
}

// === Catégorie HubRise (correspond à Category dans CN) ===
export interface HubriseCategory {
  /** Nom de la catégorie */
  name: string;
  /** Référence unique — correspond à Category.reference dans CN */
  ref?: string | null;
  /** Description */
  description?: string;
}

// === Promotion / Deal HubRise ===
export interface HubriseDeal {
  /** Nom du deal */
  name: string;
  /** Référence */
  ref?: string | null;
  /** Description */
  description?: string;
  /** Lignes du deal (produits inclus) */
  lines?: HubriseDealLine[];
}

export interface HubriseDealLine {
  /** Référence de la ligne */
  ref?: string;
  /** Libellé */
  label?: string;
  /** Références des SKUs éligibles */
  sku_refs?: string[];
  /** Pricing (s'il y a un surcoût) */
  pricing_effect?: 'unchanged' | 'fixed_price' | 'price_off' | 'percentage_off';
  /** Valeur du prix associé */
  pricing_value?: HubriseMoney;
}

// === Remise catalogue ===
export interface HubriseCatalogDiscount {
  /** Nom de la remise */
  name: string;
  /** Référence */
  ref?: string | null;
  /** Description */
  description?: string;
}

// === Catalogue complet HubRise ===
export interface HubriseCatalog {
  /** ID du catalogue */
  id?: string;
  /** Nom du catalogue */
  name?: string;
  /** Catégories */
  categories?: HubriseCategory[];
  /** Produits */
  products?: HubriseProduct[];
  /** Listes d'options */
  option_lists?: HubriseOptionList[];
  /** Deals / promotions */
  deals?: HubriseDeal[];
  /** Remises */
  discounts?: HubriseCatalogDiscount[];
}
