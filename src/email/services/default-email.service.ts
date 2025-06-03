import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { BaseEmailService } from './base-email.service';

@Injectable()
export class DefaultEmailService extends BaseEmailService {
  constructor(protected readonly configService: ConfigService) {
    super(configService);
  }

  protected getTransportOptions(): nodemailer.TransportOptions {
    return {
      host: this.configService.get<string>('EMAIL_HOST'),
      port: Number(this.configService.get<number>('EMAIL_PORT')),
      secure: false,
      auth: {
        user: this.configService.get<string>('EMAIL_USER'),
        pass: this.configService.get<string>('EMAIL_PASSWORD'),
      },
    } as nodemailer.TransportOptions;
  }

  protected getFromEmail(): string {
    return this.configService.get<string>('EMAIL_SENDER') ?? "";
  }
}
