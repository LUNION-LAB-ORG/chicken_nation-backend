import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class OrderPrune {
  private readonly logger = new Logger(OrderPrune.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Supprimer les commandes abandonnées chaque jour à 3h du matin
   * Les commandes en attente depuis plus de 24 heures seront supprimées
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async deleteAbandonedOrder() {
    this.logger.debug('Suppression des commandes abandonnées...');

    try {
      // Supprimer les commandes en attente depuis plus de 24 heures
      const result = await this.prisma.order.deleteMany({
        where: {
          status: OrderStatus.PENDING,
          created_at: {
            lte: new Date(new Date().setDate(new Date().getDate() - 1)),
          },
        },
      });
      this.logger.log(`${result.count} commandes abandonnées supprimées`);
    } catch (error) {
      this.logger.error(
        'Erreur lors de la suppression des commandes abandonnées',
        error,
      );
    }
  }
}
