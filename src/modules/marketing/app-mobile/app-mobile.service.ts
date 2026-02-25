import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';

@Injectable()
export class AppMobileService {
  private readonly minVersion: string;
  private readonly playstore_link: string;
  private readonly apptore_link: string;
  private readonly forceUpdate: boolean;

  constructor(private prisma: PrismaService, private configService: ConfigService) {
    this.minVersion = this.configService.get<string>('VERSION_APP_MOBILE', "1.0.0");
    this.playstore_link = this.configService.get<string>('PLAY_STORE_LINK', "1.0.0");
    this.apptore_link = this.configService.get<string>('APP_STORE_LINK', "1.0.0");
    this.forceUpdate = this.configService.get<string>('FORCE_UPDATE_APP_MOBILE') === "true"
  }

  /**
   * Get orders to comment
   * @param customer_id 
   * @returns 
   */
  async getOrderToComment(customer_id: string) {
    // 1. Calculer l'heure qu'il était il y a exactement 30 minutes
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

    const orders = await this.prisma.order.findMany({
      where: {
        status: {
          in: [OrderStatus.COMPLETED, OrderStatus.COLLECTED]
        },
        customer_id: customer_id,

        // La commande ne doit pas avoir de commentaire
        Comment: {
          none: {},
        },

        // 2. La commande doit avoir été terminée OU collectée il y a plus de 30 minutes
        OR: [
          { completed_at: { lte: thirtyMinutesAgo } },
          { collected_at: { lte: thirtyMinutesAgo } }
        ]
      },
      orderBy: {
        created_at: 'desc'
      },
      take: 10,
    });

    return orders;
  }

  /**
   * Get mobile version
   * @returns 
   */
  async getMobileVersion() {
    return {
      minVersion: this.minVersion,
      title: 'Mise à jour disponible',
      message: 'Une nouvelle version est disponible pour améliorer votre expérience.',
      // Remplace par l'ID de ton app Apple
      storeUrlIOS: this.apptore_link,
      // Remplace par ton package name Android
      storeUrlAndroid: this.playstore_link,
      forceUpdate: this.forceUpdate,
    };
  }
}