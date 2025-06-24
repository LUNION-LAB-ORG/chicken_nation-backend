import { Injectable } from "@nestjs/common";
import { Prisma, Restaurant, User } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class UserEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService,
        private readonly configService: ConfigService) { }

    NEW_USER: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
        }> = {
            subject: (ctx) => `Nouvel utilisateur`,
            content: (ctx) => {

                const emailContent = [
                    this.emailComponentsService.Title('Nouvel utilisateur'),
                    this.emailComponentsService.Message(`${ctx.data.user.fullname} a rejoint votre équipe en tant que agent ${ctx.data.user.role}`),
                    this.emailComponentsService.Summary([
                        { label: 'Auteur', value: ctx.data.actor.fullname },
                        { label: 'Email', value: ctx.data.actor.email ?? "Non renseigné" },
                        { label: 'Role', value: ctx.data.actor.role ?? "Non renseigné" },
                    ]),
                ].join('\n');

                return emailContent;
            }
        };

    NEW_MEMBER: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
        }> = {
            subject: (ctx) => `Nouveau membre`,
            content: (ctx) => {

                const emailContent = [
                    this.emailComponentsService.Greeting(`Nouveau membre`, '🎉'),
                    this.emailComponentsService.Message(`${ctx.data.user.fullname} a rejoint votre équipe en tant que agent ${ctx.data.user.role}`),
                    this.emailComponentsService.Summary([
                        { label: 'Auteur', value: ctx.data.actor.fullname },
                        { label: 'Email', value: ctx.data.actor.email ?? "Non renseigné" },
                        { label: 'Role', value: ctx.data.actor.role ?? "Non renseigné" },
                    ]),
                    this.emailComponentsService.RestaurantInfo('📍 Restaurant', [
                        { label: 'Restaurant', value: ctx.data.user.restaurant?.name ?? "Non renseigné" },
                        { label: 'Adresse', value: ctx.data.user.restaurant?.address ?? "Non renseigné" },
                        { label: "Email", value: ctx.data.user.restaurant?.email ?? "Non renseigné" },
                        { label: "Téléphone", value: ctx.data.user.restaurant?.phone ?? "Non renseigné" }
                    ]),
                ].join('\n');

                return emailContent;
            }
        };

    WELCOME_USER: EmailTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
    }> = {
            subject: (ctx) => `Bienvenue ${ctx.data.user.fullname} !`,
            content: (ctx) => {

                const emailContent = [
                    this.emailComponentsService.Greeting(`Bienvenue ${ctx.data.user.fullname}`, '🎉'),
                    this.emailComponentsService.Message(`Merci de rejoindre notre communauté !`),
                    this.emailComponentsService.CtaButton('Se connecter', this.configService.get<string>('FRONTEND_URL') ?? "", "📎"),
                ].join('\n');

                return emailContent;
            }
        };
}