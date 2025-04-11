import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Notification } from 'src/notifications/entities/notification.entity';

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);

  constructor(private configService: ConfigService) {}

  // /**
  //  * Envoie une notification push à un utilisateur
  //  * @param notification La notification à envoyer
  //  * @param deviceToken Le token du dispositif de l'utilisateur
  //  */
  // async sendPushNotification(notification: Notification, deviceToken: string): Promise<boolean> {
  //   try {
  //     // Ici, nous simulons l'envoi d'une notification push
  //     // Dans un environnement de production, vous intégreriez un service comme
  //     // Firebase Cloud Messaging, OneSignal, etc.
      
  //     this.logger.log(
  //       `Envoi d'une notification push au dispositif ${deviceToken} - Titre: ${notification.title}`,
  //     );
      
  //     // Simuler un délai d'envoi de notification push
  //     await new Promise(resolve => setTimeout(resolve, 100));
      
  //     return true;
  //   } catch (error) {
  //     this.logger.error(
  //       `Erreur lors de l'envoi de la notification push au dispositif ${deviceToken}: ${error.message}`,
  //       error.stack,
  //     );
  //     return false;
  //   }
  // }

  // /**
  //  * Construit le payload pour la notification push
  //  * @param notification La notification à formater
  //  */
  // private buildPushPayload(notification: Notification): Record<string, any> {
  //   return {
  //     notification: {
  //       title: notification.title,
  //       body: notification.message,
  //       icon: notification.icon || 'default', // Utiliser l'icône de la notification ou une icône par défaut
  //       click_action: '/', // Action par défaut, rediriger vers la page d'accueil
  //     },
  //     data: {
  //       notificationId: notification.id,
  //       type: notification.type,
  //     },
  //   };
  // }
}
