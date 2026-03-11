/**
 * Mapper bidirectionnel : HubRise Catalog ↔ Chicken Nation (Category, Dish, Supplement).
 *
 * Correspondances :
 * - HubriseCategory.ref ↔ Category.reference
 * - HubriseProduct.ref / HubriseSku.ref ↔ Dish.reference
 * - HubriseOption ↔ Supplement (via nom ou ID)
 *
 * ⚠️ Contraintes :
 * - Category.reference et Dish.reference doivent être renseignés dans CN
 *   avec les mêmes valeurs que les `ref` HubRise pour que le matching fonctionne.
 * - Les Supplements n'ont pas de champ `reference` dans CN, on matche par `name`.
 */

import {
  HubriseCategory,
  HubriseProduct,
  HubriseSku,
  HubriseOption,
  HubriseOptionList,
  HubriseCatalog,
} from '../interfaces/hubrise-catalog.interface';
import { parseHubriseMoney, toHubriseMoney } from './order.mapper';

// ─── Category mapping ────────────────────────────────────────────────

/**
 * Structure intermédiaire pour une catégorie importée depuis HubRise.
 */
export interface MappedCategory {
  /** Référence HubRise (sera stockée dans Category.reference) */
  reference: string | null;
  /** Nom de la catégorie */
  name: string;
  /** Description */
  description: string | null;
}

/**
 * Transforme une catégorie HubRise en structure CN.
 */
export function mapHubriseCategoryToCN(cat: HubriseCategory): MappedCategory {
  return {
    reference: cat.ref ?? null,
    name: cat.name,
    description: cat.description ?? null,
  };
}

/**
 * Transforme une catégorie CN en catégorie HubRise (pour le push catalogue).
 */
export function mapCNCategoryToHubrise(category: {
  reference: string | null;
  name: string;
  description: string | null;
}): HubriseCategory {
  return {
    name: category.name,
    ref: category.reference,
    description: category.description ?? undefined,
  };
}

// ─── Dish / Product mapping ──────────────────────────────────────────

/**
 * Structure intermédiaire pour un plat importé depuis HubRise.
 */
export interface MappedDish {
  /** Référence HubRise (sera stockée dans Dish.reference) */
  reference: string | null;
  /** Nom du plat */
  name: string;
  /** Description */
  description: string | null;
  /** Prix en XOF (Float) */
  price: number;
  /** URL de l'image */
  image: string | null;
  /** Référence de la catégorie parente (Category.reference) */
  categoryReference: string | null;
  /** Références des listes d'options associées */
  optionListRefs: string[];
}

/**
 * Transforme un produit HubRise en structure CN.
 * Un produit HubRise peut avoir plusieurs SKUs (variantes).
 * On prend le premier SKU comme prix principal (le plus courant pour les restaurants).
 */
export function mapHubriseProductToCN(product: HubriseProduct): MappedDish {
  // Prendre le premier SKU comme base
  const primarySku: HubriseSku | undefined = product.skus?.[0];

  return {
    reference: primarySku?.ref || product.ref || null,
    name: product.name,
    description: product.description ?? null,
    price: parseHubriseMoney(primarySku?.price),
    image: product.image_url ?? null,
    categoryReference: product.category_ref ?? null,
    optionListRefs: primarySku?.option_list_refs ?? [],
  };
}

/**
 * Transforme un Dish CN en Product HubRise (pour le push catalogue).
 */
export function mapCNDishToHubrise(dish: {
  reference: string | null;
  name: string;
  description: string | null;
  price: number;
  image: string | null;
  category?: { reference: string | null };
}): HubriseProduct {
  return {
    name: dish.name,
    ref: dish.reference,
    description: dish.description ?? undefined,
    image_url: dish.image ?? undefined,
    category_ref: dish.category?.reference ?? undefined,
    skus: [
      {
        name: dish.name,
        ref: dish.reference,
        price: toHubriseMoney(dish.price),
      },
    ],
  };
}

// ─── Supplement / Option mapping ─────────────────────────────────────

/**
 * Structure intermédiaire pour un supplément importé depuis HubRise.
 */
export interface MappedSupplement {
  /** Nom du supplément */
  name: string;
  /** Référence HubRise de l'option */
  ref: string | null;
  /** Prix en XOF (Float) */
  price: number;
  /** Nom du groupe d'options parent (pour info) */
  groupName: string;
}

/**
 * Transforme une option HubRise en structure Supplement CN.
 */
export function mapHubriseOptionToCN(
  option: HubriseOption,
  optionList: HubriseOptionList,
): MappedSupplement {
  return {
    name: option.name,
    ref: option.ref ?? null,
    price: parseHubriseMoney(option.price),
    groupName: optionList.name,
  };
}

/**
 * Extrait tous les suppléments à partir des option_lists d'un catalogue HubRise.
 */
export function extractAllSupplements(
  optionLists: HubriseOptionList[] | undefined,
): MappedSupplement[] {
  if (!optionLists) return [];

  return optionLists.flatMap((list) =>
    (list.options ?? []).map((opt) => mapHubriseOptionToCN(opt, list)),
  );
}

// ─── Catalogue complet ───────────────────────────────────────────────

/**
 * Résultat du mapping complet d'un catalogue HubRise.
 */
export interface MappedCatalog {
  categories: MappedCategory[];
  dishes: MappedDish[];
  supplements: MappedSupplement[];
}

/**
 * Transforme un catalogue HubRise complet en structures CN.
 */
export function mapHubriseCatalogToCN(catalog: HubriseCatalog): MappedCatalog {
  return {
    categories: (catalog.categories ?? []).map(mapHubriseCategoryToCN),
    dishes: (catalog.products ?? []).map(mapHubriseProductToCN),
    supplements: extractAllSupplements(catalog.option_lists),
  };
}
