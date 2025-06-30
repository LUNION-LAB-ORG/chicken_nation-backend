import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { BaseEmailService } from './base-email.service';
import { EmailTemplateService } from '../templates/email-template.service';
import { EmailComponentsService } from '../components/email.components.service';

@Injectable()
export class GoogleEmailService extends BaseEmailService {
  constructor(
    protected readonly configService: ConfigService,
    protected readonly emailTemplateService: EmailTemplateService,
    protected readonly emailComponentsService: EmailComponentsService) {
    super(configService, emailTemplateService, emailComponentsService);
  }

  protected getTransportOptions(): nodemailer.TransportOptions {
    return {
      host: this.configService.get<string>('GOOGLE_EMAIL_HOST'),
      port: Number(this.configService.get<number>('GOOGLE_EMAIL_PORT')),
      secure: false,
      auth: {
        user: this.configService.get<string>('GOOGLE_EMAIL_USER'),
        pass: this.configService.get<string>('GOOGLE_EMAIL_PASSWORD'),
      },
    } as nodemailer.TransportOptions;
  }

  protected getFromEmail(): string {
    return this.configService.get<string>('GOOGLE_EMAIL_SENDER') ?? "";
  }
}