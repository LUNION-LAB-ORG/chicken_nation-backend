import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';

@Injectable()
export class AppMobileService {

  constructor(
    private prisma: PrismaService,
    private readonly settingsService: SettingsService,
  ) {}

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
    const config = await this.settingsService.getManyOrEnv({
      version_app_mobile: 'VERSION_APP_MOBILE',
      play_store_link: 'PLAY_STORE_LINK',
      app_store_link: 'APP_STORE_LINK',
      force_update_app_mobile: 'FORCE_UPDATE_APP_MOBILE',
    });

    return {
      minVersion: config.version_app_mobile || '1.0.0',
      title: 'Mise à jour disponible',
      message: 'Une nouvelle version est disponible pour améliorer votre expérience.',
      storeUrlIOS: config.app_store_link || '',
      storeUrlAndroid: config.play_store_link || '',
      forceUpdate: config.force_update_app_mobile === 'true',
    };
  }
}