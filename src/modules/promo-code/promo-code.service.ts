import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { DiscountType, Prisma, PromoCodeUsageStatus, TargetType, User } from '@prisma/client';
import type { Request } from 'express';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { UpdatePromoCodeDto } from './dto/update-promo-code.dto';
import { QueryPromoCodeDto } from './dto/query-promo-code.dto';

const promoCodeInclude = {
  creator: {
    select: {
      id: true,
      email: true,
      fullname: true,
    },
  },
  _count: {
    select: {
      // Ne compter que les usages ACTIFS (commandes payées/acceptées non annulées).
      usages: { where: { status: PromoCodeUsageStatus.ACTIVE } },
    },
  },
  promo_code_targeted_dishes: {
    include: {
      dish: {
        select: { id: true, name: true, image: true, price: true, category_id: true },
      },
    },
  },
  promo_code_targeted_categories: {
    include: {
      category: {
        select: { id: true, name: true, image: true },
      },
    },
  },
} satisfies Prisma.PromoCodeInclude;

@Injectable()
export class PromoCodeService {
  private readonly logger = new Logger(PromoCodeService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly appGateway: AppGateway,
  ) {}

  async create(req: Request, dto: CreatePromoCodeDto) {
    const userId = (req.user as User).id;

    // Validate dates
    const now = new Date();
    const startDate = new Date(dto.start_date);
    const expirationDate = new Date(dto.expiration_date);

    if (expirationDate <= startDate) {
      throw new HttpException(
        'La date d\'expiration doit être postérieure à la date de début',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (expirationDate <= now) {
      throw new HttpException(
        'La date d\'expiration ne peut pas être dans le passé',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Check code uniqueness
    const existing = await this.prismaService.promoCode.findUnique({
      where: { code: dto.code.toUpperCase().trim() },
    });

    if (existing) {
      throw new HttpException(
        'Ce code promotionnel existe déjà',
        HttpStatus.CONFLICT,
      );
    }

    // Validate percentage discount
    if (dto.discount_type === DiscountType.PERCENTAGE && dto.discount_value > 100) {
      throw new HttpException(
        'Le pourcentage de réduction ne peut pas dépasser 100%',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Validate targeting (parité avec le module Promotion)
    const targetType = dto.target_type ?? TargetType.ALL_PRODUCTS;
    const targetedDishIds = dto.targeted_dish_ids ?? [];
    const targetedCategoryIds = dto.targeted_category_ids ?? [];

    if (targetType === TargetType.SPECIFIC_PRODUCTS && targetedDishIds.length === 0) {
      throw new HttpException(
        'Vous devez sélectionner au moins un plat pour ce type de ciblage',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (targetType === TargetType.CATEGORIES && targetedCategoryIds.length === 0) {
      throw new HttpException(
        'Vous devez sélectionner au moins une catégorie pour ce type de ciblage',
        HttpStatus.BAD_REQUEST,
      );
    }

    const promoCode = await this.prismaService.$transaction(async (tx) => {
      const created = await tx.promoCode.create({
        data: {
          code: dto.code.toUpperCase().trim(),
          description: dto.description,
          discount_type: dto.discount_type,
          discount_value: dto.discount_value,
          min_order_amount: dto.min_order_amount ?? 0,
          max_discount_amount: dto.max_discount_amount,
          max_usage: dto.max_usage,
          max_usage_per_user: dto.max_usage_per_user ?? 1,
          start_date: startDate,
          expiration_date: expirationDate,
          is_active: dto.is_active ?? true,
          restaurant_ids: dto.restaurant_ids ?? [],
          target_type: targetType,
          created_by: userId,
        },
      });

      if (targetType === TargetType.SPECIFIC_PRODUCTS && targetedDishIds.length > 0) {
        await tx.promoCodeTargetedDish.createMany({
          data: targetedDishIds.map((dish_id) => ({
            promo_code_id: created.id,
            dish_id,
          })),
        });
      }

      if (targetType === TargetType.CATEGORIES && targetedCategoryIds.length > 0) {
        await tx.promoCodeTargetedCategory.createMany({
          data: targetedCategoryIds.map((category_id) => ({
            promo_code_id: created.id,
            category_id,
          })),
        });
      }

      return tx.promoCode.findUniqueOrThrow({
        where: { id: created.id },
        include: promoCodeInclude,
      });
    });

    this.logger.log({
      message: 'Code promo créé',
      code: promoCode.code,
      userId,
    });

    this.appGateway.emitToBackoffice('promo_code:created', promoCode);

    return promoCode;
  }

  async findAll(query: QueryPromoCodeDto) {
    const {
      code,
      is_active,
      discount_type,
      startDate,
      endDate,
      page = 1,
      limit = 10,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = query;

    const where: Prisma.PromoCodeWhereInput = {
      entity_status: { not: 'DELETED' },
    };

    if (code) {
      where.code = { contains: code.toUpperCase(), mode: 'insensitive' };
    }

    if (is_active !== undefined) {
      where.is_active = is_active;
    }

    if (discount_type) {
      where.discount_type = discount_type;
    }

    if (startDate) {
      where.start_date = { gte: new Date(startDate) };
    }

    if (endDate) {
      where.expiration_date = { lte: new Date(endDate) };
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prismaService.promoCode.findMany({
        where,
        include: promoCodeInclude,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prismaService.promoCode.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const promoCode = await this.prismaService.promoCode.findUnique({
      where: { id },
      include: {
        ...promoCodeInclude,
        usages: {
          where: { status: PromoCodeUsageStatus.ACTIVE },
          include: {
            customer: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                phone: true,
              },
            },
            order: {
              select: {
                id: true,
                reference: true,
                amount: true,
              },
            },
          },
          orderBy: { created_at: 'desc' },
        },
      },
    });

    if (!promoCode) {
      throw new HttpException('Code promo introuvable', HttpStatus.NOT_FOUND);
    }

    return promoCode;
  }

  async findByCode(code: string) {
    const promoCode = await this.prismaService.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
      include: promoCodeInclude,
    });

    if (!promoCode) {
      throw new HttpException('Code promo introuvable', HttpStatus.NOT_FOUND);
    }

    return promoCode;
  }

  async update(id: string, dto: UpdatePromoCodeDto) {
    const existing = await this.prismaService.promoCode.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new HttpException('Code promo introuvable', HttpStatus.NOT_FOUND);
    }

    // If code is being changed, check uniqueness
    if (dto.code && dto.code.toUpperCase().trim() !== existing.code) {
      const codeExists = await this.prismaService.promoCode.findUnique({
        where: { code: dto.code.toUpperCase().trim() },
      });
      if (codeExists) {
        throw new HttpException('Ce code promotionnel existe déjà', HttpStatus.CONFLICT);
      }
    }

    // Validate percentage
    const discountType = dto.discount_type ?? existing.discount_type;
    const discountValue = dto.discount_value ?? existing.discount_value;
    if (discountType === DiscountType.PERCENTAGE && discountValue > 100) {
      throw new HttpException(
        'Le pourcentage de réduction ne peut pas dépasser 100%',
        HttpStatus.BAD_REQUEST,
      );
    }

    const updateData: Prisma.PromoCodeUpdateInput = {};

    if (dto.code !== undefined) updateData.code = dto.code.toUpperCase().trim();
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.discount_type !== undefined) updateData.discount_type = dto.discount_type;
    if (dto.discount_value !== undefined) updateData.discount_value = dto.discount_value;
    if (dto.min_order_amount !== undefined) updateData.min_order_amount = dto.min_order_amount;
    if (dto.max_discount_amount !== undefined) updateData.max_discount_amount = dto.max_discount_amount;
    if (dto.max_usage !== undefined) updateData.max_usage = dto.max_usage;
    if (dto.max_usage_per_user !== undefined) updateData.max_usage_per_user = dto.max_usage_per_user;
    if (dto.start_date !== undefined) updateData.start_date = new Date(dto.start_date);
    if (dto.expiration_date !== undefined) updateData.expiration_date = new Date(dto.expiration_date);
    if (dto.is_active !== undefined) updateData.is_active = dto.is_active;
    if (dto.restaurant_ids !== undefined) updateData.restaurant_ids = dto.restaurant_ids;
    if (dto.target_type !== undefined) updateData.target_type = dto.target_type;

    // Effective target_type pour validation et reset des liaisons
    const effectiveTargetType = dto.target_type ?? existing.target_type;
    const targetedDishIds = dto.targeted_dish_ids;
    const targetedCategoryIds = dto.targeted_category_ids;

    // Validation : si on bascule vers SPECIFIC_PRODUCTS/CATEGORIES sans liste explicite,
    // on autorise tant qu'une liste existait déjà côté DB
    if (
      effectiveTargetType === TargetType.SPECIFIC_PRODUCTS &&
      targetedDishIds !== undefined &&
      targetedDishIds.length === 0
    ) {
      throw new HttpException(
        'Vous devez sélectionner au moins un plat pour ce type de ciblage',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      effectiveTargetType === TargetType.CATEGORIES &&
      targetedCategoryIds !== undefined &&
      targetedCategoryIds.length === 0
    ) {
      throw new HttpException(
        'Vous devez sélectionner au moins une catégorie pour ce type de ciblage',
        HttpStatus.BAD_REQUEST,
      );
    }

    const promoCode = await this.prismaService.$transaction(async (tx) => {
      await tx.promoCode.update({
        where: { id },
        data: updateData,
      });

      // Si target_type change ou si une nouvelle liste est fournie : reset + recréation.
      // Si target_type passe à ALL_PRODUCTS, on purge toutes les liaisons.
      if (dto.target_type !== undefined || targetedDishIds !== undefined) {
        await tx.promoCodeTargetedDish.deleteMany({ where: { promo_code_id: id } });
        if (
          effectiveTargetType === TargetType.SPECIFIC_PRODUCTS &&
          targetedDishIds &&
          targetedDishIds.length > 0
        ) {
          await tx.promoCodeTargetedDish.createMany({
            data: targetedDishIds.map((dish_id) => ({ promo_code_id: id, dish_id })),
          });
        }
      }

      if (dto.target_type !== undefined || targetedCategoryIds !== undefined) {
        await tx.promoCodeTargetedCategory.deleteMany({ where: { promo_code_id: id } });
        if (
          effectiveTargetType === TargetType.CATEGORIES &&
          targetedCategoryIds &&
          targetedCategoryIds.length > 0
        ) {
          await tx.promoCodeTargetedCategory.createMany({
            data: targetedCategoryIds.map((category_id) => ({ promo_code_id: id, category_id })),
          });
        }
      }

      return tx.promoCode.findUniqueOrThrow({
        where: { id },
        include: promoCodeInclude,
      });
    });

    this.logger.log({
      message: 'Code promo mis à jour',
      code: promoCode.code,
    });

    this.appGateway.emitToBackoffice('promo_code:updated', promoCode);

    return promoCode;
  }

  async remove(id: string) {
    const existing = await this.prismaService.promoCode.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new HttpException('Code promo introuvable', HttpStatus.NOT_FOUND);
    }

    const promoCode = await this.prismaService.promoCode.update({
      where: { id },
      data: { entity_status: 'DELETED' },
      include: promoCodeInclude,
    });

    this.logger.log({
      message: 'Code promo supprimé (soft delete)',
      code: promoCode.code,
    });

    this.appGateway.emitToBackoffice('promo_code:deleted', promoCode);

    return promoCode;
  }

  async toggleActive(id: string) {
    const existing = await this.prismaService.promoCode.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new HttpException('Code promo introuvable', HttpStatus.NOT_FOUND);
    }

    const promoCode = await this.prismaService.promoCode.update({
      where: { id },
      data: { is_active: !existing.is_active },
      include: promoCodeInclude,
    });

    this.logger.log({
      message: `Code promo ${promoCode.is_active ? 'activé' : 'désactivé'}`,
      code: promoCode.code,
    });

    this.appGateway.emitToBackoffice('promo_code:updated', promoCode);

    return promoCode;
  }

  async applyPromoCode(
    code: string,
    customerId: string,
    orderAmount: number,
    orderItems?: { dish_id: string; quantity: number; price: number }[],
  ) {
    const promoCode = await this.prismaService.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
      include: {
        promo_code_targeted_dishes: { select: { dish_id: true } },
        promo_code_targeted_categories: { select: { category_id: true } },
      },
    });

    if (!promoCode) {
      throw new HttpException('Code promo introuvable', HttpStatus.NOT_FOUND);
    }

    // Validate active status
    if (!promoCode.is_active) {
      throw new HttpException('Ce code promo n\'est pas actif', HttpStatus.BAD_REQUEST);
    }

    // Validate entity status
    if (promoCode.entity_status === 'DELETED') {
      throw new HttpException('Ce code promo n\'existe plus', HttpStatus.BAD_REQUEST);
    }

    // Validate dates
    const now = new Date();
    if (now < promoCode.start_date) {
      throw new HttpException('Ce code promo n\'est pas encore valide', HttpStatus.BAD_REQUEST);
    }

    if (now > promoCode.expiration_date) {
      throw new HttpException('Ce code promo a expiré', HttpStatus.BAD_REQUEST);
    }

    // Validate global usage limit
    if (promoCode.max_usage && promoCode.usage_count >= promoCode.max_usage) {
      throw new HttpException('Ce code promo a atteint son nombre maximum d\'utilisations', HttpStatus.BAD_REQUEST);
    }

    // Validate per-user usage limit (usages ACTIFS uniquement)
    if (promoCode.max_usage_per_user) {
      const userUsageCount = await this.prismaService.promoCodeUsage.count({
        where: {
          promo_code_id: promoCode.id,
          customer_id: customerId,
          status: PromoCodeUsageStatus.ACTIVE,
        },
      });

      if (userUsageCount >= promoCode.max_usage_per_user) {
        throw new HttpException(
          'Vous avez déjà utilisé ce code promo le nombre maximum de fois',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // Validate min order amount
    if (promoCode.min_order_amount && orderAmount < promoCode.min_order_amount) {
      throw new HttpException(
        `Le montant minimum de commande est de ${promoCode.min_order_amount} FCFA`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Déterminer le montant éligible selon le ciblage.
    // Pattern aligné sur PromotionService.calculateDiscount : la remise s'applique
    // uniquement sur le sous-total des items éligibles.
    let eligibleAmount = orderAmount;

    if (promoCode.target_type !== TargetType.ALL_PRODUCTS) {
      if (!orderItems || orderItems.length === 0) {
        throw new HttpException(
          'Ce code promo cible des produits spécifiques. Les détails de la commande sont requis.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const targetedDishIds = new Set(
        promoCode.promo_code_targeted_dishes.map((t) => t.dish_id),
      );
      const targetedCategoryIds = new Set(
        promoCode.promo_code_targeted_categories.map((t) => t.category_id),
      );

      // Pour CATEGORIES, charger les category_id des plats commandés en une requête
      let dishCategoryMap = new Map<string, string>();
      if (promoCode.target_type === TargetType.CATEGORIES) {
        const dishes = await this.prismaService.dish.findMany({
          where: { id: { in: orderItems.map((i) => i.dish_id) } },
          select: { id: true, category_id: true },
        });
        dishCategoryMap = new Map(dishes.map((d) => [d.id, d.category_id]));
      }

      const eligibleItems = orderItems.filter((item) => {
        if (promoCode.target_type === TargetType.SPECIFIC_PRODUCTS) {
          return targetedDishIds.has(item.dish_id);
        }
        if (promoCode.target_type === TargetType.CATEGORIES) {
          const categoryId = dishCategoryMap.get(item.dish_id);
          return categoryId ? targetedCategoryIds.has(categoryId) : false;
        }
        return false;
      });

      if (eligibleItems.length === 0) {
        throw new HttpException(
          'Ce code promo ne s\'applique à aucun produit de votre commande',
          HttpStatus.BAD_REQUEST,
        );
      }

      eligibleAmount = eligibleItems.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0,
      );
    }

    // Calculate discount sur le montant éligible
    let discountAmount: number;

    if (promoCode.discount_type === DiscountType.PERCENTAGE) {
      discountAmount = (promoCode.discount_value / 100) * eligibleAmount;
      if (promoCode.max_discount_amount) {
        discountAmount = Math.min(discountAmount, promoCode.max_discount_amount);
      }
    } else {
      // FIXED_AMOUNT
      discountAmount = Math.min(promoCode.discount_value, eligibleAmount);
    }

    discountAmount = Math.round(discountAmount);

    return {
      isValid: true,
      discountAmount,
      promoCode: {
        id: promoCode.id,
        code: promoCode.code,
        discount_type: promoCode.discount_type,
        discount_value: promoCode.discount_value,
        description: promoCode.description,
        target_type: promoCode.target_type,
      },
    };
  }

  async recordUsage(
    promoCodeId: string,
    customerId: string,
    orderId: string | null,
    discountAmount: number,
  ) {
    const promoCode = await this.prismaService.promoCode.findUnique({
      where: { id: promoCodeId },
    });

    if (!promoCode) {
      throw new HttpException('Code promo introuvable', HttpStatus.NOT_FOUND);
    }

    // Idempotence par (promo_code_id, order_id) : un même code ne peut être
    // enregistré qu'UNE fois pour une commande donnée. Sans ça, on dédoublait
    // l'usage (l'app appelle POST /promo-code/:id/record-usage ET createv2
    // enregistre automatiquement → 2 lignes par commande, usage_count gonflé).
    // Protège aussi contre un éventuel double backend pointant la même base.
    if (orderId) {
      const existing = await this.prismaService.promoCodeUsage.findFirst({
        where: { promo_code_id: promoCodeId, order_id: orderId },
      });
      if (existing) {
        this.logger.warn({
          message: 'Usage de code promo déjà enregistré pour cette commande — ignoré (idempotence)',
          code: promoCode.code,
          orderId,
        });
        return existing;
      }
    }

    // On STAGE l'usage en INACTIVE (commande encore PENDING, non payée) : il
    // capture le promo_code_id + order_id + le montant EXACT de la réduction,
    // mais NE compte PAS encore (pas d'incrément usage_count). Il sera activé
    // quand la commande passe ACCEPTED (cf. activateUsageForOrder).
    const usage = await this.prismaService.promoCodeUsage.create({
      data: {
        promo_code_id: promoCodeId,
        customer_id: customerId,
        order_id: orderId,
        discount_amount: discountAmount,
        status: PromoCodeUsageStatus.INACTIVE,
      },
    });

    this.logger.log({
      message: 'Usage de code promo staged (INACTIVE)',
      code: promoCode.code,
      customerId,
      discountAmount,
    });

    return usage;
  }

  /**
   * Comptabilise le code promo d'une commande devenue payée / ACCEPTED.
   *  - Si un usage a été stagé à la création → passe ACTIVE + usage_count++.
   *  - Sinon, si la commande porte un code_promo (cas backoffice qui ne stage
   *    pas à la création) → crée l'usage directement ACTIVE avec le montant de
   *    réduction de la commande.
   * Idempotent : no-op si l'usage est déjà ACTIVE ou s'il n'y a pas de code.
   */
  async activateUsageForOrder(order: {
    id: string;
    code_promo: string | null;
    customer_id: string;
    discount: number | null;
  }) {
    if (!order.code_promo) return;

    const existing = await this.prismaService.promoCodeUsage.findFirst({
      where: { order_id: order.id },
    });

    if (existing) {
      if (existing.status === PromoCodeUsageStatus.ACTIVE) return; // déjà compté
      await this.prismaService.$transaction([
        this.prismaService.promoCodeUsage.update({
          where: { id: existing.id },
          data: { status: PromoCodeUsageStatus.ACTIVE },
        }),
        this.prismaService.promoCode.update({
          where: { id: existing.promo_code_id },
          data: { usage_count: { increment: 1 } },
        }),
      ]);
      this.appGateway.emitToBackoffice('promo_code:usage_recorded', {
        promoCodeId: existing.promo_code_id,
        orderId: order.id,
      });
      return;
    }

    // Pas d'usage stagé : résoudre le code et créer directement ACTIVE.
    const promo = await this.prismaService.promoCode.findFirst({
      where: { code: order.code_promo },
    });
    if (!promo) return;
    await this.prismaService.$transaction([
      this.prismaService.promoCodeUsage.create({
        data: {
          promo_code_id: promo.id,
          customer_id: order.customer_id,
          order_id: order.id,
          discount_amount: order.discount ?? 0,
          status: PromoCodeUsageStatus.ACTIVE,
        },
      }),
      this.prismaService.promoCode.update({
        where: { id: promo.id },
        data: { usage_count: { increment: 1 } },
      }),
    ]);
    this.appGateway.emitToBackoffice('promo_code:usage_recorded', {
      promoCodeId: promo.id,
      orderId: order.id,
    });
  }

  /**
   * Décompte le code promo d'une commande ANNULÉE : tous les usages ACTIVE de
   * cette commande repassent INACTIVE + usage_count--. Idempotent (no-op si
   * aucun usage actif).
   */
  async deactivateUsageForOrder(orderId: string) {
    const actives = await this.prismaService.promoCodeUsage.findMany({
      where: { order_id: orderId, status: PromoCodeUsageStatus.ACTIVE },
    });
    if (actives.length === 0) return;

    await this.prismaService.$transaction(
      actives.flatMap((u) => [
        this.prismaService.promoCodeUsage.update({
          where: { id: u.id },
          data: { status: PromoCodeUsageStatus.INACTIVE },
        }),
        this.prismaService.promoCode.update({
          where: { id: u.promo_code_id },
          data: { usage_count: { decrement: 1 } },
        }),
      ]),
    );

    for (const u of actives) {
      this.appGateway.emitToBackoffice('promo_code:usage_reverted', {
        promoCodeId: u.promo_code_id,
        orderId,
      });
    }
  }

  /**
   * Analytics détaillées d'un code promo (vue détail backoffice).
   * Une seule lecture "slim" des usages, agrégats calculés côté serveur :
   * KPIs, série par jour, répartition par heure / jour de semaine, top clients.
   * Fuseau : la Côte d'Ivoire est en UTC+0 → heures UTC = heures locales.
   */
  async getAnalytics(id: string) {
    const promoCode = await this.prismaService.promoCode.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!promoCode) {
      throw new HttpException('Code promo introuvable', HttpStatus.NOT_FOUND);
    }

    const usages = await this.prismaService.promoCodeUsage.findMany({
      where: { promo_code_id: id, status: PromoCodeUsageStatus.ACTIVE },
      select: {
        customer_id: true,
        discount_amount: true,
        created_at: true,
        order: { select: { amount: true } },
      },
      orderBy: { created_at: 'asc' },
    });

    const totalUsages = usages.length;
    const totalDiscount = usages.reduce((s, u) => s + (u.discount_amount ?? 0), 0);
    const orderAmounts = usages
      .map((u) => u.order?.amount)
      .filter((a): a is number => typeof a === 'number');
    const totalRevenue = orderAmounts.reduce((s, a) => s + a, 0);

    // Agrégat par client (clients uniques, taux de réutilisation, top clients)
    const byCustomer = new Map<string, { usages: number; discount: number }>();
    for (const u of usages) {
      const c = byCustomer.get(u.customer_id) ?? { usages: 0, discount: 0 };
      c.usages += 1;
      c.discount += u.discount_amount ?? 0;
      byCustomer.set(u.customer_id, c);
    }
    const uniqueCustomers = byCustomer.size;
    const repeatCustomers = [...byCustomer.values()].filter((c) => c.usages > 1).length;

    // Séries temporelles
    const byDay = new Map<string, { usages: number; discount: number }>();
    const byHour: number[] = Array.from({ length: 24 }, () => 0);
    const byWeekday: number[] = Array.from({ length: 7 }, () => 0); // 0 = dimanche
    for (const u of usages) {
      const d = new Date(u.created_at);
      const day = d.toISOString().slice(0, 10);
      const e = byDay.get(day) ?? { usages: 0, discount: 0 };
      e.usages += 1;
      e.discount += u.discount_amount ?? 0;
      byDay.set(day, e);
      byHour[d.getUTCHours()] += 1;
      byWeekday[d.getUTCDay()] += 1;
    }

    // Top 5 clients (noms/téléphones récupérés en une requête)
    const top = [...byCustomer.entries()]
      .sort((a, b) => b[1].usages - a[1].usages || b[1].discount - a[1].discount)
      .slice(0, 5);
    const topInfos = top.length
      ? await this.prismaService.customer.findMany({
          where: { id: { in: top.map(([cid]) => cid) } },
          select: { id: true, first_name: true, last_name: true, phone: true },
        })
      : [];
    const infoById = new Map(topInfos.map((c) => [c.id, c]));

    return {
      kpis: {
        total_usages: totalUsages,
        unique_customers: uniqueCustomers,
        orders_count: orderAmounts.length,
        total_discount: totalDiscount,
        total_revenue: totalRevenue,
        avg_basket: orderAmounts.length ? totalRevenue / orderAmounts.length : 0,
        avg_discount: totalUsages ? totalDiscount / totalUsages : 0,
        repeat_rate: uniqueCustomers ? repeatCustomers / uniqueCustomers : 0,
        first_usage_at: totalUsages ? usages[0].created_at : null,
        last_usage_at: totalUsages ? usages[totalUsages - 1].created_at : null,
      },
      by_day: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
      by_hour: byHour.map((count, hour) => ({ hour, usages: count })),
      by_weekday: byWeekday.map((count, weekday) => ({ weekday, usages: count })),
      top_customers: top.map(([cid, v]) => ({
        customer_id: cid,
        first_name: infoById.get(cid)?.first_name ?? null,
        last_name: infoById.get(cid)?.last_name ?? null,
        phone: infoById.get(cid)?.phone ?? null,
        usages: v.usages,
        total_discount: v.discount,
      })),
    };
  }

  /**
   * Utilisations paginées d'un code promo (table "commandes" de la vue détail).
   */
  async getUsages(id: string, page = 1, limit = 10) {
    const promoCode = await this.prismaService.promoCode.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!promoCode) {
      throw new HttpException('Code promo introuvable', HttpStatus.NOT_FOUND);
    }

    const skip = (page - 1) * limit;
    const usageWhere = {
      promo_code_id: id,
      status: PromoCodeUsageStatus.ACTIVE,
    };
    const [data, total] = await Promise.all([
      this.prismaService.promoCodeUsage.findMany({
        where: usageWhere,
        include: {
          customer: {
            select: { id: true, first_name: true, last_name: true, phone: true },
          },
          order: {
            select: { id: true, reference: true, amount: true, status: true },
          },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prismaService.promoCodeUsage.count({ where: usageWhere }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getStats() {
    const now = new Date();
    const [activeCount, totalUsage, totalDiscountAmount, expiredCount] = await Promise.all([
      this.prismaService.promoCode.count({
        where: {
          is_active: true,
          entity_status: { not: 'DELETED' },
          expiration_date: { gte: now },
          start_date: { lte: now },
        },
      }),
      this.prismaService.promoCodeUsage.count({
        where: { status: PromoCodeUsageStatus.ACTIVE },
      }),
      this.prismaService.promoCodeUsage.aggregate({
        _sum: { discount_amount: true },
        where: { status: PromoCodeUsageStatus.ACTIVE },
      }),
      this.prismaService.promoCode.count({
        where: {
          entity_status: { not: 'DELETED' },
          expiration_date: { lt: now },
        },
      }),
    ]);

    return {
      activeCount,
      expiredCount,
      totalUsage,
      totalDiscountAmount: totalDiscountAmount._sum.discount_amount ?? 0,
    };
  }

  /**
   * Récupère les codes promo actifs que le client peut utiliser
   */
  async getActiveForCustomer(customerId: string) {
    const now = new Date();

    const promoCodes = await this.prismaService.promoCode.findMany({
      where: {
        is_active: true,
        entity_status: { not: 'DELETED' },
        start_date: { lte: now },
        expiration_date: { gte: now },
      },
      include: {
        _count: { select: { usages: true } },
      },
      orderBy: { expiration_date: 'asc' },
    });

    // Filtrer ceux qui ne sont pas encore épuisés pour ce client
    const results: typeof promoCodes = [];
    for (const promo of promoCodes) {
      // Vérifier la limite globale
      if (promo.max_usage && promo.usage_count >= promo.max_usage) continue;

      // Vérifier la limite par utilisateur
      if (promo.max_usage_per_user) {
        const userUsageCount = await this.prismaService.promoCodeUsage.count({
          where: {
            promo_code_id: promo.id,
            customer_id: customerId,
          },
        });
        if (userUsageCount >= promo.max_usage_per_user) continue;
      }

      results.push(promo);
    }

    return results;
  }

  /**
   * Désactive automatiquement les codes promo expirés (tous les jours à 1h du matin)
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async deactivateExpiredPromoCodes() {
    const result = await this.prismaService.promoCode.updateMany({
      where: {
        is_active: true,
        expiration_date: { lt: new Date() },
        entity_status: { not: 'DELETED' },
      },
      data: { is_active: false },
    });

    if (result.count > 0) {
      this.logger.log(`${result.count} codes promo expirés désactivés automatiquement`);
      this.appGateway.emitToBackoffice('promo_code:expired_batch', { count: result.count });
    }
  }
}
