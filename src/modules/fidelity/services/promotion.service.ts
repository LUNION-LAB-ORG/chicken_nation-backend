import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { CreatePromotionDto } from '../dto/create-promotion.dto';
import { UpdatePromotionDto } from '../dto/update-promotion.dto';
import { PromotionResponseDto } from '../dto/promotion-response.dto';
import { Prisma, Promotion, Visibility } from '@prisma/client';
import { DiscountType, TargetType, PromotionStatus, LoyaltyLevel } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { QueryPromotionDto } from '../dto/query-promotion.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';

interface Dish {
  id: string;
  name: string;
  description: string;
  price: number;
  image: string | null;
  is_promotion: boolean;
  promotion_price: number;
  category_id: string;
  entity_status: PromotionStatus;
  created_at: string;
  updated_at: string;
}
@Injectable()
export class PromotionService {
  constructor(private prisma: PrismaService) { }

  async create(createPromotionDto: CreatePromotionDto, created_by_id: string): Promise<Promotion> {
    const {
      targeted_dish_ids = [],
      targeted_category_ids = [],
      offered_dishes = [],
      ...promotionData
    } = createPromotionDto;

    // Validation des dates
    const startDate = new Date(promotionData.start_date);
    const endDate = new Date(promotionData.expiration_date);

    if (startDate >= endDate) {
      throw new BadRequestException('La date de fin doit être postérieure à la date de début');
    }

    // Validation du ciblage
    if (promotionData.target_type === TargetType.SPECIFIC_PRODUCTS && targeted_dish_ids.length === 0) {
      throw new BadRequestException('Vous devez sélectionner au moins un plat pour ce type de promotion');
    }

    if (promotionData.target_type === TargetType.CATEGORIES && targeted_category_ids.length === 0) {
      throw new BadRequestException('Vous devez sélectionner au moins une catégorie pour ce type de promotion');
    }
    // Validation de la visibilité
    if (promotionData.visibility === Visibility.PRIVATE && !promotionData.target_standard && !promotionData.target_premium && !promotionData.target_gold) {
      throw new BadRequestException('Vous devez sélectionner au moins un niveau de fidélité pour ce type de promotion, exemple : standard, premium, gold');
    }

    // Validation du type de remise
    if (promotionData.discount_type === DiscountType.BUY_X_GET_Y && offered_dishes.length === 0) {
      throw new BadRequestException('Vous devez sélectionner au moins un plat pour ce type de promotion');
    }

    return await this.prisma.$transaction(async (tx) => {
      // Créer la promotion
      const promotion = await tx.promotion.create({
        data: {
          ...promotionData,
          start_date: startDate.toISOString(),
          expiration_date: endDate.toISOString(),
          created_by_id,
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

    if (filters?.targeted_dish_ids?.length) where.promotion_targeted_dishes = { some: { dish_id: { in: filters.targeted_dish_ids } } };

    if (filters?.targeted_dish_ids?.length) where.promotion_dishes = { some: { dish_id: { in: filters.targeted_dish_ids } } };

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
        }
      }
    });
    if (!promotion) {
      throw new NotFoundException('Promotion non trouvée');
    }

    return this.mapToResponseDto(promotion);
  }

  async update(id: string, updatePromotionDto: UpdatePromotionDto): Promise<PromotionResponseDto> {
    const {
      targeted_dish_ids,
      targeted_category_ids,
      offered_dishes,
      ...promotionData
    } = updatePromotionDto;
    await this.prisma.$transaction(async (tx) => {
      // Mettre à jour la promotion
      await tx.promotion.update({
        where: { id },
        data: {
          ...promotionData,
          start_date: updatePromotionDto.start_date ? new Date(updatePromotionDto.start_date).toISOString() : undefined,
          expiration_date: updatePromotionDto.expiration_date ? new Date(updatePromotionDto.expiration_date).toISOString() : undefined,
        },
      });

      // Mettre à jour les relations si nécessaire
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
    });
    return this.findOne(id);
  }

  async remove(id: string): Promise<PromotionResponseDto> {
    const promotion = await this.prisma.promotion.update({
      where: { id },
      data: { status: PromotionStatus.EXPIRED }
    });
    if (!promotion) {
      throw new NotFoundException('Promotion non trouvée');
    }
    return this.mapToResponseDto(promotion);
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
    items: { dish_id: string; quantity: number; price: number }[],
    loyalty_level?: LoyaltyLevel
  ): Promise<{
    discount_amount: number;
    buyXGetY_amount: number;
    final_amount: number;
    applicable: boolean;
    reason?: string;
  }> {

    if (!promotion_id) {
      return { discount_amount: 0, buyXGetY_amount: 0, final_amount: order_amount, applicable: false, reason: 'Promotion non trouvée' };
    }
    if (items.length === 0) {
      return { discount_amount: 0, buyXGetY_amount: 0, final_amount: order_amount, applicable: false, reason: 'Aucun plat dans la commande' };
    }
    const promotion = await this.findOne(promotion_id);

    // Si la promotion n'est pas trouvée, retourner 0
    if (!promotion) {
      return { discount_amount: 0, buyXGetY_amount: 0, final_amount: order_amount, applicable: false, reason: 'Promotion non trouvée' };
    }
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
      return { discount_amount: 0, buyXGetY_amount: 0, final_amount: order_amount, applicable: false, reason: 'Vous ne pouvez pas bénéficier de cette promotion' };
    }
    // Vérifier si la promotion est active
    const now = new Date();
    if (promotion.status !== PromotionStatus.ACTIVE ||
      new Date(promotion.start_date) > now ||
      new Date(promotion.expiration_date) < now) {
      return { discount_amount: 0, buyXGetY_amount: 0, final_amount: order_amount, applicable: false, reason: 'Promotion inactive ou expirée' };
    }

    // Vérifier le montant minimum
    if (promotion.min_order_amount && order_amount < promotion.min_order_amount) {
      return {
        discount_amount: 0,
        buyXGetY_amount: 0,
        final_amount: order_amount,
        applicable: false,
        reason: `Montant minimum requis: ${promotion.min_order_amount} XOF`
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
      return { discount_amount: 0, buyXGetY_amount: 0, final_amount: order_amount, applicable: false, reason: 'Promotion épuisée' };
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
      applicable: true
    };
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
      offered_dishes: promotion.promotion_dishes?.map(pd => ({ ...pd.dish, quantity: pd.quantity })) || []
    };
  }
}