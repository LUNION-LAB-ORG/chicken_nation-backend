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
    
  }
}