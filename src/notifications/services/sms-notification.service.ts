import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Notification } from 'src/notifications/entities/notification.entity';

@Injectable()
export class SmsNotificationService {
  private readonly logger = new Logger(SmsNotificationService.name);

  constructor(private configService: ConfigService) {}

  /**
   * Envoie une notification par SMS
   * @param notification La notification à envoyer
   * @param phoneNumber Le numéro de téléphone du destinataire
   */
  async sendNotificationSms(notification: Notification, phoneNumber: string): Promise<boolean> {
    try {
      // Ici, nous simulons l'envoi d'un SMS
      // Dans un environnement de production, vous intégreriez un service SMS réel
      // comme Twilio, Nexmo, AWS SNS, etc.
      
      this.logger.log(
        `Envoi d'un SMS au numéro ${phoneNumber} - Message: ${this.formatSmsContent(notification)}`,
      );
      
      // Simuler un délai d'envoi de SMS
      await new Promise(resolve => setTimeout(resolve, 100));
      
      return true;
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi du SMS au numéro ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Formate le contenu d'une notification pour l'envoi par SMS
   * @param notification La notification à formater
   */
  private formatSmsContent(notification: Notification): string {
    // Les SMS ont généralement une limite de caractères, nous devons donc être concis
    let content = `${notification.title}: ${notification.message}`;
    
    // Ajouter un lien si disponible dans les données
    if (notification.data?.link) {
      const baseUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
      content += ` - Plus d'infos: ${baseUrl}${notification.data.link}`;
    }
    
    // Limiter à 160 caractères (limite standard des SMS)
    if (content.length > 160) {
      content = content.substring(0, 157) + '...';
    }
    
    return content;
  }
}
