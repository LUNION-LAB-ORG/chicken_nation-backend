import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { sendEmailDto } from '../dto/sendEmailDto';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class EmailService {
  constructor(private readonly configService: ConfigService) { }
  getTransport() {
    const options = {
      host: this.configService.get<string>('EMAIL_HOST'),
      port: Number(this.configService.get<number>('EMAIL_PORT')),
      secure: false,
      auth: {
        user: this.configService.get<string>('EMAIL_USER'),
        pass: this.configService.get<string>('EMAIL_PASSWORD'),
      },
    };

    const transport = nodemailer.createTransport(options);
    return transport;
  }

  async sendEmail(dto: sendEmailDto) {
    const { recipients, subject, html, text } = dto;

    const transport = this.getTransport();

    let htmlContent = '';
    try {
      const projectRoot = path.resolve(__dirname, '../../..');
      const htmlFilePath = path.join(
        projectRoot,
        'email_templates/newsletter.html',
      );

      console.log('Tentative de lecture du fichier HTML à:', htmlFilePath);

      // Vérifier si le fichier existe avant de le lire
      if (fs.existsSync(htmlFilePath)) {
        htmlContent = fs.readFileSync(htmlFilePath, 'utf8');
      } else {
        throw new Error(`Le fichier HTML n'existe pas à: ${htmlFilePath}`);
      }
    } catch (error) {
      console.error('Erreur lors de la lecture du fichier HTML:', error);
      throw error;
    }

    const options: nodemailer.SendMailOptions = {
      from: this.configService.get<string>('EMAIL_USER'),
      to: recipients,
      subject: subject,
      html: htmlContent,
      text: text,
    };

    await transport.sendMail(options);
  }
}
