import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { DiscountType, Prisma, User } from '@prisma/client';
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
      usages: true,
    },
  },
};

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

    const promoCode = await this.prismaService.promoCode.create({
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
        created_by: userId,
      },
      include: promoCodeInclude,
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

    const promoCode = await this.prismaService.promoCode.update({
      where: { id },
      data: updateData,
      include: promoCodeInclude,
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

  async applyPromoCode(code: string, customerId: string, orderAmount: number) {
    const promoCode = await this.prismaService.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
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

    // Validate per-user usage limit
    if (promoCode.max_usage_per_user) {
      const userUsageCount = await this.prismaService.promoCodeUsage.count({
        where: {
          promo_code_id: promoCode.id,
          customer_id: customerId,
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

    // Calculate discount
    let discountAmount: number;

    if (promoCode.discount_type === DiscountType.PERCENTAGE) {
      discountAmount = (promoCode.discount_value / 100) * orderAmount;
      if (promoCode.max_discount_amount) {
        discountAmount = Math.min(discountAmount, promoCode.max_discount_amount);
      }
    } else {
      // FIXED_AMOUNT
      discountAmount = Math.min(promoCode.discount_value, orderAmount);
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

    const [usage] = await this.prismaService.$transaction([
      this.prismaService.promoCodeUsage.create({
        data: {
          promo_code_id: promoCodeId,
          customer_id: customerId,
          order_id: orderId,
          discount_amount: discountAmount,
        },
      }),
      this.prismaService.promoCode.update({
        where: { id: promoCodeId },
        data: { usage_count: { increment: 1 } },
      }),
    ]);

    this.logger.log({
      message: 'Utilisation de code promo enregistrée',
      code: promoCode.code,
      customerId,
      discountAmount,
    });

    this.appGateway.emitToBackoffice('promo_code:usage_recorded', {
      promoCodeId,
      customerId,
      orderId,
      discountAmount,
    });

    return usage;
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
      this.prismaService.promoCodeUsage.count(),
      this.prismaService.promoCodeUsage.aggregate({
        _sum: { discount_amount: true },
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
