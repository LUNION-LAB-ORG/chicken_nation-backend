import { Injectable } from "@nestjs/common";
import { Category, Prisma, Restaurant } from "@prisma/client";
import { EmailTemplate } from "src/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/email/components/email.components.service";
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
                    this.emailComponentsService.CtaButton('Voir toutes les catégories', this.configService.get<string>('ADMIN_CATEGORIES_URL') ?? this.configService.get<string>('FRONTEND_URL') ?? "", 'primary'),
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
                const restaurantMenuUrl = this.configService.get<string>('RESTAURANT_MENU_URL') ?? this.configService.get<string>('FRONTEND_URL') ?? "";


                const emailContent = [
                    this.emailComponentsService.Greeting(`Bonjour !`, '✨'),
                    this.emailComponentsService.Message(
                        `Nous avons le plaisir de vous annoncer la création de la nouvelle catégorie "${ctx.data.category.name}". Vous pouvez désormais l'utiliser pour mieux organiser vos produits.`
                    ),
                    this.emailComponentsService.InfoBox(
                        `Cette catégorie a été ajoutée par ${actorName}. Elle est conçue pour vous aider à affiner l'organisation de votre menu.`,
                        '💡'
                    ),
                    this.emailComponentsService.CtaButton('Gérer mon menu', restaurantMenuUrl, 'primary'),
                ].join('\n');

                return emailContent;
            }
        };

    /**
     * Notification aux membres du back-office lorsqu'une catégorie est mise à jour.
     */
    CATEGORY_UPDATED_BACKOFFICE: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            category: Category
        }> = {
            subject: (ctx) => `📝 Catégorie mise à jour : "${ctx.data.category.name}"`,
            content: (ctx) => {
                const actorRole = userGetRole(ctx.data.actor.role);
                const categoryUpdatedAt = ctx.data.category.updated_at.toLocaleDateString('fr-FR');
                const adminCategoriesUrl = this.configService.get<string>('ADMIN_CATEGORIES_URL') ?? this.configService.get<string>('FRONTEND_URL') ?? "";


                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Catégorie mise à jour : ${ctx.data.category.name}`,
                        `Les informations d'une catégorie ont été modifiées.`
                    ),
                    this.emailComponentsService.Message(
                        `La catégorie "${ctx.data.category.name}" a été mise à jour par ${ctx.data.actor.fullname} (${actorRole}).`
                    ),
                    this.emailComponentsService.Summary([
                        { label: 'Nom de la catégorie', value: ctx.data.category.name ?? "Non renseigné" },
                        { label: 'Description', value: ctx.data.category.description ?? "Non renseigné" }, // Include description if it can be updated
                        { label: 'Modifiée par', value: `${ctx.data.actor.fullname ?? "Non renseigné"} (${actorRole})` },
                        { label: 'Dernière modification le', value: categoryUpdatedAt }
                    ]),
                    this.emailComponentsService.CtaButton('Voir les détails de la catégorie', adminCategoriesUrl, 'primary'),
                    this.emailComponentsService.InfoBox('Vérifiez que les modifications apportées sont conformes aux attentes.', 'ℹ️'),
                ].join('\n');

                return emailContent;
            }
        };

    /**
     * Notification aux restaurants lorsqu'une catégorie (globale ou propre) est mise à jour.
     */
    CATEGORY_UPDATED_RESTAURANT: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            category: Category
        }> = {
            subject: (ctx) => `✏️ Catégorie mise à jour : "${ctx.data.category.name}"`,
            content: (ctx) => {
                const actorName = ctx.data.actor.fullname ?? 'L\'équipe Chicken Nation';
                const restaurantMenuUrl = this.configService.get<string>('RESTAURANT_MENU_URL') ?? this.configService.get<string>('FRONTEND_URL') ?? "";


                const emailContent = [
                    this.emailComponentsService.Greeting(`Bonjour !`, '📝'),
                    this.emailComponentsService.Message(
                        `La catégorie "${ctx.data.category.name}" a été mise à jour par ${actorName}.`
                    ),
                    this.emailComponentsService.InfoBox(
                        `Les informations de cette catégorie ont été modifiées. Cela pourrait affecter l'organisation de votre menu.`,
                        '💡'
                    ),
                    this.emailComponentsService.CtaButton('Gérer mon menu', restaurantMenuUrl, 'primary'),
                ].join('\n');

                return emailContent;
            }
        };
}