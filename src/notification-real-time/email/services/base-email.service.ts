import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { sendEmailDto } from '../dto/sendEmailDto';
import { IEmailService } from '../interfaces/email-service.interface';

@Injectable()
export abstract class BaseEmailService implements IEmailService {
    constructor(protected readonly configService: ConfigService) { }

    protected abstract getTransportOptions(): nodemailer.TransportOptions;

    protected getTransport() {
        const options = this.getTransportOptions();
        return nodemailer.createTransport(options);
    }

    async sendEmail(dto: sendEmailDto): Promise<void> {
        const { recipients, subject, html, text } = dto;

        const transport = this.getTransport();

        const mailOptions: nodemailer.SendMailOptions = {
            from: this.getFromEmail(),
            to: recipients,
            subject: subject,
            html: html,
            text: text,
        };

        await transport.sendMail(mailOptions);
    }

    protected abstract getFromEmail(): string;
}