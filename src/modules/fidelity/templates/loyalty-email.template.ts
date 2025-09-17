import { Injectable } from "@nestjs/common";
import { Customer, LoyaltyLevel } from "@prisma/client";
import { EmailTemplate } from "src/modules/email/interfaces/email-template.interface";
import { EmailComponentsService } from "src/modules/email/components/email.components.service";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class LoyaltyEmailTemplates {
    constructor(
        private readonly emailComponentsService: EmailComponentsService,
        private readonly configService: ConfigService
    ) { }

    // Helper to get the customer loyalty dashboard URL
    private getCustomerLoyaltyDashboardUrl(): string {
        return this.configService.get<string>('CUSTOMER_LOYALTY_DASHBOARD_URL') ?? this.configService.get<string>('FRONTEND_URL') ?? "";
    }

    // Helper to get the customer order history URL (for points redeemed context)
    private getCustomerOrderHistoryUrl(): string {
        return this.configService.get<string>('CUSTOMER_ORDER_HISTORY_URL') ?? this.configService.get<string>('FRONTEND_URL') ?? "";
    }

    // Helper function for loyalty level descriptions
    private getLevelDescription(level: LoyaltyLevel): string {
        switch (level) {
            case LoyaltyLevel.STANDARD:
                return "des avantages de base pour démarrer votre parcours de fidélité. Accumulez plus de points pour débloquer des paliers supérieurs !";
            case LoyaltyLevel.PREMIUM:
                return "des réductions exclusives, des accès anticipés à des promotions, et des surprises personnalisées. Vous êtes sur la bonne voie !";
            case LoyaltyLevel.GOLD:
                return "un services client prioritaire, des invitations à des événements spéciaux, des remises VIP et bien plus encore ! Vous êtes notre client le plus précieux !";
            default:
                return "des avantages exceptionnels. Continuez votre aventure pour découvrir toutes les récompenses !";
        }
    }

    /**
     * Email envoyé à un client lorsqu'il gagne des points de fidélité.
     */
    LOYALTY_POINTS_ADDED: EmailTemplate<{ actor: Customer; points: number; orderReference?: string; }> = {
        subject: (ctx) => `🎉 Félicitations, ${ctx.data.actor.first_name ?? 'cher client'} ! Vous avez gagné ${ctx.data.points} points !`,
        content: (ctx) => {
            const customerName = ctx.data.actor.first_name ?? 'Cher client';
            const orderContext = ctx.data.orderReference ? `grâce à votre commande #${ctx.data.orderReference}` : 'suite à votre récente activité';

            const emailContent = [
                this.emailComponentsService.Greeting(`Bonjour ${customerName}`, '🥳'),
                this.emailComponentsService.Message(
                    `Excellente nouvelle ! Vous avez accumulé ${ctx.data.points} points de fidélité supplémentaires ${orderContext}.`
                ),
                this.emailComponentsService.Summary([
                    { label: 'Points gagnés', value: `+${ctx.data.points} points` },
                    { label: 'Nouveau solde', value: `${ctx.data.actor.total_points} points` },
                ]),
                this.emailComponentsService.InfoBox(
                    `Plus de points, plus de récompenses ! Utilisez vos points pour des réductions exclusives ou des plats offerts.`,
                    '💡'
                ),
                this.emailComponentsService.CtaButton('Voir mes points et récompenses', this.getCustomerLoyaltyDashboardUrl(), 'primary'),
                this.emailComponentsService.Divider(),
                this.emailComponentsService.Message(
                    `Merci de faire partie de la famille Chicken Nation. Votre fidélité est notre plus belle récompense !`
                )
            ].join('\n');

            return emailContent;
        }
    };

    /**
     * Email envoyé à un client lorsqu'il utilise des points de fidélité.
     */
    LOYALTY_POINTS_REDEEMED: EmailTemplate<{ actor: Customer; points: number; orderReference?: string; }> = {
        subject: (ctx) => `💎 Confirmation : Vos ${ctx.data.points} points ont été utilisés !`,
        content: (ctx) => {
            const customerName = ctx.data.actor.first_name ?? 'Cher client';
            const orderContext = ctx.data.orderReference ? `pour la commande #${ctx.data.orderReference}` : '';

            const emailContent = [
                this.emailComponentsService.Greeting(`Bonjour ${customerName}`),
                this.emailComponentsService.Message(
                    `Nous confirmons l'utilisation de ${ctx.data.points} points de fidélité de votre compte ${orderContext}.`
                ),
                this.emailComponentsService.Summary([
                    { label: 'Points utilisés', value: `-${ctx.data.points} points` },
                    { label: 'Points restants', value: `${ctx.data.actor.total_points} points` },
                ]),
                this.emailComponentsService.InfoBox(
                    `Profitez bien de votre récompense ! Continuez à commander pour accumuler plus de points et bénéficier de nos offres exclusives.`,
                    '✅'
                ),
                this.emailComponentsService.CtaButton('Voir mon historique de commandes', this.getCustomerOrderHistoryUrl(), 'primary'), // Link to order history for context
                this.emailComponentsService.Divider(),
                this.emailComponentsService.Message(
                    `Votre satisfaction est notre priorité. À très bientôt pour de nouvelles saveurs !`
                )
            ].join('\n');

            return emailContent;
        }
    };

    /**
    * Email envoyé à un client lorsqu'il atteint un nouveau niveau de fidélité.
    */
    LOYALTY_LEVEL_UP: EmailTemplate<{ actor: Customer; new_level: LoyaltyLevel; bonus_points: number; }> = {
        subject: (ctx) => `🏆 Bravo, ${ctx.data.actor.first_name ?? 'cher client'} ! Vous êtes maintenant membre ${ctx.data.new_level} !`,
        content: (ctx) => {
            const customerName = ctx.data.actor.first_name ?? 'Cher client';
            const newLevelDescription = this.getLevelDescription(ctx.data.new_level);

            const emailContent = [
                this.emailComponentsService.HeroSection(
                    `Félicitations, ${customerName} !`,
                    `Vous avez atteint un nouveau palier de fidélité : le niveau ${ctx.data.new_level} !`
                ),
                this.emailComponentsService.Message(
                    `C'est avec une grande joie que nous célébrons votre ascension ! Votre fidélité continue de nous inspirer.`
                ),
                this.emailComponentsService.Quote(
                    `Bienvenue au niveau ${ctx.data.new_level} ! En tant que membre ${ctx.data.new_level}, vous bénéficierez de ${newLevelDescription}.`
                ),
                this.emailComponentsService.Summary([
                    { label: 'Nouveau niveau de fidélité', value: `${ctx.data.new_level}` },
                    { label: 'Points bonus offerts', value: `+${ctx.data.bonus_points} points` },
                    { label: 'Total de vos points', value: `${ctx.data.actor.total_points} points` },
                ]),
                this.emailComponentsService.InfoBox(
                    `Explorez tous les avantages exclusifs que votre nouveau statut ${ctx.data.new_level} vous réserve !`,
                    '🌟'
                ),
                this.emailComponentsService.CtaButton('Découvrir mes avantages', this.getCustomerLoyaltyDashboardUrl(), 'primary'),
                this.emailComponentsService.Divider(),
                this.emailComponentsService.Message(
                    `Merci de votre fidélité continue. Nous sommes impatients de vous faire profiter de ces nouvelles récompenses !`
                )
            ].join('\n');

            return emailContent;
        }
    };

    /**
     * Email envoyé à un client pour l'informer des points qui vont bientôt expirer.
     */
    POINTS_EXPIRING_SOON: EmailTemplate<{ actor: Customer; expiring_points: number; days_remaining: number; }> = {
        subject: (ctx) => `⏰ Action Requise : ${ctx.data.expiring_points} points vont expirer dans ${ctx.data.days_remaining} jours !`,
        content: (ctx) => {
            const customerName = ctx.data.actor.first_name ?? 'Cher client';
            const estimatedExpirationDate = new Date();
            estimatedExpirationDate.setDate(estimatedExpirationDate.getDate() + ctx.data.days_remaining);
            const formattedExpirationDate = estimatedExpirationDate.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

            const emailContent = [
                this.emailComponentsService.HeroSection(
                    `Ne laissez pas vos points s'envoler, ${customerName} !`,
                    `${ctx.data.expiring_points} points de votre solde vont bientôt expirer !`
                ),
                this.emailComponentsService.Message(
                    `Nous tenons à vous informer que ${ctx.data.expiring_points} points de fidélité de votre compte expireront dans seulement ${ctx.data.days_remaining} jours !`
                ),
                this.emailComponentsService.Summary([
                    { label: 'Points concernés', value: `${ctx.data.expiring_points} points` },
                    { label: 'Date d\'expiration estimée', value: `${formattedExpirationDate}` },
                    { label: 'Votre solde actuel', value: `${ctx.data.actor.total_points} points` },
                ]),
                this.emailComponentsService.InfoBox(
                    `C'est le moment idéal pour utiliser ces points ! Explorez nos délicieux plats ou nos récompenses exclusives.`,
                    '💡'
                ),
                this.emailComponentsService.CtaButton('Utiliser mes points maintenant', this.getCustomerLoyaltyDashboardUrl(), 'primary'),
                this.emailComponentsService.Divider(),
                this.emailComponentsService.Message(
                    `Ne manquez pas cette opportunité de vous faire plaisir !`
                )
            ].join('\n');

            return emailContent;
        }
    };

    /**
     * Email envoyé à un client l'informant des points expirés.
     */
    POINTS_EXPIRED: EmailTemplate<{ actor: Customer; expired_points: number; }> = {
        subject: (ctx) => `🗑️ Information importante : ${ctx.data.expired_points} points ont expiré`,
        content: (ctx) => {
            const customerName = ctx.data.actor.first_name ?? 'Cher client';

            const emailContent = [
                this.emailComponentsService.Greeting(`Bonjour ${customerName}`),
                this.emailComponentsService.Message(
                    `Nous sommes désolés de vous informer que ${ctx.data.expired_points} points de fidélité de votre compte ont malheureusement expiré.`
                ),
                this.emailComponentsService.Summary([
                    { label: 'Points expirés', value: `-${ctx.data.expired_points} points` },
                    { label: 'Votre nouveau solde', value: `${ctx.data.actor.total_points} points` },
                ]),
                this.emailComponentsService.InfoBox(
                    `Ce n'est pas grave ! Continuez à commander vos plats préférés pour accumuler de nouveaux points et débloquer des récompenses.`,
                    '✅' // Neutral, encouraging icon
                ),
                this.emailComponentsService.CtaButton('Gagner plus de points', this.getCustomerLoyaltyDashboardUrl(), 'primary'),
                this.emailComponentsService.Divider(),
                this.emailComponentsService.Message(
                    `Nous restons à votre disposition si vous avez des questions. Merci pour votre fidélité !`
                )
            ].join('\n');

            return emailContent;
        }
    };
}