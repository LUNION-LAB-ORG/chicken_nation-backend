import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Customer } from "@prisma/client";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";

@Injectable()
export class CustomerEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService,
        private readonly configService: ConfigService) { }

    /**
      * BIENVENUE CLIENT (lorsqu’un nouveau client s’inscrit)
      */
    WELCOME_CUSTOMER: EmailTemplate<{
        customer: Customer,
    }> = {
            subject: (ctx) => `🎉 Bienvenue chez Chicken Nation, ${ctx.data.customer.first_name ?? ''} !`,
            content: (ctx) => {
                const fullname = `${ctx.data.customer.first_name ?? ''} ${ctx.data.customer.last_name ?? ''}`.trim();

                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Bienvenue à Chicken Nation !`,
                        `Nous sommes ravis de vous accueillir, ${fullname || ctx.data.customer.phone} 🎊`
                    ),
                    this.emailComponentsService.Message(
                        `Votre compte a bien été créé avec le numéro ${ctx.data.customer.phone}. 
                 Vous pouvez dès maintenant parcourir notre menu, passer des commandes et profiter de notre programme de fidélité.`
                    ),
                    this.emailComponentsService.ToastNotification(
                        `N'oubliez pas : chaque commande vous rapporte des points fidélité !`,
                        'info'
                    ),
                    this.emailComponentsService.Divider(),
                    this.emailComponentsService.Message(
                        `Besoin d'aide ? Notre équipe de support est à votre disposition à tout moment.`
                    ),
                    this.emailComponentsService.Button(
                        'Contacter le support',
                        this.configService.get<string>('CHICKEN_NATION_SUPPORT')
                            ? `mailto:${this.configService.get<string>('CHICKEN_NATION_SUPPORT')}`
                            : ""
                    ),
                ].join('\n');

                return emailContent;
            }
        };

    /**
     * NOUVEL INSCRIT CLIENT (Notification pour les administrateurs)
     */
    NEW_CUSTOMER: EmailTemplate<{
        customer: Customer
    }> = {
            subject: (ctx) => `🆕 Nouveau client inscrit : ${ctx.data.customer.first_name ?? ''} ${ctx.data.customer.last_name ?? ''}`,
            content: (ctx) => {
                const fullname = `${ctx.data.customer.first_name ?? ''} ${ctx.data.customer.last_name ?? ''}`.trim();

                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Nouvelle inscription client`,
                        `${fullname || ctx.data.customer.phone} vient de rejoindre Chicken Nation !`
                    ),
                    this.emailComponentsService.Summary([
                        { label: 'Nom complet', value: fullname || "Non renseigné" },
                        { label: 'Téléphone', value: ctx.data.customer.phone ?? "Non renseigné" },
                        { label: 'Email', value: ctx.data.customer.email ?? "Non renseigné" },
                        { label: 'Date d’inscription', value: ctx.data.customer.created_at.toLocaleString() },
                    ]),
                ].join('\n');

                return emailContent;
            }
        };
}