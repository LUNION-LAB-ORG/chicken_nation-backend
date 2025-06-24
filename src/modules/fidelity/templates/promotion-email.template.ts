import { Injectable } from "@nestjs/common";
import { Customer, Prisma, Promotion, DiscountType, TargetType, Visibility } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";
import { ConfigService } from "@nestjs/config";
import { userGetRole } from "src/modules/users/constantes/user-get-role.constante";

@Injectable()
export class PromotionEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService,
        private readonly configService: ConfigService
    ) { }

    // Helper to format discount value and type
    private formatDiscount(promotion: Promotion): string {
        switch (promotion.discount_type) {
            case DiscountType.PERCENTAGE:
                return `${promotion.discount_value}% de réduction`;
            case DiscountType.FIXED_AMOUNT:
                return `${promotion.discount_value} XOF de réduction`;
            case DiscountType.BUY_X_GET_Y:
                return `Achetez ${promotion.discount_value} plat(s), obtenez des plats`;
            default:
                return `Réduction de ${promotion.discount_value}`;
        }
    }

    // Helper to format target type
    private formatTargetType(promotion: Promotion): string {
        switch (promotion.target_type) {
            case TargetType.ALL_PRODUCTS:
                return 'Tous les produits';
            case TargetType.SPECIFIC_PRODUCTS:
                return 'Produits spécifiques';
            case TargetType.CATEGORIES:
                return 'Catégories spécifiques';
            default:
                return 'Non spécifié';
        }
    }

    // Helper to format loyalty levels
    private formatLoyaltyLevels(promotion: Promotion): string {
        const levels: string[] = [];
        if (promotion.target_standard) levels.push('Les clients Standard');
        if (promotion.target_premium) levels.push('Les clients Premium');
        if (promotion.target_gold) levels.push('Les clients Gold');
        return levels.length ? levels.join(', ') : 'Tous les niveaux de fidélité';
    }

    /**
     * Email de confirmation envoyé au client lorsqu'une promotion est utilisée avec succès.
     */
    PROMOTION_USED_CUSTOMER: EmailTemplate<{
        customer: Customer,
        promotion: Promotion,
        discountAmount: number,
    }> = {
            subject: (ctx) => `🎉 Bravo ! Votre promotion "${ctx.data.promotion.title}" a bien été appliquée !`,
            content: (ctx) => {
                const promotionEndDate = ctx.data.promotion.expiration_date?.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) ?? 'Illimité';

                const emailContent = [
                    this.emailComponentsService.Greeting(`Bonjour ${ctx.data.customer.first_name ?? 'Cher client'}`, '🥳'),
                    this.emailComponentsService.Message(
                        `Nous vous confirmons que la promotion "${ctx.data.promotion.title}" a été appliquée à votre commande. Vous avez économisé ${ctx.data.discountAmount} XOF !`
                    ),
                    this.emailComponentsService.Summary([
                        { label: 'Promotion utilisée', value: ctx.data.promotion.title },
                        { label: 'Type de réduction', value: this.formatDiscount(ctx.data.promotion) },
                        { label: 'Montant de l\'économie', value: `${ctx.data.discountAmount} XOF`, isTotal: true },
                        { label: 'Valable jusqu\'au', value: promotionEndDate },
                    ]),
                    this.emailComponentsService.InfoBox(
                        `Profitez bien de votre commande ! N'hésitez pas à découvrir nos autres offres exclusives.`,
                        '💡'
                    ),
                    this.emailComponentsService.Divider(),
                    this.emailComponentsService.Message(
                        `Merci de faire partie de la famille Chicken Nation. À très vite pour de nouvelles saveurs !`
                    )
                ].join('\n');

                return emailContent;
            }
        };

    /**
     * Email informant les clients qu'une nouvelle promotion est disponible.
     * Can optionally include specific targeted product/category names for clarity.
     */
    NEW_PROMOTION_AVAILABLE_CUSTOMER: EmailTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        promotion: Promotion,
        targetedNames?: string[]
    }> = {
            subject: (ctx) => `🔥 Nouvelle offre spéciale : "${ctx.data.promotion.title}" ! ${this.formatDiscount(ctx.data.promotion)}`,
            content: (ctx) => {
                const promotionStartDate = ctx.data.promotion.start_date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const promotionEndDate = ctx.data.promotion.expiration_date?.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) ?? 'Illimité';

                const emailContent = [
                    this.emailComponentsService.HeroSection(
                        `Découvrez notre nouvelle promotion !`,
                        `"${ctx.data.promotion.title}" - Une occasion à ne pas manquer !`
                    ),
                    this.emailComponentsService.Message(
                        `Préparez-vous à vous régaler à petit prix ! Nous sommes ravis de vous présenter notre toute nouvelle promotion :`
                    ),
                    this.emailComponentsService.Quote(
                        ctx.data.promotion.description || 'Profitez de cette offre exceptionnelle !',
                    ),
                    this.emailComponentsService.Summary([
                        { label: 'Type de réduction', value: this.formatDiscount(ctx.data.promotion) },
                        { label: 'Cible', value: this.formatTargetType(ctx.data.promotion) },
                        ...(ctx.data.targetedNames?.length ? [{ label: 'Articles/Catégories ciblés', value: ctx.data.targetedNames.join(', ') }] : []),
                        { label: 'Montant min. de commande', value: `${ctx.data.promotion.min_order_amount ?? 0} XOF` },
                        { label: 'Période de validité', value: `Du ${promotionStartDate} au ${promotionEndDate}` },
                        ...(ctx.data.promotion.max_usage_per_user ? [{ label: 'Utilisations par client', value: `${ctx.data.promotion.max_usage_per_user} fois` }] : []),
                        ...(ctx.data.promotion.visibility === Visibility.PRIVATE ? [{ label: 'Niveaux de fidélité ciblés', value: this.formatLoyaltyLevels(ctx.data.promotion) }] : []),
                    ]),
                ].filter(Boolean).join('\n');

                return emailContent;
            }
        };


    /**
     * Email pour la notification des restaurants et du backoffice : Nouvelle promotion.
     */
    PROMOTION_CREATED_INTERNAL: EmailTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        promotion: Promotion
    }> = {
            subject: (ctx) => `🎉 Nouvelle promotion créée : "${ctx.data.promotion.title}"`,
            content: (ctx) => this.getPromotionManagementEmailContent(ctx.data, 'créée', 'Nouvelle promotion', '🌟')
        };

    /**
     * Email pour la notification des restaurants et du backoffice : Promotion modifiée.
     */
    PROMOTION_UPDATED_INTERNAL: EmailTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        promotion: Promotion
    }> = {
            subject: (ctx) => `✏️ Promotion modifiée : "${ctx.data.promotion.title}"`,
            content: (ctx) => this.getPromotionManagementEmailContent(ctx.data, 'modifiée', 'Promotion modifiée', '🔄')
        };

    /**
     * Email pour la notification des restaurants et du backoffice : Promotion supprimée.
     */
    PROMOTION_DELETED_INTERNAL: EmailTemplate<{
        actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>,
        promotion: Promotion
    }> = {
            subject: (ctx) => `🗑️ Promotion supprimée : "${ctx.data.promotion.title}"`,
            content: (ctx) => this.getPromotionManagementEmailContent(ctx.data, 'supprimée', 'Promotion supprimée', '⚠️')
        };


    /**     
* Base commune pour les emails de gestion de promotion (Création, Modification, Suppression).
* This function now leverages more details from the Promotion model.
*/
    private getPromotionManagementEmailContent(ctx: { actor: Prisma.UserGetPayload<{ include: { restaurant: true } }>, promotion: Promotion }, action: 'créée' | 'modifiée' | 'supprimée', titlePrefix: string, iconEmoji: string): string {
        const adminPromotionsUrl = this.configService.get<string>('FRONTEND_URL') || "";
        const actorRole = userGetRole(ctx.actor.role);
        const promotionStartDate = ctx.promotion.start_date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const promotionExpirationDate = ctx.promotion.expiration_date?.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) ?? 'Illimité';
        const promotionCreatedAt = ctx.promotion.created_at.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const promotionUpdatedAt = ctx.promotion.updated_at.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

        return [
            this.emailComponentsService.HeroSection(
                `${titlePrefix} : "${ctx.promotion.title}"`,
                `Une promotion a été ${action} sur la plateforme.`
            ),
            this.emailComponentsService.Message(
                `La promotion "${ctx.promotion.title}" a été ${action} par ${ctx.actor.fullname} (${actorRole}).`
            ),
            // Optional: Coupon image if available
            ctx.promotion.coupon_image_url ? `<img src="${ctx.promotion.coupon_image_url}" alt="Image de la promotion" style="max-width: 100%; height: auto; border-radius: 8px; margin-bottom: 20px;">` : '',
            this.emailComponentsService.Summary([
                { label: 'Nom de la promotion', value: ctx.promotion.title },
                { label: 'Description', value: ctx.promotion.description ?? 'Non renseignée' },
                { label: 'Type de réduction', value: this.formatDiscount(ctx.promotion) },
                { label: 'Cible', value: this.formatTargetType(ctx.promotion) },
                ...(ctx.promotion.min_order_amount ? [{ label: 'Montant min. de commande', value: `${ctx.promotion.min_order_amount} XOF` }] : []),
                ...(ctx.promotion.max_discount_amount ? [{ label: 'Réduction max.', value: `${ctx.promotion.max_discount_amount} XOF` }] : []),
                ...(ctx.promotion.max_usage_per_user ? [{ label: 'Utilisations par client', value: `${ctx.promotion.max_usage_per_user} fois` }] : []),
                ...(ctx.promotion.max_total_usage ? [{ label: 'Utilisations totales max.', value: `${ctx.promotion.max_total_usage} fois` }] : []),
                { label: 'Date de début', value: promotionStartDate },
                { label: 'Date de fin', value: promotionExpirationDate },
                { label: 'Statut', value: ctx.promotion.status },
                { label: 'Visibilité', value: ctx.promotion.visibility === Visibility.PUBLIC ? 'Publique' : 'Privée' },
                ...(ctx.promotion.visibility === Visibility.PRIVATE ? [{ label: 'Niveaux de fidélité ciblés', value: this.formatLoyaltyLevels(ctx.promotion) }] : []),
                { label: 'Créée le', value: promotionCreatedAt },
                ...(action === 'modifiée' ? [{ label: 'Dernière modif. le', value: promotionUpdatedAt }] : []),
                { label: 'Gérée par', value: `${ctx.actor.fullname} (${actorRole})` }
            ]),
            this.emailComponentsService.CtaButton('Voir toutes les promotions', adminPromotionsUrl),
            this.emailComponentsService.Divider(),
            this.emailComponentsService.InfoBox(
                `Gardez un œil sur l'impact de cette promotion sur les ventes et l'engagement des clients.`,
                iconEmoji
            )
        ].filter(Boolean).join('\n'); // Filter out empty strings from optional image
    }

}