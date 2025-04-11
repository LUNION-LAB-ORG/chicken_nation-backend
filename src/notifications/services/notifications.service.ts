import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from 'src/notifications/entities/notification.entity';
import { NotificationPreference } from 'src/notifications/entities/notification-preference.entity';
import { CreateNotificationDto } from 'src/notifications/dto/create-notification.dto';
import { UpdateNotificationStatusDto } from 'src/notifications/dto/update-notification-status.dto';
import { NotificationType } from 'src/notifications/enums/notification.enum';
import { UpdateNotificationPreferenceDto } from '../dto/notification-preference.dto';

@Injectable()
export class NotificationsService {
  // constructor(
  //   @InjectRepository(Notification)
  //   private notificationsRepository: Repository<Notification>,
  //   @InjectRepository(NotificationPreference)
  //   private preferencesRepository: Repository<NotificationPreference>,
  // ) {}

  // /**
  //  * Crée une nouvelle notification
  //  * @param createNotificationDto Les données de la notification à créer
  //  * @returns La notification créée
  //  */
  // async create(createNotificationDto: CreateNotificationDto): Promise<Notification> {
  //   const notification = this.notificationsRepository.create(createNotificationDto);
  //   return this.notificationsRepository.save(notification);
  // }

  // /**
  //  * Récupère toutes les notifications
  //  * @returns Liste de toutes les notifications
  //  */
  // async findAll(): Promise<Notification[]> {
  //   return this.notificationsRepository.find();
  // }

  // /**
  //  * Récupère les notifications d'un utilisateur
  //  * @param userId ID de l'utilisateur
  //  * @returns Liste des notifications de l'utilisateur
  //  */
  // async findByUserId(userId: string): Promise<Notification[]> {
  //   return this.notificationsRepository.find({
  //     where: { userId },
  //     order: { createdAt: 'DESC' },
  //   });
  // }

  // /**
  //  * Récupère une notification par son ID
  //  * @param id ID de la notification
  //  * @returns La notification trouvée
  //  */
  // async findOne(id: string): Promise<Notification> {
  //   const notification = await this.notificationsRepository.findOne({
  //     where: { id },
  //   });

  //   if (!notification) {
  //     throw new NotFoundException(`Notification with ID ${id} not found`);
  //   }

  //   return notification;
  // }

  // /**
  //  * Marque une notification comme lue
  //  * @param id ID de la notification
  //  * @returns La notification mise à jour
  //  */
  // async markAsRead(id: string): Promise<Notification> {
  //   const notification = await this.findOne(id);
  //   notification.isRead = true;
  //   return this.notificationsRepository.save(notification);
  // }

  // /**
  //  * Marque toutes les notifications d'un utilisateur comme lues
  //  * @param userId ID de l'utilisateur
  //  * @returns Nombre de notifications mises à jour
  //  */
  // async markAllAsRead(userId: string): Promise<number> {
  //   const result = await this.notificationsRepository.update(
  //     { userId, isRead: false },
  //     { isRead: true },
  //   );
  //   return result.affected || 0;
  // }

  // /**
  //  * Supprime une notification
  //  * @param id ID de la notification
  //  * @returns true si la suppression a réussi
  //  */
  // async remove(id: string): Promise<boolean> {
  //   const result = await this.notificationsRepository.delete(id);
  //   // return result.affected > 0;
  //   return true;
  // }

  // /**
  //  * Récupère les préférences de notification d'un utilisateur
  //  * @param userId ID de l'utilisateur
  //  * @returns Les préférences de notification de l'utilisateur
  //  */
  // async getPreferences(userId: string): Promise<NotificationPreference> {
  //   const preferences = await this.preferencesRepository.findOne({
  //     // where: { userId },
  //   });

  //   if (!preferences) {
  //     // Créer des préférences par défaut si elles n'existent pas
  //     return this.createDefaultPreferences(userId);
  //   }

  //   return preferences;
  // }

  // /**
  //  * Met à jour les préférences de notification d'un utilisateur
  //  * @param userId ID de l'utilisateur
  //  * @param updateDto Données de mise à jour des préférences
  //  * @returns Les préférences mises à jour
  //  */
  // async updatePreferences(
  //   userId: string,
  //   updateDto: UpdateNotificationPreferenceDto,
  // ): Promise<NotificationPreference> {
  //   let preferences = await this.preferencesRepository.findOne({
  //     // where: { userId },
  //   });

  //   if (!preferences) {
  //     preferences = await this.createDefaultPreferences(userId);
  //   }

  //   // Mettre à jour uniquement les champs fournis
  //   if (updateDto.orderUpdates !== undefined) {
  //     preferences.orderUpdates = {
  //       ...preferences.orderUpdates,
  //       ...updateDto.orderUpdates,
  //     };
  //   }

  //   if (updateDto.promotions !== undefined) {
  //     preferences.promotions = {
  //       ...preferences.promotions,
  //       ...updateDto.promotions,
  //     };
  //   }

  //   if (updateDto.newsletter !== undefined) {
  //     preferences.newsletter = {
  //       ...preferences.newsletter,
  //       ...updateDto.newsletter,
  //     };
  //   }

  //   if (updateDto.pushNotifications !== undefined) {
  //     preferences.pushNotifications = {
  //       ...preferences.pushNotifications,
  //       ...updateDto.pushNotifications,
  //     };
  //   }

  //   return this.preferencesRepository.save(preferences);
  // }

  // /**
  //  * Crée des préférences de notification par défaut pour un utilisateur
  //  * @param userId ID de l'utilisateur
  //  * @returns Les préférences créées
  //  */
  // private async createDefaultPreferences(
  //   userId: string,
  // ): Promise<NotificationPreference> {
  //   const defaultPreferences = this.preferencesRepository.create({
  //     // userId,
  //     orderUpdates: {
  //       email: true,
  //       push: true,
  //     },
  //     promotions: {
  //       email: true,
  //       push: false,
  //     },
  //     newsletter: {
  //       email: true,
  //       push: false,
  //     },
  //     pushNotifications: {
  //       enabled: true,
  //       quietHours: {
  //         start: null,
  //         end: null,
  //       },
  //     },
  //   });

  //   return this.preferencesRepository.save(defaultPreferences);
  // }

  // /**
  //  * Vérifie si un utilisateur doit recevoir une notification
  //  * @param userId ID de l'utilisateur
  //  * @param type Type de notification
  //  * @param channel Canal de notification (email, push, inApp)
  //  * @returns true si l'utilisateur doit recevoir la notification
  //  */
  // async shouldSendNotification(
  //   userId: string,
  //   type: NotificationType,
  //   channel: 'email' | 'push' | 'inApp',
  // ): Promise<boolean> {
  //   const preferences = await this.getPreferences(userId);
    
  //   // Vérifier si le type de notification correspond à une catégorie spécifique
  //   let categoryPreferences: Record<string, any> | null = null;
    
  //   if (type === NotificationType.ORDER) {
  //     categoryPreferences = preferences.orderUpdates;
  //   } else if (type === NotificationType.PAYMENT) {
  //     // Les notifications de paiement peuvent être considérées comme des mises à jour de commande
  //     categoryPreferences = preferences.orderUpdates;
  //   } else if (type === NotificationType.PROMO) {
  //     categoryPreferences = preferences.promotions;
  //   }
    
  //   // Si nous n'avons pas de préférences spécifiques pour ce type, utiliser les paramètres généraux
  //   if (!categoryPreferences) {
  //     // Fallback sur les préférences générales
  //     if (channel === 'push') {
  //       return preferences.pushNotifications?.enabled === true;
  //     }
  //     // Pour les autres canaux, autoriser par défaut
  //     return true;
  //   }
    
  //   // Vérifier les préférences spécifiques au canal pour cette catégorie
  //   return categoryPreferences[channel] === true;
  // }

  // /**
  //  * Vérifie si l'heure actuelle est dans les heures de silence pour un utilisateur
  //  * @param userId ID de l'utilisateur
  //  * @returns true si l'heure actuelle est dans les heures de silence
  //  */
  // async isInQuietHours(userId: string): Promise<boolean> {
  //   const preferences = await this.getPreferences(userId);
  //   const quietHours = preferences.pushNotifications?.quietHours;
    
  //   if (!quietHours || !quietHours.start || !quietHours.end) {
  //     return false;
  //   }
    
  //   const now = new Date();
  //   const currentHour = now.getHours();
  //   const currentMinute = now.getMinutes();
    
  //   // Convertir les heures de silence en nombres pour la comparaison
  //   const [startHour, startMinute] = quietHours.start.split(':').map(Number);
  //   const [endHour, endMinute] = quietHours.end.split(':').map(Number);
    
  //   const currentTime = currentHour * 60 + currentMinute;
  //   const startTime = startHour * 60 + startMinute;
  //   const endTime = endHour * 60 + endMinute;
    
  //   // Gérer le cas où les heures de silence s'étendent sur deux jours
  //   if (startTime > endTime) {
  //     return currentTime >= startTime || currentTime <= endTime;
  //   }
    
  //   return currentTime >= startTime && currentTime <= endTime;
  // }

  // /**
  //  * Compte les notifications non lues d'un utilisateur
  //  * @param userId ID de l'utilisateur
  //  * @returns Nombre de notifications non lues
  //  */
  // async countUnread(userId: string): Promise<number> {
  //   return this.notificationsRepository.count({
  //     where: { userId, isRead: false },
  //   });
  // }

  // /**
  //  * Met à jour le statut de lecture d'une notification
  //  * @param id ID de la notification
  //  * @param updateStatusDto Données de mise à jour du statut
  //  * @returns La notification mise à jour
  //  */
  // async updateStatus(id: string, updateStatusDto: UpdateNotificationStatusDto): Promise<Notification> {
  //   const notification = await this.findOne(id);
    
  //   // Mettre à jour le statut de lecture
  //   notification.isRead = updateStatusDto.isRead;
    
  //   return this.notificationsRepository.save(notification);
  // }
}
