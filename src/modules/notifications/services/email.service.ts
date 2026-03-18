import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { SettingsService } from 'src/modules/settings/settings.service';

interface SendMailOptions {
  to: string[];
  subject: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType?: string;
  }>;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Crée un transporter Nodemailer à chaque envoi,
   * en lisant la config depuis Settings (DB) avec fallback sur .env.
   */
  private async createTransporter(): Promise<nodemailer.Transporter> {
    const config = await this.settingsService.getManyOrEnv({
      email_provider: 'EMAIL_PROVIDER',
      email_host: 'EMAIL_HOST',
      email_port: 'EMAIL_PORT',
      email_user: 'EMAIL_USER',
      email_password: 'EMAIL_PASSWORD',
      google_email_host: 'GOOGLE_EMAIL_HOST',
      google_email_port: 'GOOGLE_EMAIL_PORT',
      google_email_user: 'GOOGLE_EMAIL_USER',
      google_email_password: 'GOOGLE_EMAIL_PASSWORD',
    });

    const provider = config.email_provider || 'default';
    const isGoogle = provider === 'google';

    const host = isGoogle
      ? (config.google_email_host || 'smtp.gmail.com')
      : (config.email_host || 'smtp.hostinger.com');

    const port = parseInt(
      isGoogle
        ? (config.google_email_port || '587')
        : (config.email_port || '465'),
      10,
    );

    const user = isGoogle ? config.google_email_user : config.email_user;
    const pass = isGoogle ? config.google_email_password : config.email_password;

    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }

  async sendMail(options: SendMailOptions): Promise<void> {
    const config = await this.settingsService.getManyOrEnv({
      email_provider: 'EMAIL_PROVIDER',
      email_sender: 'EMAIL_SENDER',
      google_email_sender: 'GOOGLE_EMAIL_SENDER',
    });

    const provider = config.email_provider || 'default';
    const from = provider === 'google'
      ? (config.google_email_sender || 'Chicken Nation <andersonkouadio0118@gmail.com>')
      : (config.email_sender || 'Chicken Nation <info@chicken-nation.com>');

    try {
      const transporter = await this.createTransporter();
      const info = await transporter.sendMail({
        from,
        to: options.to.join(', '),
        subject: options.subject,
        html: options.html,
        attachments: options.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType || 'application/pdf',
        })),
      });

      this.logger.log(`Email envoyé avec succès: ${info.messageId} → ${options.to.join(', ')}`);
    } catch (error) {
      this.logger.error(`Erreur d'envoi email à ${options.to.join(', ')}: ${error.message}`);
      throw error;
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      const transporter = await this.createTransporter();
      await transporter.verify();
      this.logger.log('Connexion SMTP vérifiée avec succès');
      return true;
    } catch (error) {
      this.logger.error(`Connexion SMTP échouée: ${error.message}`);
      return false;
    }
  }
}
