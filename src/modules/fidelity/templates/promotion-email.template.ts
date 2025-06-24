import { Injectable } from "@nestjs/common";
import { Prisma, Restaurant, User } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";

@Injectable()
export class PromotionEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService) { }

    NEW_RESTAURANT: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            restaurant: Restaurant
        }> = {
            subject: (ctx) => `Nouveau restaurant`,
            content: (ctx) => {

                const emailContent = [
                    this.emailComponentsService.Title('Nouveau restaurant'),
                    this.emailComponentsService.Message(`Nous avons le plaisir de vous annoncer que le restaurant ${ctx.data.restaurant.name} a été créé par ${ctx.data.actor.fullname}`),
                    this.emailComponentsService.RestaurantInfo('📍 Restaurant', [
                        { label: 'Restaurant', value: ctx.data.restaurant.name ?? "Non renseigné" },
                        { label: 'Adresse', value: ctx.data.restaurant.address ?? "Non renseigné" },
                        { label: "Email", value: ctx.data.restaurant.email ?? "Non renseigné" },
                        { label: "Téléphone", value: ctx.data.restaurant.phone ?? "Non renseigné" }
                    ]),
                ].join('\n');

                return emailContent;
            }
        };

    WELCOME_RESTAURANT: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            restaurant: Restaurant
        }> = {
            subject: (ctx) => `🎉 Bienvenue sur Chicken Nation !`,
            content: (ctx) => {

                const emailContent = [
                    this.emailComponentsService.Greeting(`Nouveau restaurant ${ctx.data.restaurant.name}`, '🎉'),
                    this.emailComponentsService.Message(`Nous avons le plaisir de vous annoncer que votre restaurant ${ctx.data.restaurant.name} fait partie de la famille Chicken Nation !`),
                    this.emailComponentsService.RestaurantInfo('📍 Restaurant', [
                        { label: 'Restaurant', value: ctx.data.restaurant.name ?? "Non renseigné" },
                        { label: 'Adresse', value: ctx.data.restaurant.address ?? "Non renseigné" },
                        { label: "Email", value: ctx.data.restaurant.email ?? "Non renseigné" },
                        { label: "Téléphone", value: ctx.data.restaurant.phone ?? "Non renseigné" }
                    ]),
                ].join('\n');

                return emailContent;
            }
        };
}