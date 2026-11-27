import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { commandesANoterWhere } from 'src/modules/order/helpers/commande-a-noter.rules';

@Injectable()
export class AppMobileService {

  constructor(
    private prisma: PrismaService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Commandes que l'appli propose de noter (27/11) : terminées, ni annulées
   * ni supprimées, sans note. La règle vit dans `commande-a-noter.rules.ts`,
   * et sert aussi au dépôt de la note.
   */
  async getOrderToComment(customer_id: string) {
    return this.prisma.order.findMany({
      where: commandesANoterWhere(customer_id),
      orderBy: { created_at: 'desc' },
      take: 10,
    });
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