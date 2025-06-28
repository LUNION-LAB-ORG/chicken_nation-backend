import { Injectable } from '@nestjs/common';
import { CreatePromotionDto } from '../dto/create-promotion.dto';
import { UpdatePromotionDto } from '../dto/update-promotion.dto';
import { PromotionResponseDto } from '../dto/promotion-response.dto';
import { Customer, Dish, Prisma, User, Visibility } from '@prisma/client';
import { DiscountType, TargetType, PromotionStatus, LoyaltyLevel } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { QueryPromotionDto } from '../dto/query-promotion.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { PromotionEvent } from '../events/promotion.event';
import { Request } from 'express';

import { PromotionErrorKeys } from '../enums/promotion-error-keys.enum';
import { PromotionException } from '../filters/promotion.filter';

@Injectable()
export class PromotionService {
  constructor(private prisma: PrismaService, private promotionEvent: PromotionEvent) { }

  async create(req: Request, createPromotionDto: CreatePromotionDto, created_by_id: string): Promise<PromotionResponseDto> {
    const {
      targeted_dish_ids = [],
      targeted_category_ids = [],
      offered_dishes = [],
      restaurant_ids = [],
      ...promotionData
    } = createPromotionDto;

    let all_restaurant_ids: string[] = restaurant_ids;

    const user = req.user as User;

    // Validation des dates
    const startDate = new Date(promotionData.start_date);
    const endDate = new Date(promotionData.expiration_date);

    if (startDate >= endDate) {
      throw new PromotionException({
        key: PromotionErrorKeys.PROMOTION_INVALID_DATE_RANGE,
        message: 'La date de fin doit être postérieure à la date de début',
        data: { startDate: promotionData.start_date, endDate: promotionData.expiration_date }
      });
    }

    // Validation des restaurants
    if (all_restaurant_ids.length === 0) {
      const restaurants = await this.prisma.restaurant.findMany({
        select: { id: true }
      })
      if (restaurants.length === 0) {
        throw new PromotionException({
          key: PromotionErrorKeys.PROMOTION_MISSING_RESTAURANTS,
          message: 'Vous devez sélectionner au moins un restaurant pour cette promotion'
        });
      }

      all_restaurant_ids = restaurants.map(r => r.id);
    }


    // Validation du ciblage
    if (promotionData.target_type === TargetType.SPECIFIC_PRODUCTS && targeted_dish_ids.length === 0) {
      throw new PromotionException({
        key: PromotionErrorKeys.PROMOTION_MISSING_TARGETED_DISHES,
        message: 'Vous devez sélectionner au moins un plat pour ce type de promotion'
      });
    }

    if (promotionData.target_type === TargetType.CATEGORIES && targeted_category_ids.length === 0) {
      throw new PromotionException({
        key: PromotionErrorKeys.PROMOTION_MISSING_TARGETED_CATEGORIES,
        message: 'Vous devez sélectionner au moins une catégorie pour ce type de promotion'
      });
    }
    // Validation de la visibilité
    if (promotionData.visibility === Visibility.PRIVATE && !promotionData.target_standard && !promotionData.target_premium && !promotionData.target_gold) {
      throw new PromotionException({
        key: PromotionErrorKeys.PROMOTION_MISSING_LOYALTY_LEVELS,
        message: 'Vous devez sélectionner au moins un niveau de fidélité pour ce type de promotion, exemple : standard, premium, gold'
      });
    }

    // Validation du type de remise
    if (promotionData.discount_type === DiscountType.BUY_X_GET_Y && offered_dishes.length === 0) {
      throw new PromotionException({
        key: PromotionErrorKeys.PROMOTION_MISSING_OFFERED_DISHES,
        message: 'Vous devez sélectionner au moins un plat pour ce type de promotion'
      });
    }

    if (promotionData.discount_type == DiscountType.PERCENTAGE && promotionData.discount_value > 70) {
      throw new PromotionException({
        key: PromotionErrorKeys.PROMOTION_DISCOUNT_PERCENTAGE_TOO_HIGH,
        message: 'La remise ne peut pas être supérieure à 70%',
        data: { max_percentage: 70, provided_percentage: promotionData.discount_value }
      });
    }

    if (promotionData.discount_type == DiscountType.FIXED_AMOUNT && !promotionData.min_order_amount) {
      throw new PromotionException({
        key: PromotionErrorKeys.PROMOTION_MISSING_MIN_ORDER_AMOUNT,
        message: 'Le montant minimum de commande doit être renseigné'
      });
    }

    const promotion = await this.prisma.$transaction(async (tx) => {
      // Créer la promotion
      const promotion = await tx.promotion.create({
        data: {
          ...promotionData,
          start_date: startDate.toISOString(),
          expiration_date: endDate.toISOString(),
          created_by_id,
          // Add restaurant associations here
          restaurantPromotions: {
            createMany: {
              data: all_restaurant_ids.map(restaurant_id => ({
                restaurant_id,
              })),
            },
          },
        },
      });
      // Ajouter les plats ciblés
      if (targeted_dish_ids.length > 0) {
        await tx.promotionTargetedDish.createMany({
          data: targeted_dish_ids.map(dish_id => ({
            promotion_id: promotion.id,
            dish_id,
          })),
        });
      }

      // Ajouter les catégories ciblées
      if (targeted_category_ids.length > 0) {
        await tx.promotionTargetedCategory.createMany({
          data: targeted_category_ids.map(category_id => ({
            promotion_id: promotion.id,
            category_id,
          })),
        });
      }

      // Ajouter les plats offerts (pour BUY_X_GET_Y)
      if (promotionData.discount_type === DiscountType.BUY_X_GET_Y && offered_dishes.length > 0) {
        await tx.promotionDish.createMany({
          data: offered_dishes.map(({ dish_id, quantity }) => ({
            promotion_id: promotion.id,
            dish_id,
            quantity,
          })),
        });
      }

      return promotion;
    });

    // Récupérer les noms des plats/catégories ciblés
    const targeted: string[] = [];

    if (targeted_dish_ids.length > 0) {
      const targetedDishes = await this.prisma.promotionTargetedDish.findMany({
        where: { promotion_id: promotion.id },
        include: { dish: true },
      });
      targeted.push(...targetedDishes.map(td => td.dish.name));
    }

    if (targeted_category_ids.length > 0) {
      const targetedCategories = await this.prisma.promotionTargetedCategory.findMany({
        where: { promotion_id: promotion.id },
        include: { category: true },
      });
      targeted.push(...targetedCategories.map(tc => tc.category.name));
    }

    // Evenement de promotion créée
    if (promotion.status === PromotionStatus.ACTIVE) {
      this.promotionEvent.promotionCreatedEvent({ actor: { ...user, restaurant: null }, promotion, targetedNames: targeted });
    }
    return this.mapToResponseDto(promotion);
  }

  async findAll(filters?: QueryPromotionDto): Promise<QueryResponseDto<PromotionResponseDto>> {
    const where: Prisma.PromotionWhereInput = {};

    if (filters?.title) where.title = { contains: filters.title, mode: 'insensitive' };

    if (filters?.status) where.status = filters.status;

    if (filters?.visibility) where.visibility = filters.visibility;

    if (filters?.discount_type) where.discount_type = filters.discount_type;

    if (filters?.target_type) where.target_type = filters.target_type;

    if (filters?.min_order_amount !== undefined) where.min_order_amount = { gte: filters.min_order_amount };

    if (filters?.max_discount_amount !== undefined) where.max_discount_amount = { lte: filters.max_discount_amount };

    if (filters?.start_date_from || filters?.start_date_to) {
      where.start_date = {};
      if (filters.start_date_from) where.start_date.gte = filters.start_date_from;
      if (filters.start_date_to) where.start_date.lte = filters.start_date_to;
    }

    if (filters?.expiration_date_from || filters?.expiration_date_to) {
      where.expiration_date = {};
      if (filters.expiration_date_from) where.expiration_date.gte = filters.expiration_date_from;
      if (filters.expiration_date_to) where.expiration_date.lte = filters.expiration_date_to;
    }

    if (filters?.visibility === 'PRIVATE') {
      if (filters?.target_standard) where.target_standard = true;
      if (filters?.target_premium) where.target_premium = true;
      if (filters?.target_gold) where.target_gold = true;
    }

    if (filters?.targeted_category_ids?.length) where.promotion_targeted_categories = { some: { category_id: { in: filters.targeted_category_ids } } };

    if (filters?.targeted_dish_ids?.length) {
      // Use OR to check both promotion_targeted_dishes and promotion_dishes
      where.OR = [
        { promotion_targeted_dishes: { some: { dish_id: { in: filters.targeted_dish_ids } } } },
        { promotion_dishes: { some: { dish_id: { in: filters.targeted_dish_ids } } } }
      ];
    }

    // New filter for restaurant_ids
    if (filters?.restaurant_ids?.length) {
      where.restaurantPromotions = {
        some: {
          restaurant_id: { in: filters.restaurant_ids },
        },
      };
    }

    const take = filters?.limit ?? 20;
    const skip = filters?.page ? (filters.page - 1) * take : 0;

    const [promotions, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        include: {
          promotion_targeted_dishes: {
            include: { dish: true },
          },
          promotion_targeted_categories: {
            include: { category: true },
          },
          promotion_dishes: {
            include: { dish: true },
          },
          created_by: {
            select: { id: true, fullname: true, email: true },
          },
          restaurantPromotions: { // <--- Include restaurantPromotions here
            include: {
              restaurant: {
                select: { id: true, name: true }
              }
            }
          },
        },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.promotion.count({ where }),
    ]);

    return {
      data: promotions.map(this.mapToResponseDto),
      meta: {
        total,
        page: filters?.page ?? 1,
        limit: take,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async findAllForCustomer(req: Request, filters?: QueryPromotionDto): Promise<QueryResponseDto<PromotionResponseDto>> {
    const customer = req.user as Customer;

    const where: Prisma.PromotionWhereInput = {
      status: PromotionStatus.ACTIVE,
      expiration_date: { gte: new Date() },
    };

    if (filters?.title) where.title = { contains: filters.title, mode: 'insensitive' };
    if (filters?.status) where.status = filters.status;
    if (filters?.visibility) where.visibility = filters.visibility;
    if (filters?.discount_type) where.discount_type = filters.discount_type;
    if (filters?.target_type) where.target_type = filters.target_type;
    if (filters?.min_order_amount !== undefined) where.min_order_amount = { gte: filters.min_order_amount };
    if (filters?.max_discount_amount !== undefined) where.max_discount_amount = { lte: filters.max_discount_amount };

    if (filters?.start_date_from || filters?.start_date_to) {
      where.start_date = {};
      if (filters.start_date_from) where.start_date.gte = filters.start_date_from;
      if (filters.start_date_to) where.start_date.lte = filters.start_date_to;
    }

    if (filters?.expiration_date_from || filters?.expiration_date_to) {
      where.expiration_date = {};
      if (filters.expiration_date_from) where.expiration_date.gte = filters.expiration_date_from;
      if (filters.expiration_date_to) where.expiration_date.lte = filters.expiration_date_to;
    }

    // Customer-specific loyalty level filtering will happen in the .filter() below
    // No need to add it directly to where clause here if visibility is 'PRIVATE'
    // as we handle it after fetching.

    if (filters?.targeted_category_ids?.length) where.promotion_targeted_categories = { some: { category_id: { in: filters.targeted_category_ids } } };

    if (filters?.targeted_dish_ids?.length) {
      where.OR = [
        { promotion_targeted_dishes: { some: { dish_id: { in: filters.targeted_dish_ids } } } },
        { promotion_dishes: { some: { dish_id: { in: filters.targeted_dish_ids } } } }
      ];
    }

    // Add restaurant filtering for customer view
    // This assumes that filters.restaurant_ids will be passed when calling this for a customer
    // who is viewing promotions for a specific restaurant.
    if (filters?.restaurant_ids?.length) {
      where.restaurantPromotions = {
        some: {
          restaurant_id: { in: filters.restaurant_ids },
        },
      };
    }

    const take = filters?.limit ?? 20;
    const skip = filters?.page ? (filters.page - 1) * take : 0;

    const [promotions, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        include: {
          promotion_targeted_dishes: {
            include: { dish: true },
          },
          promotion_targeted_categories: {
            include: { category: true },
          },
          promotion_dishes: {
            include: { dish: true },
          },
          created_by: {
            select: { id: true, fullname: true, email: true },
          },
          restaurantPromotions: { // <--- Include for customer view as well
            include: {
              restaurant: {
                select: { id: true, name: true }
              }
            }
          },
        },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.promotion.count({ where }),
    ]);

    // The filtering logic for loyalty level is already good here.
    // Ensure that if a promotion targets specific restaurants, it's displayed only if the customer
    // is currently associated with one of those restaurants (via the filters?.restaurant_ids)
    // or if the promotion is truly global.
    return {
      data: promotions.filter((promotion) => {
        if (promotion.visibility == Visibility.PUBLIC) return true;

        if (promotion.visibility === Visibility.PRIVATE) {
          const isTargetedByLoyalty = (
            (customer.loyalty_level === LoyaltyLevel.STANDARD && promotion.target_standard) ||
            (customer.loyalty_level === LoyaltyLevel.PREMIUM && promotion.target_premium) ||
            (customer.loyalty_level === LoyaltyLevel.GOLD && promotion.target_gold)
          );
          if (!isTargetedByLoyalty) return false;
        }

        return true;
      }).map((promotion) => this.mapToResponseDto(promotion)),
      meta: {
        total,
        page: filters?.page ?? 1,
        limit: take,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async findActivePromotions(filters?: QueryPromotionDto): Promise<PromotionResponseDto[]> {
    const promotions = await this.findAll({
      ...filters,
      status: PromotionStatus.ACTIVE,

    });
    return promotions.data;
  }

  async findOne(id: string): Promise<PromotionResponseDto> {
    const promotion = await this.prisma.promotion.findUnique({
      where: { id },
      include: {
        promotion_targeted_dishes: {
          include: { dish: true }
        },
        promotion_targeted_categories: {
          include: { category: true }
        },
        promotion_dishes: {
          include: { dish: true }
        },
        created_by: {
          select: { id: true, fullname: true, email: true }
        },
        restaurantPromotions: { // <--- Include here
          include: {
            restaurant: {
              select: { id: true, name: true } // Select relevant restaurant fields
            }
          }
        },
      }
    });
    if (!promotion) {
      throw new PromotionException({
        key: PromotionErrorKeys.PROMOTION_NOT_FOUND,
        message: 'Promotion non trouvée',
        data: { id }
      });
    }

    return this.mapToResponseDto(promotion);
  }

  async update(req: Request, id: string, updatePromotionDto: UpdatePromotionDto): Promise<PromotionResponseDto> {
    const {
      targeted_dish_ids,
      targeted_category_ids,
      offered_dishes,
      restaurant_ids, // <--- Extract restaurant_ids here
      ...promotionData
    } = updatePromotionDto;

    const user = req.user as User;

    const promotion = await this.prisma.$transaction(async (tx) => {
      const promotion = await tx.promotion.update({
        where: { id },
        data: {
          ...promotionData,
          start_date: updatePromotionDto.start_date ? new Date(updatePromotionDto.start_date).toISOString() : undefined,
          expiration_date: updatePromotionDto.expiration_date ? new Date(updatePromotionDto.expiration_date).toISOString() : undefined,
        },
      });

      if (restaurant_ids !== undefined) {
        await tx.restaurantPromotion.deleteMany({
          where: { promotion_id: id }
        });

        if (restaurant_ids.length > 0) {
          await tx.restaurantPromotion.createMany({
            data: restaurant_ids.map(restaurant_id => ({
              promotion_id: id,
              restaurant_id,
            })),
          });
        }
      }

      if (promotionData.target_type === TargetType.SPECIFIC_PRODUCTS && targeted_dish_ids !== undefined) {
        await tx.promotionTargetedDish.deleteMany({
          where: { promotion_id: id }
        });

        if (targeted_dish_ids.length > 0) {
          await tx.promotionTargetedDish.createMany({
            data: targeted_dish_ids.map(dish_id => ({
              promotion_id: id,
              dish_id,
            })),
          });
        }
      }

      if (promotionData.target_type === TargetType.CATEGORIES && targeted_category_ids !== undefined) {
        await tx.promotionTargetedCategory.deleteMany({
          where: { promotion_id: id }
        });

        if (targeted_category_ids.length > 0) {
          await tx.promotionTargetedCategory.createMany({
            data: targeted_category_ids.map(category_id => ({
              promotion_id: id,
              category_id,
            })),
          });
        }
      }

      if (promotionData.discount_type === DiscountType.BUY_X_GET_Y && offered_dishes !== undefined) {
        await tx.promotionDish.deleteMany({
          where: { promotion_id: id }
        });

        if (offered_dishes.length > 0) {
          await tx.promotionDish.createMany({
            data: offered_dishes.map(({ dish_id, quantity }) => ({
              promotion_id: id,
              dish_id,
              quantity,
            })),
          });
        }
      }
      return promotion;
    });

    // Envoyer l'événement de promotion mise à jour
    this.promotionEvent.promotionUpdatedEvent({ actor: { ...user, restaurant: null }, promotion });

    return this.mapToResponseDto(promotion);
  }

  async remove(req: Request, id: string): Promise<PromotionResponseDto> {
    const user = req.user as User;
    const promotion = await this.prisma.promotion.update({
      where: { id },
      data: { status: PromotionStatus.EXPIRED }
    });
    if (!promotion) {
      throw new PromotionException({
        key: PromotionErrorKeys.PROMOTION_NOT_FOUND,
        message: 'Promotion non trouvée',
        data: { id }
      });
    }

    // Envoyer l'événement de promotion supprimée
    this.promotionEvent.promotionDeletedEvent({ actor: { ...user, restaurant: null }, promotion });

    return this.mapToResponseDto(promotion);
  }

  // Utiliser une promotion
  async usePromotion(
    promotion_id: string | undefined,
    customer_id: string,
    order_id: string | undefined,
    order_amount: number,
    items: { dish_id: string; quantity: number; price: number }[],
    loyalty_level?: LoyaltyLevel
  ) {
    if (!promotion_id) return {
      usage: null,
      discount_amount: 0,
      final_amount: order_amount
    }
    const data = await this.prisma.$transaction(async (tx) => {
      // Vérifier si le client peut utiliser cette promotion
      const canUse = await this.canCustomerUsePromotion(promotion_id, customer_id);
      if (!canUse.allowed) {
        throw new PromotionException({
          key: canUse.error_key!, // L'opérateur ! est utilisé car on sait que error_key sera présent si allowed est false
          message: canUse.reason!,
          data: canUse.data
        });
      }

      // Calculer la réduction
      const discount = await this.calculateDiscount(
        promotion_id,
        order_amount,
        customer_id,
        items,
        loyalty_level
      );

      if (!discount.applicable) {
        throw new PromotionException({
          key: discount.error_key!,
          message: discount.reason!,
          data: discount.data
        });
      }

      // Enregistrer l'utilisation
      const usage = await tx.promotionUsage.create({
        data: {
          promotion_id,
          customer_id,
          order_id,
          discount_amount: discount.discount_amount + discount.buyXGetY_amount,
          original_amount: order_amount,
          final_amount: discount.final_amount,
        },
        include: {
          customer: true,
          promotion: true,
        }
      });

      // Incrémenter le compteur d'utilisation de la promotion
      await tx.promotion.update({
        where: { id: promotion_id },
        data: { current_usage: { increment: 1 } }
      });


      return {
        usage,
        discount_amount: discount.discount_amount,
        final_amount: discount.final_amount
      };
    });

    const { usage, discount_amount, final_amount } = data;

    // Evenement de promotion utilisée
    if (usage?.customer && usage?.promotion) {
      this.promotionEvent.promotionUsedEvent({
        customer: usage?.customer,
        promotion: usage?.promotion,
        discountAmount: discount_amount,
      });
    }

    return {
      usage,
      discount_amount,
      final_amount
    }
  }

  // Méthode pour vérifier si un plat est en promotion
  async isDishInPromotion(dish_id: string, promotion_id?: string, customer_loyalty_level?: LoyaltyLevel): Promise<{
    inPromotion: boolean;
    promotions: PromotionResponseDto[];
  }> {
    const now = new Date();
    const promotions = await this.prisma.promotion.findMany({
      where: {
        status: PromotionStatus.ACTIVE,
        start_date: { lte: now },
        expiration_date: { gte: now },
        id: promotion_id,
        OR: [
          // Promotion sur tous les produits
          { target_type: TargetType.ALL_PRODUCTS },
          // Promotion sur ce plat spécifiquement
          {
            target_type: TargetType.SPECIFIC_PRODUCTS,
            promotion_targeted_dishes: {
              some: { dish_id }
            }
          },
          // Promotion sur la catégorie de ce plat
          {
            target_type: TargetType.CATEGORIES,
            promotion_targeted_categories: {
              some: {
                category: {
                  dishes: {
                    some: { id: dish_id }
                  }
                }
              }
            }
          }
        ]
      },
      include: {
        promotion_targeted_dishes: true,
        promotion_targeted_categories: {
          include: { category: { include: { dishes: true } } }
        }
      }
    });

    // Filtrer par niveau de fidélité pour les promotions privées
    const validPromotions = promotions.filter(promo => {
      if (promo.visibility === 'PUBLIC') return true;

      if (!customer_loyalty_level) return false;

      switch (customer_loyalty_level) {
        case LoyaltyLevel.STANDARD:
          return promo.target_standard;
        case LoyaltyLevel.PREMIUM:
          return promo.target_premium;
        case LoyaltyLevel.GOLD:
          return promo.target_gold;
        default:
          return false;
      }
    });
    return {
      inPromotion: validPromotions.length > 0,
      promotions: validPromotions.map(this.mapToResponseDto)
    };
  }

  // Calculer la réduction applicable
  async calculateDiscount(
    promotion_id: string | undefined,
    order_amount: number,
    customer_id: string,
    items: { dish_id: string; quantity: number; price: number }[],
    loyalty_level?: LoyaltyLevel
  ): Promise<{
    discount_amount: number;
    buyXGetY_amount: number;
    final_amount: number;
    applicable: boolean;
    reason?: string;
    error_key?: PromotionErrorKeys;
    data?: any;
  }> {

    if (!promotion_id) {
      return {
        discount_amount: 0,
        buyXGetY_amount: 0,
        final_amount: order_amount,
        applicable: false,
        reason: 'Promotion non trouvée',
        error_key: PromotionErrorKeys.PROMOTION_NOT_FOUND
      };
    }
    const canUsePromotion = await this.canCustomerUsePromotion(promotion_id, customer_id);

    if (!canUsePromotion.allowed) {
      return {
        discount_amount: 0,
        buyXGetY_amount: 0,
        final_amount: order_amount,
        applicable: false,
        reason: canUsePromotion.reason,
        error_key: canUsePromotion.error_key,
        data: canUsePromotion.data
      };
    }


    if (items.length === 0) {
      return {
        discount_amount: 0,
        buyXGetY_amount: 0,
        final_amount: order_amount,
        applicable: false,
        reason: 'Aucun plat dans la commande',
        error_key: PromotionErrorKeys.PROMOTION_NO_ITEMS_IN_ORDER
      };
    }

    // Récupère la promotion en utilisant findOne, qui lance déjà une PromotionException si non trouvée
    const promotion = await this.findOne(promotion_id);


    // vérifier si certains plats sont en promotion
    let dishesInPromotion: { dish_id: string; quantity: number; price: number }[] = [];

    await Promise.all(items.map(async item => {
      const result = await this.isDishInPromotion(item.dish_id, promotion_id, loyalty_level);
      if (result.inPromotion) {
        dishesInPromotion.push(item);
      }
    }));

    let someDishesInPromotion: boolean = dishesInPromotion.length > 0;

    const qteSomeDishesInPromotion = dishesInPromotion.reduce((total, item) => total + item.quantity, 0);


    if (!someDishesInPromotion || (promotion.discount_type === DiscountType.BUY_X_GET_Y && qteSomeDishesInPromotion < promotion.discount_value)) {
      return {
        discount_amount: 0,
        buyXGetY_amount: 0,
        final_amount: order_amount,
        applicable: false,
        reason: 'Vous ne pouvez pas bénéficier de cette promotion',
        error_key: promotion.discount_type === DiscountType.BUY_X_GET_Y ?
          PromotionErrorKeys.PROMOTION_INSUFFICIENT_ITEMS_FOR_BUY_X_GET_Y :
          PromotionErrorKeys.PROMOTION_NOT_APPLICABLE,
        data: promotion.discount_type === DiscountType.BUY_X_GET_Y ? {
          required_quantity: promotion.discount_value,
          current_quantity: qteSomeDishesInPromotion
        } : undefined
      };
    }

    // Vérifier si la promotion est active
    const now = new Date();
    if (promotion.status !== PromotionStatus.ACTIVE ||
      new Date(promotion.start_date) > now ||
      new Date(promotion.expiration_date) < now) {
      return {
        discount_amount: 0,
        buyXGetY_amount: 0,
        final_amount: order_amount,
        applicable: false,
        reason: 'Promotion inactive ou expirée',
        error_key: PromotionErrorKeys.PROMOTION_INACTIVE_OR_EXPIRED
      };
    }


    // Vérifier le montant minimum
    if (promotion.min_order_amount && order_amount < promotion.min_order_amount) {
      return {
        discount_amount: 0,
        buyXGetY_amount: 0,
        final_amount: order_amount,
        applicable: false,
        reason: `Montant minimum requis: ${promotion.min_order_amount} XOF`,
        error_key: PromotionErrorKeys.PROMOTION_MIN_ORDER_AMOUNT_NOT_REACHED,
        data: { required_amount: promotion.min_order_amount, current_amount: order_amount }
      };
    }

    let discount_amount: number = 0;
    let buyXGetY_amount: number = 0;

    switch (promotion.discount_type) {
      case DiscountType.PERCENTAGE:
        discount_amount = (order_amount * promotion.discount_value) / 100;
        break;

      case DiscountType.FIXED_AMOUNT:
        discount_amount = promotion.discount_value;
        break;

      case DiscountType.BUY_X_GET_Y:
        buyXGetY_amount = promotion.offered_dishes?.reduce((total, pd) => {
          const dish = pd as unknown as Dish & { quantity: number };
          if (!dish) return total;
          const price = dish.is_promotion ? (dish.promotion_price ?? dish.price) : dish.price;
          return total + pd.quantity * price;
        }, 0) ?? 0;

        discount_amount = 0;

        break;
    }

    // Vérifier si le plafond est atteint
    const usagesAmount = await this.prisma.promotionUsage.aggregate({
      where: {
        promotion_id,
      },
      _sum: {
        discount_amount: true,
      },
    });
    const totalDiscountAmount = usagesAmount._sum.discount_amount ?? 0;

    if (promotion.max_discount_amount && totalDiscountAmount >= promotion.max_discount_amount) {
      return {
        discount_amount: 0,
        buyXGetY_amount: 0,
        final_amount: order_amount,
        applicable: false,
        reason: 'Promotion épuisée',
        error_key: PromotionErrorKeys.PROMOTION_EXHAUSTED
      };
    }

    // Appliquer le plafond de réduction
    if (promotion.max_discount_amount) {
      discount_amount = Math.min(discount_amount, promotion.max_discount_amount);
    }

    // S'assurer que la réduction ne dépasse pas le montant total
    discount_amount = Math.min(discount_amount, order_amount);

    return {
      discount_amount,
      buyXGetY_amount,
      final_amount: order_amount - discount_amount,
      applicable: true,
    };
  }

  // Vérifier si le client peut utiliser cette promotion
  async canCustomerUsePromotion(promotion_id: string, customer_id: string): Promise<{
    allowed: boolean;
    reason?: string;
    error_key?: PromotionErrorKeys;
    data?: any;
  }> {
    const promotion = await this.prisma.promotion.findUnique({
      where: { id: promotion_id },
      include: {
        promotion_usages: {
          where: { customer_id }
        }
      }
    });

    if (!promotion) {
      return {
        allowed: false,
        reason: 'Promotion non trouvée',
        error_key: PromotionErrorKeys.PROMOTION_NOT_FOUND,
        data: { promotion_id }
      };
    }

    // Vérifier les limites d'utilisation
    if (promotion.max_usage_per_user) {
      const userUsageCount = promotion.promotion_usages.length;
      if (userUsageCount >= promotion.max_usage_per_user) {
        return {
          allowed: false,
          reason: `Limite d'utilisation atteinte (${promotion.max_usage_per_user} fois maximum)`,
          error_key: PromotionErrorKeys.PROMOTION_USAGE_LIMIT_REACHED,
          data: { max_usage: promotion.max_usage_per_user, current_usage: userUsageCount }
        };
      }
    }

    if (promotion.max_total_usage && promotion.current_usage >= promotion.max_total_usage) {
      return {
        allowed: false,
        reason: 'Promotion épuisée',
        error_key: PromotionErrorKeys.PROMOTION_EXHAUSTED
      };
    }

    // Vérifier le niveau de fidélité pour les promotions privées
    if (promotion.visibility === 'PRIVATE') {
      const customer = await this.prisma.customer.findUnique({
        where: { id: customer_id }
      });

      if (!customer) {
        return {
          allowed: false,
          reason: 'Client non trouvé',
          error_key: PromotionErrorKeys.PROMOTION_CUSTOMER_NOT_FOUND,
          data: { customer_id }
        };
      }

      const hasAccess = (
        (customer.loyalty_level === 'STANDARD' && promotion.target_standard) ||
        (customer.loyalty_level === 'PREMIUM' && promotion.target_premium) ||
        (customer.loyalty_level === 'GOLD' && promotion.target_gold)
      );

      if (!hasAccess) {
        return {
          allowed: false,
          reason: 'Cette promotion n\'est pas disponible pour votre niveau de fidélité',
          error_key: PromotionErrorKeys.PROMOTION_NOT_ACCESSIBLE,
          data: { customer_loyalty_level: customer.loyalty_level }
        };
      }
    }

    return { allowed: true };
  }

  // Obtenir l'historique des promotions utilisées par un client
  async getCustomerPromotionHistory(customer_id: string, limit = 20) {
    return await this.prisma.promotionUsage.findMany({
      where: { customer_id },
      include: {
        promotion: {
          select: {
            id: true,
            title: true,
            description: true,
            discount_type: true,
            discount_value: true
          }
        },
        order: {
          select: {
            id: true,
            reference: true,
            created_at: true
          }
        }
      },
      orderBy: { created_at: 'desc' },
      take: limit
    });
  }

  private mapToResponseDto(promotion: any): PromotionResponseDto {
    return {
      id: promotion.id,
      title: promotion.title,
      description: promotion.description,
      discount_type: promotion.discount_type,
      discount_value: promotion.discount_value,
      target_type: promotion.target_type,
      min_order_amount: promotion.min_order_amount,
      max_discount_amount: promotion.max_discount_amount,
      max_usage_per_user: promotion.max_usage_per_user,
      max_total_usage: promotion.max_total_usage,
      current_usage: promotion.current_usage,
      start_date: promotion.start_date,
      expiration_date: promotion.expiration_date,
      status: promotion.status,
      visibility: promotion.visibility,
      is_active: promotion.is_active,
      target_standard: promotion.target_standard,
      target_premium: promotion.target_premium,
      target_gold: promotion.target_gold,
      coupon_image_url: promotion.coupon_image_url,
      background_color: promotion.background_color,
      text_color: promotion.text_color,
      expiration_color: promotion.expiration_color,
      created_by_id: promotion.created_by_id,
      created_at: promotion.created_at,
      updated_at: promotion.updated_at,
      targeted_dishes: promotion.promotion_targeted_dishes?.map(ptd => ptd.dish) || [],
      targeted_categories: promotion.promotion_targeted_categories?.map(ptc => ptc.category) || [],
      offered_dishes: promotion.promotion_dishes?.map(pd => ({ ...pd.dish, quantity: pd.quantity })) || [],
      restaurants: promotion.restaurantPromotions?.map(rp => {
        const restaurant = rp.restaurant;
        return { id: restaurant.id, name: restaurant.name }
      }) || [],
    };
  }
}
