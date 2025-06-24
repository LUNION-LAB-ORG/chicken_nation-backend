import { Injectable } from "@nestjs/common";
import { Prisma, Dish } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";

@Injectable()
export class DishEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService) { }

    NEW_DISH_BACKOFFICE: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            dish: Dish
        }> = {
            subject: (ctx) => `Nouveau plat`,
            content: (ctx) => {

                const emailContent = [
                    this.emailComponentsService.Title('Nouveau plat'),
                    this.emailComponentsService.Message(`Le plat ${ctx.data.dish.name} a été créé.`),
                    this.emailComponentsService.Summary([
                        { label: 'Auteur', value: ctx.data.actor.fullname ?? "Non renseigné" },
                        { label: 'Role', value: ctx.data.actor.role ?? "Non renseigné" },
                        { label: "Email", value: ctx.data.actor.email ?? "Non renseigné" },
                        { label: "Date", value: ctx.data.dish.created_at.toLocaleDateString() }
                    ]),
                ].join('\n');

                return emailContent;
            }
        };
    NEW_DISH_RESTAURANT: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            dish: Dish
        }> = {
            subject: (ctx) => `Nouveau plat`,
            content: (ctx) => {

                const emailContent = [
                    this.emailComponentsService.Title('Nouveau plat'),
                    this.emailComponentsService.Message(`Nous avons le plaisir de vous annoncer la création du plat ${ctx.data.dish.name}.`),
                ].join('\n');

                return emailContent;
            }
        };
}