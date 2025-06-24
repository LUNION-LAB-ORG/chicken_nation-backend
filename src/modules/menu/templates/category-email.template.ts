import { Injectable } from "@nestjs/common";
import { Category, Prisma, Restaurant } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";
import { userGetRole } from "src/modules/users/constantes/user-get-role.constante";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class CategoryEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService,
        private readonly configService: ConfigService) { }

    /**
     * Notification aux membres du back-office lorsqu'une nouvelle catégorie est créée.
     */
    NEW_CATEGORY_BACKOFFICE: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            category: Category
        }> = {
            subject: (ctx) => `✨ Nouvelle catégorie "${ctx.data.category.name}" ajoutée !`,
            content: (ctx) => {
                const actorRole = userGetRole(ctx.data.actor.role);

                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Nouvelle Catégorie : ${ctx.data.category.name}`,
                        `Une nouvelle catégorie a été ajoutée à la plateforme.`
                    ),
                    this.emailComponentsService.Message(
                        `La catégorie "${ctx.data.category.name}" a été créée. Elle est maintenant disponible pour être associée aux produits.`
                    ),
                    this.emailComponentsService.Summary([
                        { label: 'Nom de la catégorie', value: ctx.data.category.name ?? "Non renseigné" },
                        { label: 'Créée par', value: `${ctx.data.actor.fullname ?? "Non renseigné"} (${actorRole})` },
                        { label: 'Date de création', value: ctx.data.category.created_at.toLocaleDateString('fr-FR') } // Formatted date
                    ]),
                    this.emailComponentsService.Alert('Vérifiez l\'impact de cette nouvelle catégorie sur l\'organisation des produits.', 'info'),
                ].join('\n');

                return emailContent;
            }
        };

    /**
     * Notification aux restaurants lorsqu'une nouvelle catégorie globale est créée (si applicable).
     * Ou si un restaurant a la capacité de créer ses propres catégories et cela le concerne.
     */
    NEW_CATEGORY_RESTAURANT: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            category: Category
        }> = {
            subject: (ctx) => `🎉 Nouvelle catégorie : "${ctx.data.category.name}" est disponible !`,
            content: (ctx) => {
                const actorName = ctx.data.actor.fullname ?? 'L\'équipe Chicken Nation';

                const emailContent = [
                    this.emailComponentsService.Greeting(`Bonjour !`, '✨'),
                    this.emailComponentsService.Message(
                        `Nous avons le plaisir de vous annoncer la création de la nouvelle catégorie "${ctx.data.category.name}". Vous pouvez désormais l'utiliser pour mieux organiser vos produits.`
                    ),
                    this.emailComponentsService.InfoBox(
                        `Cette catégorie a été ajoutée par ${actorName}. Elle est conçue pour vous aider à affiner l'organisation de votre menu.`,
                        '💡'
                    ),
                ].join('\n');

                return emailContent;
            }
        };
}