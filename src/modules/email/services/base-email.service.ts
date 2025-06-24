import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { sendEmailDto } from '../dto/sendEmailDto';
import { IEmailService } from '../interfaces/email-service.interface';
import { EmailContext, EmailTemplate } from '../interfaces/email-template.interface';
import { EmailTemplateService } from '../templates/email-template.service';
import { EmailComponentsService } from '../components/email.components.service';

@Injectable()
export abstract class BaseEmailService implements IEmailService {

    private CHICKEN_NATION_LOGO: string;
    private CHICKEN_NATION_NAME: string;
    private CHICKEN_NATION_DESCRIPTION: string;
    private CHICKEN_NATION_SUPPORT: string;
    private CHICKEN_NATION_UNSUBSCRIBE_URL: string;
    private CHICKEN_NATION_URL: string;
    private CHICKEN_NATION_SOCIAL_LINKS: { icon: string, url: string }[];

    constructor(
        protected readonly configService: ConfigService,
        protected readonly emailTemplateService: EmailTemplateService,
        protected readonly emailComponentsService: EmailComponentsService
    ) {
        this.CHICKEN_NATION_LOGO = this.configService.get<string>('CHICKEN_NATION_LOGO') ?? ""
        this.CHICKEN_NATION_NAME = this.configService.get<string>('CHICKEN_NATION_NAME') ?? ""
        this.CHICKEN_NATION_DESCRIPTION = this.configService.get<string>('CHICKEN_NATION_DESCRIPTION') ?? ""
        this.CHICKEN_NATION_SUPPORT = this.configService.get<string>('CHICKEN_NATION_SUPPORT') ?? ""
        this.CHICKEN_NATION_UNSUBSCRIBE_URL = this.configService.get<string>('CHICKEN_NATION_SUPPORT') ?? ""
        this.CHICKEN_NATION_URL = this.configService.get<string>('CHICKEN_NATION_URL') ?? ""
        this.CHICKEN_NATION_SOCIAL_LINKS = this.configService.get<string>('CHICKEN_NATION_SOCIAL_LINKS')?.split("+").flatMap((link) => {
            const item = link.split(",")
            return ({ icon: item[0], url: item[1] })
        }) ?? []
    }

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

    /**
    * Envoie une notification à plusieurs destinataires avec un template
    */
    async sendEmailTemplate<T>(
        template: EmailTemplate<T>,
        context: EmailContext<T>,
    ) {
        await this.sendEmail({
            recipients: context.recipients,
            subject: template.subject(context),
            html: this.emailTemplateService.generateEmailTemplate({
                content: template.content(context),
                header: this.emailComponentsService.Header(this.CHICKEN_NATION_LOGO, this.CHICKEN_NATION_NAME, this.CHICKEN_NATION_DESCRIPTION),
                footer: this.emailComponentsService.Footer(
                    this.CHICKEN_NATION_NAME, // Nom de votre entreprise
                    this.CHICKEN_NATION_DESCRIPTION, // Description de votre entreprise
                    this.CHICKEN_NATION_SUPPORT, // Email de support
                    this.CHICKEN_NATION_UNSUBSCRIBE_URL, // URL de désabonnement
                    this.CHICKEN_NATION_URL, // URL de votre site web
                    this.emailComponentsService.SocialLinks(this.CHICKEN_NATION_SOCIAL_LINKS)
                )
            }),
        });
    }

    protected abstract getFromEmail(): string;
}