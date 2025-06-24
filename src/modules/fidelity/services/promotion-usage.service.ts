import { Injectable, BadRequestException } from '@nestjs/common';
import { PromotionService } from './promotion.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { LoyaltyLevel } from '@prisma/client';

@Injectable()
export class PromotionUsageService {
  constructor(
    private prisma: PrismaService,
    private promotionService: PromotionService,
  ) { }

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
    return await this.prisma.$transaction(async (tx) => {
      // Vérifier si le client peut utiliser cette promotion
      const canUse = await this.canCustomerUsePromotion(promotion_id, customer_id);
      if (!canUse.allowed) {
        throw new BadRequestException(canUse.reason);
      }

      // Calculer la réduction
      const discount = await this.promotionService.calculateDiscount(
        promotion_id,
        order_amount,
        items,
        loyalty_level
      );

      if (!discount.applicable) {
        throw new BadRequestException(discount.reason || 'Promotion non applicable');
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
  }

  // Vérifier si le client peut utiliser cette promotion
  async canCustomerUsePromotion(promotion_id: string, customer_id: string) {
    const promotion = await this.prisma.promotion.findUnique({
      where: { id: promotion_id },
      include: {
        promotion_usages: {
          where: { customer_id }
        }
      }
    });

    if (!promotion) {
      return { allowed: false, reason: 'Promotion non trouvée' };
    }

    // Vérifier les limites d'utilisation
    if (promotion.max_usage_per_user) {
      const userUsageCount = promotion.promotion_usages.length;
      if (userUsageCount >= promotion.max_usage_per_user) {
        return {
          allowed: false,
          reason: `Limite d'utilisation atteinte (${promotion.max_usage_per_user} fois maximum)`
        };
      }
    }

    if (promotion.max_total_usage && promotion.current_usage >= promotion.max_total_usage) {
      return { allowed: false, reason: 'Promotion épuisée' };
    }

    // Vérifier le niveau de fidélité pour les promotions privées
    if (promotion.visibility === 'PRIVATE') {
      const customer = await this.prisma.customer.findUnique({
        where: { id: customer_id }
      });

      if (!customer) {
        return { allowed: false, reason: 'Client non trouvé' };
      }

      const hasAccess = (
        (customer.loyalty_level === 'STANDARD' && promotion.target_standard) ||
        (customer.loyalty_level === 'PREMIUM' && promotion.target_premium) ||
        (customer.loyalty_level === 'GOLD' && promotion.target_gold)
      );

      if (!hasAccess) {
        return {
          allowed: false,
          reason: 'Cette promotion n\'est pas disponible pour votre niveau de fidélité'
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
}
