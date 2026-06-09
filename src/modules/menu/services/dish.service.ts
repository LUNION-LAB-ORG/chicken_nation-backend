import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityStatus, OrderStatus, Prisma, SpiceLevel, User } from '@prisma/client';
import type { Request } from 'express';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateDishDto } from 'src/modules/menu/dto/create-dish.dto';
import { UpdateDishDto } from 'src/modules/menu/dto/update-dish.dto';
import { DishEvent } from 'src/modules/menu/events/dish.event';
import { QueryDishDto } from '../dto/query-dish.dto';
import { S3Service } from '../../../s3/s3.service';
import { GenerateDataService } from 'src/common/services/generate-data.service';

@Injectable()
export class DishService {
  constructor(
    private prisma: PrismaService,
    private dishEvent: DishEvent,
    private readonly s3service: S3Service,
    private readonly generateDataService: GenerateDataService
  ) { }

  private async uploadImage(image?: Express.Multer.File) {
    if (!image || !image.buffer) return null;
    return await this.s3service.uploadFile({
      buffer: image.buffer,
      path: 'chicken-nation/dishes',
      originalname: image.originalname,
      mimetype: image.mimetype,
    });
  }

  private normalizeIds(value?: string[] | string): string[] {
    if (!value) return [];
    return typeof value === 'string' ? [value] : value;
  }

  /**
   * Modèle "tout par défaut − exclusions".
   * Pour chaque plat, calcule l'effectif = (tous les suppléments / tous les restaurants
   * actifs) MOINS les exclusions du plat, et renvoie ces ensembles sous les MÊMES champs
   * `dish_supplements: [{ supplement }]` / `dish_restaurants: [{ restaurant }]` qu'avant
   * (compatibilité apps). Joint aussi les ids exclus (pour le backoffice).
   *
   * Public : utilisé par CategoryService.findOne pour populater les dishes d'une catégorie
   * avec leurs suppléments/restaurants effectifs.
   */
  async withEffective<T extends { id: string }>(dishes: T[]) {
    if (dishes.length === 0) return [] as (T & {
      dish_supplements: { supplement: unknown }[];
      dish_restaurants: { restaurant: unknown }[];
      excluded_supplement_ids: string[];
      excluded_restaurant_ids: string[];
    })[];

    const dishIds = dishes.map((d) => d.id);
    const [allSupplements, allRestaurants, exclSupp, exclResto] = await Promise.all([
      this.prisma.supplement.findMany({ where: { available: true } }),
      this.prisma.restaurant.findMany({ where: { entity_status: EntityStatus.ACTIVE } }),
      this.prisma.dishExcludedSupplement.findMany({ where: { dish_id: { in: dishIds } } }),
      this.prisma.dishExcludedRestaurant.findMany({ where: { dish_id: { in: dishIds } } }),
    ]);

    const suppExclByDish = new Map<string, Set<string>>();
    for (const e of exclSupp) {
      let set = suppExclByDish.get(e.dish_id);
      if (!set) { set = new Set(); suppExclByDish.set(e.dish_id, set); }
      set.add(e.supplement_id);
    }
    const restoExclByDish = new Map<string, Set<string>>();
    for (const e of exclResto) {
      let set = restoExclByDish.get(e.dish_id);
      if (!set) { set = new Set(); restoExclByDish.set(e.dish_id, set); }
      set.add(e.restaurant_id);
    }

    return dishes.map((d) => {
      const sExcl = suppExclByDish.get(d.id) ?? new Set<string>();
      const rExcl = restoExclByDish.get(d.id) ?? new Set<string>();
      return {
        ...d,
        dish_supplements: allSupplements
          .filter((s) => !sExcl.has(s.id))
          .map((supplement) => ({ supplement })),
        dish_restaurants: allRestaurants
          .filter((r) => !rExcl.has(r.id))
          .map((restaurant) => ({ restaurant })),
        excluded_supplement_ids: [...sExcl],
        excluded_restaurant_ids: [...rExcl],
      };
    });
  }

  async create(req: Request, createDishDto: CreateDishDto, image?: Express.Multer.File) {
    const user = req.user as User;
    // On retire les anciens champs (restaurant_ids/supplement_ids, désormais ignorés)
    // et les nouvelles listes d'exclusions du payload destiné à la table Dish.
    const {
      restaurant_ids,
      supplement_ids,
      excluded_restaurant_ids,
      excluded_supplement_ids,
      manage_exclusions,
      ...dishData
    } = createDishDto;
    void restaurant_ids;
    void supplement_ids;
    void manage_exclusions;

    // Garde l'ancien booléen cohérent avec le nouvel état 3 valeurs (compat app/web).
    if (dishData.spice_level !== undefined) {
      dishData.is_alway_epice = dishData.spice_level === SpiceLevel.ALWAYS;
    }

    const uploadResult = await this.uploadImage(image);

    const dish = await this.prisma.dish.create({
      data: {
        ...dishData,
        image: uploadResult?.key ?? dishData.image,
        entity_status: EntityStatus.ACTIVE,
        reference: this.generateDataService.generateReference(dishData.name),
      },
    });

    // Enregistrer les exclusions (ce que le plat NE propose PAS / où il N'est PAS vendu)
    const exclSupp = this.normalizeIds(excluded_supplement_ids);
    if (exclSupp.length) {
      await this.prisma.dishExcludedSupplement.createMany({
        data: exclSupp.map((supplement_id) => ({ dish_id: dish.id, supplement_id })),
        skipDuplicates: true,
      });
    }
    const exclResto = this.normalizeIds(excluded_restaurant_ids);
    if (exclResto.length) {
      await this.prisma.dishExcludedRestaurant.createMany({
        data: exclResto.map((restaurant_id) => ({ dish_id: dish.id, restaurant_id })),
        skipDuplicates: true,
      });
    }

    this.dishEvent.createDish({
      actor: { ...user, restaurant: null },
      dish,
    });

    return this.findOne(dish.id);
  }

  async findAll(query: { all: boolean } = { all: false }) {
    const dishes = await this.prisma.dish.findMany({
      where: {
        private: query.all ? undefined : false,
        entity_status: EntityStatus.ACTIVE,
      },
      include: { category: true },
      orderBy: { name: 'asc' },
    });
    return this.withEffective(dishes);
  }

  async findMany(filter: QueryDishDto): Promise<QueryResponseDto<unknown>> {
    const { search, status, categoryId, minPrice, maxPrice, page = 1, limit = 10, sortBy = "name", sortOrder = "asc" } = filter;

    const where: Prisma.DishWhereInput = {
      entity_status: EntityStatus.ACTIVE,
    };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status) {
      where.entity_status = status;
    }
    if (categoryId) {
      where.category_id = categoryId;
    }
    if (minPrice) {
      where.price = { gte: minPrice };
    }
    if (maxPrice) {
      where.price = { lte: maxPrice };
    }

    const [count, dishesRaw] = await Promise.all([
      this.prisma.dish.count({ where }),
      this.prisma.dish.findMany({
        where,
        include: { category: true },
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const dishes = await this.withEffective(dishesRaw);

    return {
      data: dishes,
      meta: {
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
      },
    };
  }

  async findOne(id: string, customerId?: string) {
    const whereCondition = id.length > 10 ? { id } : { reference: id };

    const dish = await this.prisma.dish.findFirst({
      where: whereCondition,
      include: {
        category: true,
        favorites: { select: { customer_id: true } },
      },
    });

    if (!dish || dish.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Plat non trouvée`);
    }

    const [withEff] = await this.withEffective([dish]);
    const isFavorite = customerId ? dish.favorites.some((favorite) => favorite.customer_id === customerId) : false;
    return { ...withEff, isFavorite };
  }

  /**
   * Plats vendus dans un restaurant = plats actifs non privés qui NE sont PAS exclus
   * de ce restaurant (avec leurs suppléments effectifs).
   */
  async findByRestaurant(restaurantId: string) {
    const excluded = await this.prisma.dishExcludedRestaurant.findMany({
      where: { restaurant_id: restaurantId },
      select: { dish_id: true },
    });
    const excludedDishIds = excluded.map((e) => e.dish_id);

    const dishes = await this.prisma.dish.findMany({
      where: {
        entity_status: EntityStatus.ACTIVE,
        private: false,
        ...(excludedDishIds.length ? { id: { notIn: excludedDishIds } } : {}),
      },
      include: { category: true },
      orderBy: { name: 'asc' },
    });

    return this.withEffective(dishes);
  }

  async update(req: Request, id: string, updateDishDto: UpdateDishDto, image?: Express.Multer.File) {
    const user = req.user as User;
    void user;
    const dish = await this.findOne(id);

    const uploadResult = await this.uploadImage(image);

    const {
      restaurant_ids,
      supplement_ids,
      excluded_restaurant_ids,
      excluded_supplement_ids,
      manage_exclusions,
      ...dishData
    } = updateDishDto;
    void restaurant_ids;
    void supplement_ids;

    // Garde l'ancien booléen cohérent avec le nouvel état 3 valeurs (compat app/web).
    if (dishData.spice_level !== undefined) {
      dishData.is_alway_epice = dishData.spice_level === SpiceLevel.ALWAYS;
    }

    const dishUpdated = await this.prisma.dish.update({
      where: { id: dish.id },
      data: {
        ...dishData,
        image: uploadResult?.key ?? dishData.image,
      },
    });

    // Remplacement complet des exclusions si géré explicitement (manage_exclusions)
    // ou si une liste est fournie. manage_exclusions permet aussi de TOUT effacer (liste vide).
    if (manage_exclusions || excluded_supplement_ids !== undefined) {
      const ids = this.normalizeIds(excluded_supplement_ids);
      await this.prisma.dishExcludedSupplement.deleteMany({ where: { dish_id: dish.id } });
      if (ids.length) {
        await this.prisma.dishExcludedSupplement.createMany({
          data: ids.map((supplement_id) => ({ dish_id: dish.id, supplement_id })),
          skipDuplicates: true,
        });
      }
    }
    if (manage_exclusions || excluded_restaurant_ids !== undefined) {
      const ids = this.normalizeIds(excluded_restaurant_ids);
      await this.prisma.dishExcludedRestaurant.deleteMany({ where: { dish_id: dish.id } });
      if (ids.length) {
        await this.prisma.dishExcludedRestaurant.createMany({
          data: ids.map((restaurant_id) => ({ dish_id: dish.id, restaurant_id })),
          skipDuplicates: true,
        });
      }
    }

    this.dishEvent.updateDish(dishUpdated);

    return this.findOne(dish.id);
  }

  async remove(id: string) {
    const dish = await this.findOne(id);

    // Soft-delete : le plat passe en entity_status=DELETED, ses FK OrderItem restent
    // valides (Dish reste en base). Inutile de bloquer si des commandes existent —
    // c'est précisément le cas d'usage du soft-delete : retirer un plat du catalogue
    // sans casser l'historique.

    // Nettoyage des exclusions du plat (devenu invisible, plus de sens d'exclure)
    await this.prisma.dishExcludedRestaurant.deleteMany({ where: { dish_id: id } });
    await this.prisma.dishExcludedSupplement.deleteMany({ where: { dish_id: id } });

    return this.prisma.dish.update({
      where: { id: dish.id },
      data: { entity_status: EntityStatus.DELETED },
    });
  }

  async findPopular(days: number = 30, limit: number = 4) {
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - days);

    const recentOrders = await this.prisma.order.findMany({
      where: {
        created_at: { gte: dateLimit },
        status: { in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED] }
      },
      select: { id: true },
    });

    const orderIds = recentOrders.map((order) => order.id);
    if (orderIds.length === 0) return [];

    const popularItems = await this.prisma.orderItem.groupBy({
      by: ['dish_id'],
      _sum: { quantity: true },
      where: { order_id: { in: orderIds } },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });

    if (popularItems.length === 0) return [];

    const dishIds = popularItems.map((item) => item.dish_id);
    const dishes = await this.prisma.dish.findMany({
      where: {
        id: { in: dishIds },
        entity_status: EntityStatus.ACTIVE,
      },
      include: { category: true },
    });

    return popularItems
      .map((item) => {
        const dish = dishes.find((d) => d.id === item.dish_id);
        if (!dish) return null;
        return { ...dish, total_sold: item._sum.quantity };
      })
      .filter(Boolean);
  }
}
