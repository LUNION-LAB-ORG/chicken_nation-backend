import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationSetting } from '../entities/notification-setting.entity';
import { UpdateNotificationSettingsDto } from '../dto/update-notification-settings.dto';

@Injectable()
export class NotificationSettingsService {
  private readonly logger = new Logger(NotificationSettingsService.name);

  constructor(
    @InjectRepository(NotificationSetting)
    private notificationSettingsRepository: Repository<NotificationSetting>,
  ) {}

  /**
   * Récupère les paramètres de notification d'un utilisateur
   * @param userId ID de l'utilisateur
   * @returns Les paramètres de notification
   */
  async getNotificationSettings(userId: string): Promise<NotificationSetting> {
    const settings = await this.notificationSettingsRepository.findOne({
      where: { userId },
    });

    if (!settings) {
      // Créer des paramètres par défaut si aucun n'existe
      return this.createDefaultSettings(userId);
    }

    return settings;
  }

  /**
   * Met à jour les paramètres de notification d'un utilisateur
   * @param userId ID de l'utilisateur
   * @param updateDto Données à mettre à jour
   * @returns Les paramètres mis à jour
   */
  async updateNotificationSettings(
    userId: string,
    updateDto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSetting> {
    let settings = await this.notificationSettingsRepository.findOne({
      where: { userId },
    });

    if (!settings) {
      settings = await this.createDefaultSettings(userId);
    }

    // Mettre à jour uniquement les champs fournis
    if (updateDto.emailPreferences) {
      settings.email_preferences = {
        ...settings.email_preferences,
        ...updateDto.emailPreferences,
      };
    }

    if (updateDto.pushPreferences) {
      settings.push_preferences = {
        ...settings.push_preferences,
        ...updateDto.pushPreferences,
      };
    }

    if (updateDto.smsPreferences) {
      settings.sms_preferences = {
        ...settings.sms_preferences,
        ...updateDto.smsPreferences,
      };
    }

    return this.notificationSettingsRepository.save(settings);
  }

  /**
   * Crée des paramètres de notification par défaut pour un utilisateur
   * @param userId ID de l'utilisateur
   * @returns Les paramètres créés
   */
  private async createDefaultSettings(userId: string): Promise<NotificationSetting> {
    const defaultSettings = this.notificationSettingsRepository.create({
      userId,
      email_preferences: {
        orderUpdates: true,
        promotions: true,
        newsletter: true,
      },
      push_preferences: {
        orderUpdates: true,
        promotions: true,
        specialOffers: false,
      },
      sms_preferences: {
        orderUpdates: false,
        promotions: false,
        newsletter: false,
      },
    });

    return this.notificationSettingsRepository.save(defaultSettings);
  }
}
