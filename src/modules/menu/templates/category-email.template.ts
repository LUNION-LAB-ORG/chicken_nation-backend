import { Injectable } from "@nestjs/common";
import { Category, Prisma, Restaurant } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";

@Injectable()
export class CategoryEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService) { }

    NEW_CATEGORY_BACKOFFICE: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            category: Category
        }> = {
            subject: (ctx) => `Nouvelle catégorie`,
            content: (ctx) => {

                const emailContent = [
                    this.emailComponentsService.Title('Nouvelle catégorie'),
                    this.emailComponentsService.Message(`La catégorie ${ctx.data.category.name} a été créée.`),
                    this.emailComponentsService.Summary([
                        { label: 'Auteur', value: ctx.data.actor.fullname ?? "Non renseigné" },
                        { label: 'Role', value: ctx.data.actor.role ?? "Non renseigné" },
                        { label: "Email", value: ctx.data.actor.email ?? "Non renseigné" },
                        { label: "Date", value: ctx.data.category.created_at.toLocaleDateString() }
                    ]),
                ].join('\n');

                return emailContent;
            }
        };
    NEW_CATEGORY_RESTAURANT: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            category: Category
        }> = {
            subject: (ctx) => `Nouvelle catégorie`,
            content: (ctx) => {

                const emailContent = [
                    this.emailComponentsService.Title('Nouvelle catégorie'),
                    this.emailComponentsService.Message(`Nous avons le plaisir de vous annoncer la création de la catégorie ${ctx.data.category.name}.`),
                ].join('\n');

                return emailContent;
            }
        };
}