import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AdminNotificationService {
  private readonly logger = new Logger(AdminNotificationService.name);

  // constructor(
  //   @InjectRepository(Notification)
  //   private notificationsRepository: Repository<Notification>,
  //   private notificationsService: NotificationsService,
  //   private emailNotificationService: EmailNotificationService,
  //   private pushNotificationService: PushNotificationService,
  // ) {}

  // /**
  //  * Envoie une notification u00e0 plusieurs utilisateurs spu00e9cifiques
  //  * @param adminNotificationDto Les donnu00e9es de la notification u00e0 envoyer
  //  * @returns Un tableau des notifications cru00e9u00e9es
  //  */
  // async sendToUsers(adminNotificationDto: AdminNotificationToUsersDto): Promise<Notification[]> {
  //   const { userIds, ...notificationData } = adminNotificationDto;
  //   const notifications: Notification[] = [];

  //   // Cru00e9er une notification pour chaque utilisateur
  //   for (const userId of userIds) {
  //     try {
  //       const createNotificationDto: CreateNotificationDto = {
  //         userId,
  //         ...notificationData,
  //         date: new Date(),
  //         time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  //         isRead: false,
  //         notifBanner: notificationData.notifBanner || 'default-banner',
  //         notifTitle: notificationData.notifTitle || notificationData.title,
  //       };

  //       const notification = await this.notificationsService.create(createNotificationDto);
  //       notifications.push(notification);

  //       this.logger.log(`Notification cru00e9u00e9e pour l'utilisateur ${userId}`);
  //     } catch (error) {
  //       this.logger.error(
  //         `Erreur lors de la cru00e9ation de la notification pour l'utilisateur ${userId}: ${error.message}`,
  //         error.stack,
  //       );
  //     }
  //   }

  //   return notifications;
  // }

  // /**
  //  * Diffuse une notification u00e0 tous les utilisateurs
  //  * @param broadcastDto Les donnu00e9es de la notification u00e0 diffuser
  //  * @returns Le nombre de notifications cru00e9u00e9es
  //  */
  // async broadcast(broadcastDto: AdminBroadcastNotificationDto): Promise<{ count: number }> {
  //   // Dans un environnement de production, vous ru00e9cupu00e9reriez tous les utilisateurs depuis la base de donnu00e9es
  //   // Pour cette du00e9monstration, nous allons simuler l'envoi u00e0 tous les utilisateurs
    
  //   this.logger.log(`Diffusion d'une notification de type ${broadcastDto.type} u00e0 tous les utilisateurs`);
    
  //   // Enregistrer la notification comme une notification systu00e8me
  //   // Dans un environnement ru00e9el, vous utiliseriez un job en arriu00e8re-plan pour envoyer u00e0 tous les utilisateurs
    
  //   // Simuler l'envoi u00e0 10 utilisateurs pour la du00e9monstration
  //   const simulatedUserIds = Array.from({ length: 10 }, (_, i) => 
  //     `simulated-user-${i + 1}`);
    
  //   let successCount = 0;
    
  //   for (const userId of simulatedUserIds) {
  //     try {
  //       const createNotificationDto: CreateNotificationDto = {
  //         userId,
  //         icon: broadcastDto.icon,
  //         iconBgColor: broadcastDto.iconBgColor,
  //         title: broadcastDto.title,
  //         date: new Date(),
  //         time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  //         message: broadcastDto.message,
  //         type: broadcastDto.type,
  //         isRead: false,
  //         notifBanner: broadcastDto.notifBanner || 'default-banner',
  //         notifTitle: broadcastDto.notifTitle || broadcastDto.title,
  //         showChevron: broadcastDto.showChevron !== undefined ? broadcastDto.showChevron : true,
  //         data: broadcastDto.data || {},
  //       };
        
  //       await this.notificationsService.create(createNotificationDto);
  //       successCount++;
        
  //       // Si demande, envoyer egalement par email
  //       if (broadcastDto.sendEmail) {
  //         // Simuler l'envoi d'un email u00e0 l'utilisateur
  //         // Dans un environnement ru00e9el, vous ru00e9cupu00e9reriez l'email de l'utilisateur depuis la base de donnu00e9es
  //         const simulatedEmail = `user-${userId}@example.com`;
  //         await this.emailNotificationService.sendNotificationEmail(
  //           createNotificationDto as unknown as Notification,
  //           simulatedEmail,
  //         );
  //       }
        
  //       // Si demandu00e9, envoyer u00e9galement par notification push
  //       if (broadcastDto.sendPush) {
  //         // Simuler l'envoi d'une notification push u00e0 l'utilisateur
  //         // Dans un environnement ru00e9el, vous ru00e9cupu00e9reriez le token du dispositif de l'utilisateur
  //         const simulatedDeviceToken = `device-token-${userId}`;
  //         await this.pushNotificationService.sendPushNotification(
  //           createNotificationDto as unknown as Notification,
  //           simulatedDeviceToken,
  //         );
  //       }
  //     } catch (error) {
  //       this.logger.error(
  //         `Erreur lors de la diffusion de la notification u00e0 l'utilisateur ${userId}: ${error.message}`,
  //         error.stack,
  //       );
  //     }
  //   }
    
  //   return { count: successCount };
  // }
  
  // /**
  //  * Supprime toutes les notifications d'un certain type plus anciennes qu'une date donnu00e9e
  //  * @param type Type de notification u00e0 supprimer
  //  * @param olderThan Date avant laquelle supprimer les notifications (par du00e9faut: 30 jours)
  //  * @returns Le nombre de notifications supprimu00e9es
  //  */
  // async cleanupOldNotifications(
  //   type: string,
  //   olderThan: Date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  // ): Promise<{ count: number }> {
  //   try {
  //     const result = await this.notificationsRepository.delete({
  //       type: type as any,
  //       createdAt: olderThan,
  //     });
      
  //     this.logger.log(`${result.affected} notifications de type ${type} plus anciennes que ${olderThan.toISOString()} ont u00e9tu00e9 supprimu00e9es`);
      
  //     return { count: result.affected || 0 };
  //   } catch (error) {
  //     this.logger.error(
  //       `Erreur lors du nettoyage des anciennes notifications: ${error.message}`,
  //       error.stack,
  //     );
  //     return { count: 0 };
  //   }
  // }
}
