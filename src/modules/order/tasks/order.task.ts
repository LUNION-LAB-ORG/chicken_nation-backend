import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/database/services/prisma.service';
import { OrderService } from '../services/order.service';
import { OrderStatus, OrderType } from '@prisma/client';

@Injectable()
export class OrderTask {
  private readonly logger = new Logger(OrderTask.name);

  constructor(
    private orderService: OrderService,
    private prisma: PrismaService
  ) { }

  /**
   * Mettre en livraison toutes les commandes prêtes à livrer chaque minute
   * Mettre à collecté toutes les commandes en livraison chaque minute
   * Mettre en collecté toutes les commandes prêtes à emporter et à table chaque minute
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async updateOrders() {
    this.logger.log('Mise à jour des commandes...');

    try {
      // Mettre en livraison toutes les commandes prêtes à livrer chaque minute
      const ordersDelivery = await this.prisma.order.findMany({
        where: {
          status: OrderStatus.READY,
          type: OrderType.DELIVERY,
        },
      });
      for (const order of ordersDelivery) {
        await this.orderService.updateStatus(order.id, OrderStatus.PICKED_UP);
      }
      this.logger.log(`${ordersDelivery.length} commandes prêtes à livrer sont en livraison`);

      // Mettre à collecté toutes les commandes en livraison chaque minute
      const ordersArePickup = await this.prisma.order.findMany({
        where: {
          status: OrderStatus.PICKED_UP,
          type: OrderType.DELIVERY,
          updated_at: {
            gte: new Date(new Date().setMinutes(new Date().getMinutes() - 1)),
          },
        },
      });
      for (const order of ordersArePickup) {
        await this.orderService.updateStatus(order.id, OrderStatus.COLLECTED);
      }
      this.logger.log(`${ordersArePickup.length} commandes en livraison sont collectées`);

      // Mettre en collecté toutes les commandes prêtes à emporter et à table chaque minute
      const ordersOthers = await this.prisma.order.findMany({
        where: {
          status: OrderStatus.READY,
          type: { in: [OrderType.PICKUP, OrderType.TABLE] },
          updated_at: {
            lte: new Date(new Date().setMinutes(new Date().getMinutes() - 1)),
          },
        },
      });
      for (const order of ordersOthers) {
        await this.orderService.updateStatus(order.id, OrderStatus.COLLECTED);
      }
      this.logger.log(`${ordersOthers.length} commandes prêtes à emporter et à table sont collectées`);

    } catch (error) {
      this.logger.error('Erreur lors de l\'expiration des points:', error);
    }
  }
}