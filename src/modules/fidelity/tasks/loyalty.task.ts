import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LoyaltyService } from '../services/loyalty.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { PromotionStatus } from '@prisma/client';

@Injectable()
export class LoyaltyTask {
  private readonly logger = new Logger(LoyaltyTask.name);

  constructor(
    private loyaltyService: LoyaltyService,
    private prisma: PrismaService
  ) {}

  // Expire les points tous les jours à minuit
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async expirePoints() {
    this.logger.log('Début de l\'expiration des points de fidélité...');
    
    try {
      const expiredCount = await this.loyaltyService.expirePoints();
      this.logger.log(`${expiredCount} points de fidélité expirés`);
    } catch (error) {
      this.logger.error('Erreur lors de l\'expiration des points:', error);
    }
  }

  // Vérifie et met à jour le statut des promotions toutes les heures
  @Cron(CronExpression.EVERY_HOUR)
  async updatePromotionStatus() {
    this.logger.log('Mise à jour du statut des promotions...');
    
    try {
      const now = new Date();
      
      // Marquer les promotions expirées
      const expiredPromotions = await this.prisma.promotion.updateMany({
        where: {
          status: PromotionStatus.ACTIVE,
          expiration_date: { lt: now }
        },
        data: {
          status: PromotionStatus.EXPIRED,
        }
      });

      // Activer les promotions qui commencent maintenant
      const activatedPromotions = await this.prisma.promotion.updateMany({
        where: {
          status: PromotionStatus.DRAFT,
          start_date: { lte: now },
          expiration_date: { gt: now }
        },
        data: {
          status: PromotionStatus.ACTIVE,
        }
      });

      this.logger.log(
        `${expiredPromotions.count} promotions expirées, ${activatedPromotions.count} promotions activées`
      );
    } catch (error) {
      this.logger.error('Erreur lors de la mise à jour des promotions:', error);
    }
  }

  // Nettoie les données obsolètes une fois par semaine
  @Cron(CronExpression.EVERY_WEEK)
  async cleanupOldData() {
    this.logger.log('Nettoyage des données obsolètes...');
    
    try {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      // Supprimer les anciennes utilisations de promotions
      const deletedUsages = await this.prisma.promotionUsage.deleteMany({
        where: {
          created_at: { lt: threeMonthsAgo },
          promotion: {
            status: PromotionStatus.EXPIRED
          }
        }
      });

      this.logger.log(`${deletedUsages.count} anciennes utilisations de promotions supprimées`);
    } catch (error) {
      this.logger.error('Erreur lors du nettoyage:', error);
    }
  }
}