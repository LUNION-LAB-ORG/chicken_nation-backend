import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { BaseEmailService } from './base-email.service';
import { EmailTemplateService } from '../templates/email-template.service';
import { EmailComponentsService } from '../components/email.components.service';

@Injectable()
export class DefaultEmailService extends BaseEmailService {
  constructor(
    protected readonly configService: ConfigService,
    protected readonly emailTemplateService: EmailTemplateService,
    protected readonly emailComponentsService: EmailComponentsService) {
    super(configService, emailTemplateService, emailComponentsService);
  }

  protected getTransportOptions(): nodemailer.TransportOptions {
    const host = this.configService.get<string>('EMAIL_HOST');
    const port = Number(this.configService.get<number>('EMAIL_PORT'));

    return {
      host: host,
      port: port,
      secure: port === 465, // true pour port 465 (SSL), false pour port 587 (STARTTLS)
      auth: {
        user: this.configService.get<string>('EMAIL_USER'),
        pass: this.configService.get<string>('EMAIL_PASSWORD'),
      },
      // Configuration TLS pour Hostinger
      tls: {
        ciphers: 'SSLv3',
        rejectUnauthorized: false, // Pour éviter les erreurs de certificat
        servername: host
      },
      // Timeouts pour éviter les blocages
      connectionTimeout: 60000, // 60 secondes
      greetingTimeout: 30000,   // 30 secondes  
      socketTimeout: 75000,     // 75 secondes
      // Options de débogage (à activer temporairement)
      debug: process.env.NODE_ENV === 'development',
      logger: process.env.NODE_ENV === 'development',
      // Pool de connexions pour de meilleures performances
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      // Options SMTP supplémentaires
      requireTLS: true, // Force l'utilisation de TLS
      ignoreTLS: false,
    } as nodemailer.TransportOptions;
  }

  protected getFromEmail(): string {
    return this.configService.get<string>('EMAIL_SENDER') ?? "";
  }

  // Méthode pour tester la connexion SMTP
  async testConnection(): Promise<boolean> {
    try {
      const transport = this.getTransport();
      await transport.verify();
      console.log('✅ Connexion SMTP réussie');
      return true;
    } catch (error) {
      console.error('❌ Erreur connexion SMTP:', error.message);
      return false;
    }
  }
}