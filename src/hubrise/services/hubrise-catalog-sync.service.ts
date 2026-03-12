/**
 * Service de synchronisation du catalogue HubRise ↔ Chicken Nation.
 *
 * Deux directions de sync :
 *
 * 1. HubRise → CN (PULL) : Importer le catalogue HubRise dans CN
 *    - Catégories HubRise → Category (via reference)
 *    - Produits HubRise → Dish (via reference)
 *    - Options HubRise → Supplement (via nom, pas de champ reference)
 *
 * 2. CN → HubRise (PUSH) : Envoyer le catalogue CN vers HubRise
 *    - Category → Catégories HubRise
 *    - Dish → Produits HubRise
 *    - Supplement → Options HubRise
 *
 * ⚠️ Contraintes importantes :
 * - Dish.reference et Category.reference doivent être renseignés dans CN
 *   avec les mêmes valeurs que les `ref` HubRise
 * - Les Supplements sont matchés par nom (pas de champ reference dans le modèle CN)
 * - Le prix est converti de "X.XX XOF" (HubRise) vers Float (CN) et inversement
 * - Les images ne sont pas synchronisées automatiquement (URLs différentes)
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { EntityStatus } from '@prisma/client';
import { HubriseApiService } from './hubrise-api.service';
import { HUBRISE_CATALOGS } from '../constants/hubrise-endpoints.constant';
import { HubriseCatalog } from '../interfaces/hubrise-catalog.interface';
import {
  mapHubriseCatalogToCN,
  MappedCategory,
  MappedDish,
  MappedSupplement,
  mapCNCategoryToHubrise,
  mapCNDishToHubrise,
} from '../mappers/catalog.mapper';
import { toHubriseMoney } from '../mappers/order.mapper';

@Injectable()
export class HubriseCatalogSyncService {
  private readonly logger = new Logger(HubriseCatalogSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubriseApi: HubriseApiService,
  ) {}

  // ─── PULL : HubRise → Chicken Nation ───────────────────────────────

  /**
   * Importe le catalogue HubRise complet dans Chicken Nation.
   * Met à jour les catégories, plats et suppléments existants ou en crée de nouveaux.
   *
   * @param catalogId - ID du catalogue HubRise à importer
   * @param restaurantId - ID du restaurant CN cible
   * @param accessToken - Token d'accès HubRise
   * @returns Résumé de la synchronisation
   */
  async pullCatalog(
    catalogId: string,
    restaurantId: string,
    accessToken: string,
  ): Promise<CatalogSyncResult> {
    this.logger.log(`[HubRise Catalog] Pull du catalogue ${catalogId} pour le restaurant ${restaurantId}`);

    const result: CatalogSyncResult = {
      categories: { created: 0, updated: 0, skipped: 0 },
      dishes: { created: 0, updated: 0, skipped: 0 },
      supplements: { created: 0, updated: 0, skipped: 0 },
    };

    try {
      // 1. Récupérer le catalogue HubRise
      const hubriseCatalog = await this.hubriseApi.request<HubriseCatalog>({
        method: 'GET',
        url: HUBRISE_CATALOGS.GET(catalogId),
        accessToken,
      });

      // 2. Mapper les données
      const mapped = mapHubriseCatalogToCN(hubriseCatalog);

      // 3. Synchroniser les catégories
      const categoryRefToId = await this.syncCategories(mapped.categories, result);

      // 4. Synchroniser les plats
      await this.syncDishes(mapped.dishes, categoryRefToId, restaurantId, result);

      // 5. Synchroniser les suppléments
      await this.syncSupplements(mapped.supplements, result);

      this.logger.log(
        `[HubRise Catalog] Pull terminé — Catégories: +${result.categories.created}/~${result.categories.updated}, ` +
        `Plats: +${result.dishes.created}/~${result.dishes.updated}, ` +
        `Suppléments: +${result.supplements.created}/~${result.supplements.updated}`,
      );

      return result;
    } catch (error) {
      this.logger.error(`[HubRise Catalog] Erreur pull catalogue : ${error}`);
      throw error;
    }
  }

  /**
   * Synchronise les catégories HubRise dans CN.
   * @returns Map référence → category_id pour lier les plats
   */
  private async syncCategories(
    categories: MappedCategory[],
    result: CatalogSyncResult,
  ): Promise<Map<string, string>> {
    const refToId = new Map<string, string>();

    for (const cat of categories) {
      if (!cat.reference) {
        result.categories.skipped++;
        this.logger.warn(`[HubRise Catalog] Catégorie "${cat.name}" ignorée (pas de référence)`);
        continue;
      }

      // Chercher par référence
      const existing = await this.prisma.category.findUnique({
        where: { reference: cat.reference },
        select: { id: true },
      });

      if (existing) {
        // Mise à jour
        await this.prisma.category.update({
          where: { id: existing.id },
          data: { name: cat.name, description: cat.description },
        });
        refToId.set(cat.reference, existing.id);
        result.categories.updated++;
      } else {
        // Création
        const created = await this.prisma.category.create({
          data: {
            reference: cat.reference,
            name: cat.name,
            description: cat.description,
            entity_status: EntityStatus.ACTIVE,
          },
          select: { id: true },
        });
        refToId.set(cat.reference, created.id);
        result.categories.created++;
      }
    }

    return refToId;
  }

  /**
   * Synchronise les plats HubRise dans CN.
   * Associe chaque plat à son restaurant via DishRestaurant.
   */
  private async syncDishes(
    dishes: MappedDish[],
    categoryRefToId: Map<string, string>,
    restaurantId: string,
    result: CatalogSyncResult,
  ): Promise<void> {
    for (const dish of dishes) {
      if (!dish.reference) {
        result.dishes.skipped++;
        this.logger.warn(`[HubRise Catalog] Plat "${dish.name}" ignoré (pas de référence)`);
        continue;
      }

      // Résoudre la catégorie
      let categoryId: string | null = null;
      if (dish.categoryReference) {
        categoryId = categoryRefToId.get(dish.categoryReference) ?? null;
      }
      if (!categoryId) {
        // Chercher la catégorie par référence en base
        const cat = await this.prisma.category.findUnique({
          where: { reference: dish.categoryReference ?? '' },
          select: { id: true },
        });
        categoryId = cat?.id ?? null;
      }
      if (!categoryId) {
        result.dishes.skipped++;
        this.logger.warn(
          `[HubRise Catalog] Plat "${dish.name}" ignoré (catégorie ref "${dish.categoryReference}" introuvable)`,
        );
        continue;
      }

      // Chercher le plat par référence
      const existing = await this.prisma.dish.findUnique({
        where: { reference: dish.reference },
        select: { id: true },
      });

      if (existing) {
        // Mise à jour du plat
        await this.prisma.dish.update({
          where: { id: existing.id },
          data: {
            name: dish.name,
            description: dish.description,
            price: dish.price,
            category_id: categoryId,
          },
        });
        result.dishes.updated++;
      } else {
        // Création du plat + association au restaurant
        const created = await this.prisma.dish.create({
          data: {
            reference: dish.reference,
            name: dish.name,
            description: dish.description,
            price: dish.price,
            image: dish.image,
            category_id: categoryId,
            entity_status: EntityStatus.ACTIVE,
          },
          select: { id: true },
        });

        // Associer le plat au restaurant
        await this.prisma.dishRestaurant.create({
          data: {
            dish_id: created.id,
            restaurant_id: restaurantId,
          },
        });

        result.dishes.created++;
      }
    }
  }

  /**
   * Synchronise les suppléments HubRise dans CN.
   * Le matching se fait par nom (pas de champ reference sur Supplement).
   */
  private async syncSupplements(
    supplements: MappedSupplement[],
    result: CatalogSyncResult,
  ): Promise<void> {
    for (const sup of supplements) {
      // Chercher par nom exact
      const existing = await this.prisma.supplement.findFirst({
        where: { name: sup.name },
        select: { id: true },
      });

      if (existing) {
        // Mise à jour du prix
        await this.prisma.supplement.update({
          where: { id: existing.id },
          data: { price: sup.price },
        });
        result.supplements.updated++;
      } else {
        // Création
        // Déterminer la catégorie du supplément selon le nom du groupe
        const category = this.inferSupplementCategory(sup.groupName);

        await this.prisma.supplement.create({
          data: {
            name: sup.name,
            price: sup.price,
            category,
            available: true,
          },
        });
        result.supplements.created++;
      }
    }
  }

  // ─── PUSH : Chicken Nation → HubRise ───────────────────────────────

  /**
   * Envoie le catalogue Chicken Nation vers HubRise.
   * Met à jour le catalogue complet du restaurant sur HubRise.
   *
   * @param restaurantId - ID du restaurant CN
   * @param accessToken - Token d'accès HubRise
   * @param catalogId - ID du catalogue HubRise cible
   */
  async pushCatalog(
    restaurantId: string,
    accessToken: string,
    catalogId: string,
  ): Promise<void> {
    this.logger.log(`[HubRise Catalog] Push du catalogue vers ${catalogId}`);

    // 1. Récupérer les catégories et plats du restaurant
    const categories = await this.prisma.category.findMany({
      where: { entity_status: EntityStatus.ACTIVE },
      select: { reference: true, name: true, description: true },
    });

    const dishes = await this.prisma.dish.findMany({
      where: {
        entity_status: EntityStatus.ACTIVE,
        dish_restaurants: { some: { restaurant_id: restaurantId } },
      },
      include: { category: { select: { reference: true } } },
    });

    const supplements = await this.prisma.supplement.findMany({
      where: { available: true },
    });

    // 2. Construire le catalogue HubRise
    const hubriseCatalog: HubriseCatalog = {
      categories: categories
        .filter((c) => c.reference)
        .map((c) =>
          mapCNCategoryToHubrise({
            reference: c.reference,
            name: c.name,
            description: c.description,
          }),
        ),
      products: dishes.map((d) =>
        mapCNDishToHubrise({
          reference: d.reference,
          name: d.name,
          description: d.description,
          price: d.price,
          image: d.image,
          category: d.category,
        }),
      ),
      option_lists: this.buildOptionLists(supplements),
    };

    // 3. Push vers HubRise
    await this.hubriseApi.request({
      method: 'PUT',
      url: HUBRISE_CATALOGS.PUSH(catalogId),
      accessToken,
      body: hubriseCatalog as unknown as Record<string, unknown>,
    });

    this.logger.log(
      `[HubRise Catalog] Push terminé — ${categories.length} catégories, ${dishes.length} plats`,
    );
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────

  /**
   * Regroupe les suppléments CN en option_lists HubRise par catégorie.
   */
  private buildOptionLists(supplements: Array<{ name: string; price: number; category: string }>) {
    // Grouper par catégorie de supplément
    const groups = new Map<string, Array<{ name: string; price: number }>>();

    for (const sup of supplements) {
      const groupName = this.supplementCategoryLabel(sup.category);
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(sup);
    }

    return Array.from(groups.entries()).map(([name, options]) => ({
      name,
      ref: name.toLowerCase().replace(/\s+/g, '_'),
      options: options.map((opt) => ({
        name: opt.name,
        price: toHubriseMoney(opt.price),
      })),
    }));
  }

  /**
   * Déduit la catégorie de supplément CN à partir du nom du groupe HubRise.
   */
  private inferSupplementCategory(
    groupName: string,
  ): 'FOOD' | 'DRINK' | 'ACCESSORY' {
    const lower = groupName.toLowerCase();
    if (lower.includes('boisson') || lower.includes('drink') || lower.includes('jus')) {
      return 'DRINK';
    }
    if (lower.includes('accessoire') || lower.includes('couvert') || lower.includes('serviette')) {
      return 'ACCESSORY';
    }
    return 'FOOD';
  }

  /**
   * Convertit une catégorie de supplément CN en libellé lisible.
   */
  private supplementCategoryLabel(category: string): string {
    switch (category) {
      case 'FOOD': return 'Accompagnements';
      case 'DRINK': return 'Boissons';
      case 'ACCESSORY': return 'Accessoires';
      default: return 'Autres';
    }
  }

  // ─── AUTO-MATCHING : Correspondance automatique par nom ─────────────

  /**
   * Compare le catalogue HubRise avec les données CN existantes
   * et propose des correspondances automatiques par similarité de nom.
   *
   * Retourne un aperçu des matches trouvés pour validation avant application.
   *
   * @param catalogId - ID du catalogue HubRise
   * @param restaurantId - ID du restaurant CN
   * @param accessToken - Token d'accès HubRise
   */
  async previewAutoMatch(
    catalogId: string,
    restaurantId: string,
    accessToken: string,
  ): Promise<AutoMatchPreview> {
    this.logger.log(`[HubRise Matching] Preview auto-match pour restaurant ${restaurantId}`);

    // 1. Récupérer le catalogue HubRise
    const hubriseCatalog = await this.hubriseApi.request<HubriseCatalog>({
      method: 'GET',
      url: HUBRISE_CATALOGS.GET(catalogId),
      accessToken,
    });
    const mapped = mapHubriseCatalogToCN(hubriseCatalog);

    // 2. Récupérer les catégories CN (sans référence ou avec référence)
    const cnCategories = await this.prisma.category.findMany({
      where: { entity_status: EntityStatus.ACTIVE },
      select: { id: true, name: true, reference: true },
    });

    // 3. Récupérer les plats CN du restaurant (sans référence ou avec référence)
    const cnDishes = await this.prisma.dish.findMany({
      where: {
        entity_status: EntityStatus.ACTIVE,
        dish_restaurants: { some: { restaurant_id: restaurantId } },
      },
      select: { id: true, name: true, reference: true, price: true, category: { select: { name: true } } },
    });

    // 4. Matcher les catégories
    const categoryMatches: MatchProposal[] = [];
    for (const hrCat of mapped.categories) {
      if (!hrCat.reference) continue;

      // Vérifier si déjà lié
      const alreadyLinked = cnCategories.find((c) => c.reference === hrCat.reference);
      if (alreadyLinked) {
        categoryMatches.push({
          hubriseRef: hrCat.reference,
          hubriseName: hrCat.name,
          cnId: alreadyLinked.id,
          cnName: alreadyLinked.name,
          confidence: 100,
          status: 'already_linked',
        });
        continue;
      }

      // Chercher par similarité de nom
      const bestMatch = this.findBestMatch(
        hrCat.name,
        cnCategories.filter((c) => !c.reference), // Seulement celles sans référence
      );

      if (bestMatch) {
        categoryMatches.push({
          hubriseRef: hrCat.reference,
          hubriseName: hrCat.name,
          cnId: bestMatch.item.id,
          cnName: bestMatch.item.name,
          confidence: bestMatch.score,
          status: 'proposed',
        });
      } else {
        categoryMatches.push({
          hubriseRef: hrCat.reference,
          hubriseName: hrCat.name,
          cnId: null,
          cnName: null,
          confidence: 0,
          status: 'no_match',
        });
      }
    }

    // 5. Matcher les plats
    const dishMatches: DishMatchProposal[] = [];
    for (const hrDish of mapped.dishes) {
      if (!hrDish.reference) continue;

      // Vérifier si déjà lié
      const alreadyLinked = cnDishes.find((d) => d.reference === hrDish.reference);
      if (alreadyLinked) {
        dishMatches.push({
          hubriseRef: hrDish.reference,
          hubriseName: hrDish.name,
          hubrisePrice: hrDish.price,
          cnId: alreadyLinked.id,
          cnName: alreadyLinked.name,
          cnPrice: alreadyLinked.price,
          cnCategory: alreadyLinked.category?.name ?? null,
          confidence: 100,
          status: 'already_linked',
        });
        continue;
      }

      // Chercher par similarité de nom
      const bestMatch = this.findBestMatch(
        hrDish.name,
        cnDishes.filter((d) => !d.reference), // Seulement ceux sans référence
      );

      if (bestMatch) {
        dishMatches.push({
          hubriseRef: hrDish.reference,
          hubriseName: hrDish.name,
          hubrisePrice: hrDish.price,
          cnId: bestMatch.item.id,
          cnName: bestMatch.item.name,
          cnPrice: bestMatch.item.price,
          cnCategory: bestMatch.item.category?.name ?? null,
          confidence: bestMatch.score,
          status: 'proposed',
        });
      } else {
        dishMatches.push({
          hubriseRef: hrDish.reference,
          hubriseName: hrDish.name,
          hubrisePrice: hrDish.price,
          cnId: null,
          cnName: null,
          cnPrice: null,
          cnCategory: null,
          confidence: 0,
          status: 'no_match',
        });
      }
    }

    // 6. Résumé
    const summary = {
      categories: {
        total: categoryMatches.length,
        alreadyLinked: categoryMatches.filter((m) => m.status === 'already_linked').length,
        proposed: categoryMatches.filter((m) => m.status === 'proposed').length,
        noMatch: categoryMatches.filter((m) => m.status === 'no_match').length,
      },
      dishes: {
        total: dishMatches.length,
        alreadyLinked: dishMatches.filter((m) => m.status === 'already_linked').length,
        proposed: dishMatches.filter((m) => m.status === 'proposed').length,
        noMatch: dishMatches.filter((m) => m.status === 'no_match').length,
      },
    };

    return { summary, categoryMatches, dishMatches };
  }

  /**
   * Applique les correspondances validées.
   * Met à jour les champs `reference` des Category et Dish dans CN.
   *
   * @param matches - Liste des correspondances à appliquer
   */
  async applyAutoMatch(matches: MatchConfirmation[]): Promise<AutoMatchApplyResult> {
    this.logger.log(`[HubRise Matching] Application de ${matches.length} correspondances`);

    const result: AutoMatchApplyResult = {
      categoriesUpdated: 0,
      dishesUpdated: 0,
      errors: [],
    };

    for (const match of matches) {
      try {
        if (match.type === 'category') {
          await this.prisma.category.update({
            where: { id: match.cnId },
            data: { reference: match.hubriseRef },
          });
          result.categoriesUpdated++;
        } else if (match.type === 'dish') {
          await this.prisma.dish.update({
            where: { id: match.cnId },
            data: { reference: match.hubriseRef },
          });
          result.dishesUpdated++;
        }
      } catch (error) {
        const errMsg = `Erreur pour ${match.type} ${match.cnId} → ${match.hubriseRef}: ${error}`;
        this.logger.error(`[HubRise Matching] ${errMsg}`);
        result.errors.push(errMsg);
      }
    }

    this.logger.log(
      `[HubRise Matching] Terminé — ${result.categoriesUpdated} catégories, ${result.dishesUpdated} plats mis à jour`,
    );

    return result;
  }

  // ─── Algorithme de similarité ──────────────────────────────────────

  /**
   * Normalise un nom pour la comparaison :
   * minuscules, sans accents, sans espaces superflus, sans caractères spéciaux.
   */
  private normalizeName(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Supprimer les accents
      .replace(/[^a-z0-9\s]/g, '')     // Garder que lettres, chiffres, espaces
      .replace(/\s+/g, ' ')            // Normaliser les espaces
      .trim();
  }

  /**
   * Calcule un score de similarité entre deux chaînes (0 à 100).
   * Utilise une combinaison de :
   * - Correspondance exacte normalisée (100%)
   * - Inclusion (un nom contient l'autre) (80%)
   * - Mots en commun (proportionnel)
   */
  private similarityScore(a: string, b: string): number {
    const normA = this.normalizeName(a);
    const normB = this.normalizeName(b);

    // Correspondance exacte
    if (normA === normB) return 100;

    // Un nom contient l'autre
    if (normA.includes(normB) || normB.includes(normA)) return 80;

    // Mots en commun
    const wordsA = new Set(normA.split(' ').filter((w) => w.length > 2));
    const wordsB = new Set(normB.split(' ').filter((w) => w.length > 2));

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let commonWords = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) commonWords++;
    }

    const totalWords = Math.max(wordsA.size, wordsB.size);
    return Math.round((commonWords / totalWords) * 70); // Max 70% pour les mots en commun
  }

  /**
   * Trouve le meilleur match pour un nom HubRise parmi une liste d'éléments CN.
   * Retourne null si aucun match avec un score >= 50%.
   */
  private findBestMatch<T extends { id: string; name: string }>(
    hubriseName: string,
    cnItems: T[],
  ): { item: T; score: number } | null {
    let bestScore = 0;
    let bestItem: T | null = null;

    for (const item of cnItems) {
      const score = this.similarityScore(hubriseName, item.name);
      if (score > bestScore) {
        bestScore = score;
        bestItem = item;
      }
    }

    // Seuil minimum de 50% pour proposer un match
    if (bestScore >= 50 && bestItem) {
      return { item: bestItem, score: bestScore };
    }

    return null;
  }
}

// ─── Types de résultat ───────────────────────────────────────────────

interface SyncCounter {
  created: number;
  updated: number;
  skipped: number;
}

export interface CatalogSyncResult {
  categories: SyncCounter;
  dishes: SyncCounter;
  supplements: SyncCounter;
}

// ─── Types d'auto-matching ───────────────────────────────────────────

/** Proposition de correspondance pour une catégorie */
export interface MatchProposal {
  /** Référence HubRise (sera écrite dans Category.reference ou Dish.reference) */
  hubriseRef: string;
  /** Nom dans HubRise */
  hubriseName: string;
  /** ID de l'élément CN trouvé (null si pas de match) */
  cnId: string | null;
  /** Nom dans CN */
  cnName: string | null;
  /** Score de confiance 0-100 */
  confidence: number;
  /** Statut : déjà lié, proposé, ou aucun match */
  status: 'already_linked' | 'proposed' | 'no_match';
}

/** Proposition de correspondance pour un plat (avec prix) */
export interface DishMatchProposal extends MatchProposal {
  hubrisePrice: number;
  cnPrice: number | null;
  cnCategory: string | null;
}

/** Aperçu complet de l'auto-matching */
export interface AutoMatchPreview {
  summary: {
    categories: { total: number; alreadyLinked: number; proposed: number; noMatch: number };
    dishes: { total: number; alreadyLinked: number; proposed: number; noMatch: number };
  };
  categoryMatches: MatchProposal[];
  dishMatches: DishMatchProposal[];
}

/** Confirmation d'une correspondance à appliquer */
export interface MatchConfirmation {
  type: 'category' | 'dish';
  cnId: string;
  hubriseRef: string;
}

/** Résultat de l'application des correspondances */
export interface AutoMatchApplyResult {
  categoriesUpdated: number;
  dishesUpdated: number;
  errors: string[];
}
