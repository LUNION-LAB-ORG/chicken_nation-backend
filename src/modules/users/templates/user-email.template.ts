import { Injectable } from "@nestjs/common";
import { Prisma, UserType } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";
import { ConfigService } from "@nestjs/config";
import { userGetRole } from "../constantes/user-get-role.constante";
import { AssetsImages } from "src/common/constantes/assets.constante";

@Injectable()
export class UserEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService,
        private readonly configService: ConfigService) { }

    /**
     * NOUVEL UTILISATEUR (Notification pour les administrateurs/managers)
     */
    NEW_USER: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
        }> = {
            subject: (ctx) => `🎉 Nouvel utilisateur ${ctx.data.user.fullname} a rejoint l'équipe Chicken Nation !`,
            content: (ctx) => {
                const userRole = userGetRole(ctx.data.user.role);
                const actorRole = userGetRole(ctx.data.actor.role);

                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Nouvel utilisateur : ${ctx.data.user.fullname}`,
                        `Un nouveau membre a rejoint l'équipe Chicken Nation !`,
                    ),
                    this.emailComponentsService.Message(
                        `Nous avons le plaisir de vous informer que ${ctx.data.user.fullname} (${ctx.data.user.email}) a été ajouté en tant que ${userRole} par ${ctx.data.actor.fullname} (${actorRole}).`
                    ),
                    this.emailComponentsService.Summary([
                        { label: 'Nom Complet', value: ctx.data.user.fullname ?? "Non renseigné" },
                        { label: 'Email', value: ctx.data.user.email ?? "Non renseigné" },
                        { label: 'Rôle', value: userRole ?? "Non renseigné" },
                        { label: 'Créé par', value: ctx.data.actor.fullname ?? "Non renseigné" },
                    ]),
                    ctx.data.user.restaurant ? this.emailComponentsService.RestaurantInfo('Restaurant Associé', [
                        { label: 'Nom du restaurant', value: ctx.data.user.restaurant?.name ?? "Non renseigné" },
                        { label: 'Adresse', value: ctx.data.user.restaurant?.address ?? "Non renseigné" },
                    ]) : '',
                    this.emailComponentsService.CtaButton('Accéder au tableau de bord', this.configService.get<string>('FRONTEND_URL') ?? "", 'primary'),
                    this.emailComponentsService.Alert('Assurez-vous que le nouvel utilisateur dispose des accès nécessaires.', 'info'),
                ].filter(Boolean).join('\n');

                return emailContent;
            }
        };

    /**
     * NOUVEAU MEMBRE (pour le restaurant manager quand un agent rejoint son équipe)
     */
    NEW_MEMBER: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
        }> = {
            subject: (ctx) => `Un nouveau membre a rejoint votre équipe : ${ctx.data.user.fullname} !`,
            content: (ctx) => {
                const userRole = userGetRole(ctx.data.user.role);
                const actorName = ctx.data.actor.fullname ?? 'Manager';

                const emailContent = [
                    this.emailComponentsService.Greeting(`Bonjour ${ctx.data.user.restaurant?.name ?? 'Cher Manager'}`, '👋'),
                    this.emailComponentsService.Message(
                        `Nous sommes ravis de vous informer que ${ctx.data.user.fullname} a rejoint votre équipe en tant qu'${userRole} pour le restaurant ${ctx.data.user.restaurant?.name ?? "Non renseigné"}.`
                    ),
                    this.emailComponentsService.Summary([
                        { label: 'Nom du nouveau membre', value: ctx.data.user.fullname ?? "Non renseigné" },
                        { label: 'Email', value: ctx.data.user.email ?? "Non renseigné" },
                        { label: 'Rôle', value: userRole ?? "Non renseigné" },
                        { label: 'Ajouté par', value: actorName },
                    ]),
                    this.emailComponentsService.InfoBox(
                        `Ce nouvel agent fait désormais partie de votre équipe. Vous pouvez gérer ses permissions et son profil depuis votre tableau de bord restaurant.`,
                        '💡'
                    ),
                    this.emailComponentsService.CtaButton('Accéder au tableau de bord', this.configService.get<string>('FRONTEND_URL') ?? "", 'primary'),
                ].join('\n');

                return emailContent;
            }
        };

    /**
     * BIENVENUE À L'UTILISATEUR (pour l'utilisateur nouvellement créé)
     */
    WELCOME_USER: EmailTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        user: Prisma.UserGetPayload<{ include: { restaurant: true } }>
    }> = {
            subject: (ctx) => `🎉 Bienvenue à bord, ${ctx.data.user.fullname} !`,
            content: (ctx) => {
                const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? "";
                const userRole = userGetRole(ctx.data.user.role);
                const companyName = ctx.data.user.type == UserType.BACKOFFICE ? "Chicken Nation" : ctx.data.user.restaurant?.name ?? "Non renseigné";

                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Bienvenue chez ${companyName} !`,
                        `Nous sommes ravis de vous compter parmi nous, ${ctx.data.user.fullname} !`
                    ),
                    this.emailComponentsService.Message(
                        `Votre compte ${ctx.data.user.email} a été créé en tant que ${userRole}. Vous êtes maintenant prêt à explorer toutes les fonctionnalités de notre plateforme.`
                    ),
                    ctx.data.user.restaurant ? this.emailComponentsService.RestaurantInfo('Votre Restaurant', [
                        { label: 'Nom', value: ctx.data.user.restaurant?.name ?? "Non renseigné" },
                        { label: 'Adresse', value: ctx.data.user.restaurant?.address ?? "Non renseigné" },
                    ]) : '',
                    this.emailComponentsService.ToastNotification(
                        `Votre rôle est : ${userRole}. Si vous avez des questions, n'hésitez pas à nous contacter.`,
                        'info'
                    ),
                    this.emailComponentsService.CtaButton('Se connecter maintenant', frontendUrl, 'primary'),
                    this.emailComponentsService.Divider(),
                    this.emailComponentsService.Message(
                        `Si vous rencontrez des difficultés pour vous connecter ou avez des questions, notre équipe de support est là pour vous aider.`,
                    ),
                    this.emailComponentsService.CtaButton('Contacter le support', this.configService.get<string>('SUPPORT_URL') ? `mailto:${this.configService.get<string>('SUPPORT_EMAIL')}` : frontendUrl, 'outline'),
                ].filter(Boolean).join('\n');

                return emailContent;
            }
        };
}