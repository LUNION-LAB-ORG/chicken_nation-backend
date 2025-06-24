import { Injectable } from "@nestjs/common";
import { Prisma, Restaurant, User } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";
import { ConfigService } from "@nestjs/config"; // Assuming ConfigService is available for URLs

@Injectable()
export class RestaurantEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService,
        private readonly configService: ConfigService // Inject ConfigService
    ) { }

    /**
     * Notification aux administrateurs/managers lorsqu'un nouveau restaurant est créé.
     */
    NEW_RESTAURANT: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            restaurant: Restaurant
        }> = {
            subject: (ctx) => `🎉 Nouveau restaurant : ${ctx.data.restaurant.name} a rejoint Chicken Nation !`,
            content: (ctx) => {
                const adminDashboardUrl = this.configService.get<string>('FRONTEND_URL') || "";

                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Nouveau restaurant enregistré : ${ctx.data.restaurant.name}`,
                        `Un nouveau partenaire a rejoint la plateforme !`
                    ),
                    this.emailComponentsService.Message(
                        `Nous sommes ravis de vous informer que le restaurant ${ctx.data.restaurant.name} a été créé par ${ctx.data.actor.fullname}. C'est une excellente nouvelle pour agrandir notre réseau !`
                    ),
                    this.emailComponentsService.RestaurantInfo('Détails du nouveau restaurant', [
                        { label: 'Nom du restaurant', value: ctx.data.restaurant.name ?? "Non renseigné" },
                        { label: 'Adresse', value: ctx.data.restaurant.address ?? "Non renseigné" },
                        { label: "Email de contact", value: ctx.data.restaurant.email ?? "Non renseigné" },
                        { label: "Téléphone de contact", value: ctx.data.restaurant.phone ?? "Non renseigné" },
                        { label: "Créé par", value: ctx.data.actor.fullname ?? "Non renseigné" } // Added creator
                    ]),
                    this.emailComponentsService.CtaButton('Accéder au tableau de bord Admin', adminDashboardUrl, 'primary'),
                    this.emailComponentsService.Alert(
                        'Assurez-vous que toutes les informations sont correctes et que le restaurant est prêt à prendre des commandes.',
                        'info'
                    ),
                ].join('\n');

                return emailContent;
            }
        };


    /**
     * Email de bienvenue envoyé au restaurant nouvellement créé.
     */
    WELCOME_RESTAURANT: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            restaurant: Restaurant
        }> = {
            subject: (ctx) => `🎉 Bienvenue à ${ctx.data.restaurant.name} dans la famille Chicken Nation !`,
            content: (ctx) => {
                const restaurantDashboardUrl = this.configService.get<string>('FRONTEND_URL') || "";
                const supportUrl = this.configService.get<string>('SUPPORT_URL') || `mailto:${this.configService.get<string>('SUPPORT_EMAIL')}` || "";

                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Bienvenue, ${ctx.data.restaurant.name} !`,
                        `Nous sommes ravis de vous compter parmi nos partenaires privilégiés !`
                    ),
                    this.emailComponentsService.Message(
                        `Toute l'équipe de Chicken Nation vous souhaite la bienvenue ! Votre restaurant ${ctx.data.restaurant.name} est maintenant officiellement en ligne. Nous sommes impatients de voir vos plats régaler nos clients.`
                    ),
                    this.emailComponentsService.RestaurantInfo('Vos informations clés', [ // Better title
                        { label: 'Nom du restaurant', value: ctx.data.restaurant.name ?? "Non renseigné" },
                        { label: 'Adresse', value: ctx.data.restaurant.address ?? "Non renseigné" },
                        { label: "Email de contact", value: ctx.data.restaurant.email ?? "Non renseigné" },
                        { label: "Téléphone", value: ctx.data.restaurant.phone ?? "Non renseigné" }
                    ]),
                    this.emailComponentsService.ToastNotification(
                        `Commencez par configurer votre menu et vos heures d'ouverture pour apparaître sur la plateforme.`,
                        'info'
                    ),
                    this.emailComponentsService.CtaButton('Accéder à votre tableau de bord restaurant', restaurantDashboardUrl, 'primary'),
                    this.emailComponentsService.Divider(),
                    this.emailComponentsService.Message(
                        `Pour toute question ou assistance, n'hésitez pas à contacter notre équipe de support dédiée. Nous sommes là pour vous aider à réussir !`
                    ),
                    this.emailComponentsService.CtaButton('Contacter le support', supportUrl, 'outline'),
                ].join('\n');

                return emailContent;
            }
        };
}