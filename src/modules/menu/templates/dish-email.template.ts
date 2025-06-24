import { Injectable } from "@nestjs/common";
import { Prisma, Dish } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";
import { ConfigService } from "@nestjs/config"; // Assuming you use ConfigService
import { userGetRole } from "src/modules/users/constantes/user-get-role.constante";

@Injectable()
export class DishEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService,
        private readonly configService: ConfigService // Inject ConfigService
    ) { }


    /**
     * Notification aux membres du back-office lorsqu'un nouveau plat est créé.
     */
    NEW_DISH_BACKOFFICE: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            dish: Dish
        }> = {
            subject: (ctx) => `🍽️ Nouveau plat ajouté : ${ctx.data.dish.name}`,
            content: (ctx) => {
                const actorRole = userGetRole(ctx.data.actor.role);
                const dishCreatedAt = new Date(ctx.data.dish.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }); // Localized date

                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Nouveau plat : ${ctx.data.dish.name}`,
                        `Un nouveau délice a été ajouté au menu !`
                    ),
                    this.emailComponentsService.Message(
                        `Le plat ${ctx.data.dish.name} a été créé par ${ctx.data.actor.fullname} (${actorRole}).`
                    ),
                    this.emailComponentsService.Summary([
                        { label: 'Nom du plat', value: ctx.data.dish.name },
                        { label: 'Description', value: ctx.data.dish.description ?? "Non renseigné" }, // Include description
                        { label: 'Prix', value: `${ctx.data.dish.price} XOF` }, // Include price
                        { label: 'Créé par', value: `${ctx.data.actor.fullname ?? "Non renseigné"} (${actorRole})` },
                        { label: 'Date de création', value: dishCreatedAt },
                    ]),
                    this.emailComponentsService.Alert('Vérifiez les détails du plat et assurez-vous qu\'il est correctement configuré.', 'info'), // Helpful reminder
                ].join('\n');

                return emailContent;
            }
        };


    /**
     * Notification aux restaurants lorsqu'un nouveau plat est disponible (créé par l'admin).
     */
    NEW_DISH_RESTAURANT: EmailTemplate<
        {
            actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
            dish: Dish
        }> = {
            subject: (ctx) => `✨ Nouveau plat à la carte : ${ctx.data.dish.name} !`,
            content: (ctx) => {
                const actorName = ctx.data.actor.fullname ?? 'L\'équipe Chicken Nation';

                const emailContent = [
                    this.emailComponentsService.Greeting(`Bonjour !`, '🍽️'),
                    this.emailComponentsService.Message(
                        `Nous sommes heureux de vous annoncer l'ajout du nouveau plat ${ctx.data.dish.name} à notre carte. Préparez-vous à ravir vos clients !`
                    ),
                    this.emailComponentsService.InfoBox(
                        `Ce plat a été ajouté par ${actorName}. Il est maintenant disponible pour être inclus dans votre menu.`,
                        'ℹ️'
                    ),
                ].join('\n');

                return emailContent;
            }
        };
}