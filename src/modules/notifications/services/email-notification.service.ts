import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);

  constructor(private configService: ConfigService) {}

  // /**
  //  * Envoie une notification par email
  //  * @param notification La notification à envoyer
  //  * @param email L'adresse email du destinataire
  //  */
  // async sendNotificationEmail(notification: Notification, email: string): Promise<boolean> {
  //   try {
  //     // Ici, nous simulons l'envoi d'un email
  //     // Dans un environnement de production, vous intégreriez un service d'email réel
  //     // comme SendGrid, Mailgun, AWS SES, etc.
      
  //     this.logger.log(
  //       `Envoi d'un email à ${email} - Sujet: ${notification.title} - Message: ${notification.message}`,
  //     );
      
  //     // Simuler un délai d'envoi d'email
  //     await new Promise(resolve => setTimeout(resolve, 100));
      
  //     return true;
  //   } catch (error) {
  //     this.logger.error(
  //       `Erreur lors de l'envoi de l'email à ${email}: ${error.message}`,
  //       error.stack,
  //     );
  //     return false;
  //   }
  // }

  // /**
  //  * Construit le contenu HTML d'un email de notification
  //  * @param notification La notification à formater en HTML
  //  */
  // private buildEmailHtml(notification: Notification): string {
  //   const baseUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
  //   const actionUrl = notification.data?.link ? `${baseUrl}${notification.data.link}` : baseUrl;
    
  //   return `
  //     <!DOCTYPE html>
  //     <html>
  //     <head>
  //       <meta charset="utf-8">
  //       <meta name="viewport" content="width=device-width, initial-scale=1.0">
  //       <title>${notification.title}</title>
  //       <style>
  //         body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
  //         .container { max-width: 600px; margin: 0 auto; padding: 20px; }
  //         .header { background-color: #f8f9fa; padding: 20px; text-align: center; }
  //         .content { padding: 20px; }
  //         .footer { font-size: 12px; color: #777; text-align: center; margin-top: 20px; }
  //         .button { display: inline-block; background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; }
  //       </style>
  //     </head>
  //     <body>
  //       <div class="container">
  //         <div class="header">
  //           <h2>${notification.title}</h2>
  //         </div>
  //         <div class="content">
  //           <p>${notification.message}</p>
  //           ${notification.data?.link ? `<p><a href="${actionUrl}" class="button">Voir les détails</a></p>` : ''}
  //         </div>
  //         <div class="footer">
  //           <p>Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
  //         </div>
  //       </div>
  //     </body>
  //     </html>
  //   `;
  // }
}
