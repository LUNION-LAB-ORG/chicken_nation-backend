import { Controller, Get, Res, Param } from '@nestjs/common';
import { EmailTemplateService } from '../templates/email-template.service';
import { EmailComponentsService } from '../components/email.components.service';
import { AssetsImages } from 'src/common/constantes/assets.constante';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';

enum ComponentName {
    Greeting = 'greeting',
    Message = 'message',
    Title = 'title',
    Subtitle = 'subtitle',
    Summary = 'summary',
    RestaurantInfo = 'restaurantinfo',
    InfoBox = 'infobox',
    CtaButton = 'ctabutton',
    List = 'list',
    Divider = 'divider',
    Quote = 'quote',
    Alert = 'alert',
    Columns = 'columns',
    SocialLinks = 'sociallinks',
    HeroSection = 'hero',
    GlassCard = 'glasscard',
    Button = 'button',
    StatsGrid = 'statsgrid',
    Badge = 'badge',
    Timeline = 'timeline',
    PricingCard = 'pricingcard',
    Table = 'table',
    ToastNotification = 'toastnotification',
}
@Controller('email-preview')
export class EmailPreviewController {
    private CHICKEN_NATION_LOGO: string;
    private CHICKEN_NATION_NAME: string;
    private CHICKEN_NATION_DESCRIPTION: string;
    private CHICKEN_NATION_SUPPORT: string;
    private CHICKEN_NATION_UNSUBSCRIBE_URL: string;
    private CHICKEN_NATION_URL: string;
    private CHICKEN_NATION_SOCIAL_LINKS: { icon: string, url: string }[];
    constructor(
        private readonly emailTemplateService: EmailTemplateService,
        private readonly emailComponentsService: EmailComponentsService,
        private readonly configService: ConfigService,
    ) {
        this.CHICKEN_NATION_LOGO = this.configService.get<string>('CHICKEN_NATION_LOGO') ?? ""
        this.CHICKEN_NATION_NAME = this.configService.get<string>('CHICKEN_NATION_NAME') ?? ""
        this.CHICKEN_NATION_DESCRIPTION = this.configService.get<string>('CHICKEN_NATION_DESCRIPTION') ?? ""
        this.CHICKEN_NATION_SUPPORT = this.configService.get<string>('CHICKEN_NATION_SUPPORT') ?? ""
        this.CHICKEN_NATION_UNSUBSCRIBE_URL = this.configService.get<string>('CHICKEN_NATION_SUPPORT') ?? ""
        this.CHICKEN_NATION_URL = this.configService.get<string>('CHICKEN_NATION_URL') ?? ""
        this.CHICKEN_NATION_SOCIAL_LINKS = this.configService.get<string>('CHICKEN_NATION_SOCIAL_LINKS')?.split("+").flatMap((link) => {
            const item = link.split(",")
            return ({ icon: item[0], url: item[1] })
        }) ?? []
    }

    @Get()
    getAllComponentsPreview(@Res() res: Response) {
        const components = this.generateAllComponentsHtml();

        const fullHtml = this.emailTemplateService.generateEmailTemplate({
            content: components
        });

        res.send(fullHtml);
    }

    @Get(':componentName')
    getSingleComponentPreview(@Param('componentName') componentName: ComponentName, @Res() res: Response) {
        let componentHtml = '';
        let componentTitle = '';

        // Utilisation d'un switch pour gérer les différents composants
        switch (componentName) {
            case ComponentName.Greeting:
                componentTitle = 'Greeting Component';
                componentHtml = this.emailComponentsService.Greeting('Bonjour cher utilisateur', '👋');
                break;
            case ComponentName.Message:
                componentTitle = 'Message Component';
                componentHtml = this.emailComponentsService.Message('Ceci est un message de démonstration pour illustrer le contenu principal d\'un email.');
                break;
            case ComponentName.Title:
                componentTitle = 'Title Component';
                componentHtml = this.emailComponentsService.Title('Titre de section importante', 1);
                break;
            case ComponentName.Subtitle:
                componentTitle = 'Subtitle Component';
                componentHtml = this.emailComponentsService.Subtitle('Un petit sous-titre pour compléter le titre.');
                break;
            case ComponentName.Summary:
                componentTitle = 'Summary Component';
                componentHtml = this.emailComponentsService.Summary([
                    { label: 'Sous-total', value: '50.000 XOF' },
                    { label: 'Livraison', value: '5.000 XOF' },
                    { label: 'Total', value: '55.000 XOF', isTotal: true },
                ]);
                break;
            case ComponentName.RestaurantInfo:
                componentTitle = 'Restaurant Info Component';
                componentHtml = this.emailComponentsService.RestaurantInfo('Détails du Restaurant', [
                    { label: 'Nom', value: 'Chicken Nation Cocody' },
                    { label: 'Adresse', value: 'Rue des Jardins, Abidjan' },
                    { label: 'Téléphone', value: '+225 07 00 00 00 00' },
                ]);
                break;
            case ComponentName.InfoBox:
                componentTitle = 'Info Box Component';
                componentHtml = this.emailComponentsService.InfoBox('N\'oubliez pas de consulter nos dernières offres spéciales !');
                break;
            case ComponentName.CtaButton:
                componentTitle = 'CTA Button Component';
                componentHtml = this.emailComponentsService.CtaButton('Visiter notre site', 'https://www.chickennation.com', '🚀');
                break;
            case ComponentName.List:
                componentTitle = 'List Component';
                componentHtml = this.emailComponentsService.List(['Article 1', 'Article 2', 'Article 3']);
                break;
            case ComponentName.Divider:
                componentTitle = 'Divider Component';
                componentHtml = this.emailComponentsService.Divider();
                break;
            case ComponentName.Quote:
                componentTitle = 'Quote Component';
                componentHtml = this.emailComponentsService.Quote('La nourriture est notre passion, et le poulet, notre spécialité !', 'L\'Équipe Chicken Nation');
                break;
            case ComponentName.Alert:
                componentTitle = 'Alert Component';
                componentHtml = this.emailComponentsService.Alert('Votre commande a été confirmée avec succès !', 'success');
                break;
            case ComponentName.Columns:
                componentTitle = 'Columns Component';
                componentHtml = this.emailComponentsService.Columns(
                    this.emailComponentsService.Message('Contenu de la colonne de gauche.'),
                    this.emailComponentsService.Message('Contenu de la colonne de droite.'),
                );
                break;
            case ComponentName.SocialLinks:
                componentTitle = 'Social Links Component';
                componentHtml = this.emailComponentsService.SocialLinks([
                    { icon: '📘', url: '#' },
                    { icon: '📷', url: '#' },
                    { icon: '🐦', url: '#' },
                ]);
                break;
            case ComponentName.HeroSection:
                componentTitle = 'Hero Section Component';
                componentHtml = this.emailComponentsService.HeroSection('Bienvenue chez Chicken Nation !', 'Votre destination pour le meilleur poulet.', AssetsImages.banner.url);
                break;
            case ComponentName.GlassCard:
                componentTitle = 'Glassmorphism Card Component';
                componentHtml = this.emailComponentsService.GlassCard(
                    this.emailComponentsService.Message('Cette carte utilise un effet de verre dépoli.'),
                    'Titre de la carte'
                );
                break;
            case ComponentName.Button:
                componentTitle = 'Button Component';
                componentHtml = `
          ${this.emailComponentsService.Button('Bouton Primaire', '#', 'primary')}
          ${this.emailComponentsService.Button('Bouton Secondaire', '#', 'secondary')}
          ${this.emailComponentsService.Button('Bouton Outline', '#', 'outline')}
          <br>
          ${this.emailComponentsService.Button('Petit Bouton', '#', 'primary', 'sm')}
          ${this.emailComponentsService.Button('Grand Bouton', '#', 'primary', 'lg')}
        `;
                break;
            case ComponentName.StatsGrid:
                componentTitle = 'Stats Grid Component';
                componentHtml = this.emailComponentsService.StatsGrid([
                    { label: 'Commandes', value: '1,234', icon: '📦', color: '#ff6b35' },
                    { label: 'Clients satisfaits', value: '99%', icon: '😊', color: '#10b981' },
                    { label: 'Points de fidélité', value: '500', icon: '⭐', color: '#f7931e' },
                ]);
                break;
            case ComponentName.Badge:
                componentTitle = 'Badge Component';
                componentHtml = `
          ${this.emailComponentsService.Badge('Nouveau', 'primary')}
          ${this.emailComponentsService.Badge('Livré', 'success')}
          ${this.emailComponentsService.Badge('En attente', 'warning')}
          ${this.emailComponentsService.Badge('Annulé', 'error')}
        `;
                break;
            case ComponentName.Timeline:
                componentTitle = 'Timeline Component';
                componentHtml = this.emailComponentsService.Timeline([
                    { title: 'Commande passée', description: 'Votre commande a été reçue.', status: 'completed', time: '10:00 AM' },
                    { title: 'Préparation', description: 'Votre repas est en cours de préparation.', status: 'current', time: '10:15 AM' },
                    { title: 'En livraison', description: 'Votre livreur est en route.', status: 'pending', time: '10:45 AM' },
                    { title: 'Livré', description: 'Commande livrée avec succès.', status: 'pending' },
                ]);
                break;
            case ComponentName.PricingCard:
                componentTitle = 'Pricing Card Component';
                componentHtml = this.emailComponentsService.PricingCard(
                    'Plan Standard',
                    '9.99€/mois',
                    ['Accès aux fonctionnalités de base', 'Support par email'],
                    'Choisir ce plan',
                    '#'
                ) + this.emailComponentsService.PricingCard(
                    'Plan Premium',
                    '19.99€/mois',
                    ['Toutes les fonctionnalités', 'Support prioritaire', 'Accès exclusif'],
                    'Choisir ce plan',
                    '#',
                    true // Featured
                );
                break;
            case ComponentName.Table:
                componentTitle = 'Table Component';
                componentHtml = this.emailComponentsService.Table(
                    ['Produit', 'Quantité', 'Prix'],
                    [
                        ['Poulet Braisé', '2', '10.000 XOF'],
                        ['Attiéké', '1', '2.500 XOF'],
                        ['Jus de Bissap', '3', '4.500 XOF'],
                    ]
                );
                break;
            case ComponentName.ToastNotification:
                componentTitle = 'Toast Notification Component';
                componentHtml = `
          ${this.emailComponentsService.ToastNotification('Votre profil a été mis à jour.', 'success')}
          ${this.emailComponentsService.ToastNotification('Attention : solde insuffisant.', 'warning', { text: 'Recharger', url: '#' })}
        `;
                break;
            default:
                componentHtml = `<p style="color: red;">Composant '${componentName}' non trouvé.</p>`;
                componentTitle = 'Composant Inconnu';
        }

        const fullHtml = this.emailTemplateService.generateEmailTemplate({
            content: `<h1>${componentTitle}</h1><hr>${componentHtml}`
        });
        res.send(fullHtml);
    }

    private generateAllComponentsHtml(): string {
        const components = this.emailComponentsService;

        const allHtml = `
      <h1>Prévisualisation de tous les Composants Email</h1>
      <p>Cette page présente tous les composants d'email disponibles avec le thème Chicken Nation.</p>

      <h2>COMPOSANT : HEADER</h2>
      ${components.Header(this.CHICKEN_NATION_LOGO, "", this.CHICKEN_NATION_DESCRIPTION)}
      ${components.Divider()}

      <h2>COMPOSANT : GREETING</h2>
      ${components.Greeting('Bonjour [Nom de l\'utilisateur]', '🎉')}
      ${components.Divider()}

      <h2>COMPOSANT : MESSAGE</h2>
      ${components.Message('Ce message illustre un paragraphe standard utilisé pour le contenu principal de l\'email.')}
      ${components.Divider()}

      <h2>COMPOSANT : TITLE</h2>
      ${components.Title('Titre de section importante', 2)}
      ${components.Divider()}

      <h2>COMPOSANT : SUBTITLE</h2>
      ${components.Subtitle('Un petit sous-titre pour compléter le titre.')}
      ${components.Divider()}

      <h2>COMPOSANT : SUMMARY</h2>
      ${components.Summary([
            { label: 'Article 1', value: '15.000 XOF' },
            { label: 'Article 2', value: '25.000 XOF' },
            { label: 'Frais de livraison', value: '3.000 XOF' },
            { label: 'Total', value: '43.000 XOF', isTotal: true },
        ])}
      ${components.Divider()}

      <h2>COMPOSANT : RESTAURANT INFO</h2>
      ${components.RestaurantInfo('Restaurant le plus proche', [
            { label: 'Nom', value: 'Chicken Nation Plateau' },
            { label: 'Adresse', value: 'Rue du Commerce, Abidjan' },
            { label: 'Horaires', value: '09h00 - 22h00' },
        ])}
      ${components.Divider()}

      <h2>COMPOSANT : INFO BOX</h2>
      ${components.InfoBox('N\'oubliez pas de vérifier vos points de fidélité dans votre application !')}
      ${components.Divider()}

      <h2>COMPOSANT : CTA BUTTON</h2>
      ${components.CtaButton('Suivre votre commande', 'https://www.chickennation.com/tracking', '🚚')}
      ${components.Divider()}

      <h2>COMPOSANT : LIST (Non Ordonnée)</h2>
      ${components.List(['Option A', 'Option B', 'Option C'], false)}
      ${components.Divider()}

      <h2>COMPOSANT : LIST (Ordonnée)</h2>
      ${components.List(['Étape 1', 'Étape 2', 'Étape 3'], true)}
      ${components.Divider()}

      <h2>COMPOSANT : QUOTE</h2>
      ${components.Quote('La meilleure façon de prédire l\'avenir est de le créer.', 'Peter Drucker')}
      ${components.Divider()}

      <h2>COMPOSANT : ALERT (Success)</h2>
      ${components.Alert('Votre paiement a été traité avec succès.', 'success')}
      ${components.Divider()}

      <h2>COMPOSANT : ALERT (Warning)</h2>
      ${components.Alert('Attention : votre abonnement expire bientôt.', 'warning')}
      ${components.Divider()}

      <h2>COMPOSANT : ALERT (Error)</h2>
      ${components.Alert('Une erreur est survenue lors de la soumission de votre formulaire.', 'error')}
      ${components.Divider()}

      <h2>COMPOSANT : COLUMNS</h2>
      ${components.Columns(
            components.Message('Ceci est le contenu de la première colonne. Idéal pour des informations juxtaposées.'),
            components.Message('Ceci est le contenu de la deuxième colonne. Permet une mise en page flexible.')
        )}
      ${components.Divider()}

      <h2>COMPOSANT : HERO SECTION</h2>
      ${components.HeroSection('Offre Spéciale du Jour', 'Ne manquez pas nos réductions exceptionnelles !', AssetsImages.banner.url)}
      ${components.Divider()}

      <h2>COMPOSANT : GLASSMOPHISM CARD</h2>
      ${components.GlassCard(components.Message('Ce contenu est affiché dans une carte avec un effet de verre dépoli, offrant une esthétique moderne.'), 'Détails du Produit')}
      ${components.Divider()}

      <h2>COMPOSANT : BUTTONS</h2>
      ${components.Button('Commander Maintenant', 'https://www.chickennation.com/order', 'primary', 'lg')}
      ${components.Button('En savoir plus', 'https://www.chickennation.com/about', 'secondary')}
      ${components.Button('Annuler', '#', 'outline', 'sm')}
      ${components.Divider()}

      <h2>COMPOSANT : STATS GRID</h2>
      ${components.StatsGrid([
            { label: 'Total des ventes', value: '1.2M XOF', icon: '💰', color: '#ff6b35' },
            { label: 'Commandes traitées', value: '500+', icon: '✅', color: '#10b981' },
            { label: 'Membres inscrits', value: '10K', icon: '👥', color: '#f7931e' },
        ])}
      ${components.Divider()}

      <h2>COMPOSANT : BADGES</h2>
      ${components.Badge('Nouveau', 'primary')}
      ${components.Badge('Actif', 'success')}
      ${components.Badge('Urgent', 'error')}
      ${components.Badge('Info', 'info')}
      ${components.Divider()}

      <h2>COMPOSANT : TIMELINE</h2>
      ${components.Timeline([
            { title: 'Validation de l\'inscription', description: 'Votre compte a été créé.', status: 'completed', time: 'hier' },
            { title: 'Premier achat', description: 'Découvrez nos menus !', status: 'current', time: 'aujourd\'hui' },
            { title: 'Accès au programme fidélité', description: 'Gagnez des points à chaque commande.', status: 'pending' },
        ])}
      ${components.Divider()}

      <h2>COMPOSANT : PRICING CARD (Standard & Featured)</h2>
      <div style="display: flex; gap: 20px; justify-content: center; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 280px; max-width: 45%;">
          ${components.PricingCard(
            'Basique',
            'GRATUIT',
            ['Accès limité', 'Support communautaire'],
            'Commencer',
            '#'
        )}
        </div>
        <div style="flex: 1; min-width: 280px; max-width: 45%;">
          ${components.PricingCard(
            'Pro',
            '19.99€/mois',
            ['Accès complet', 'Support premium', 'Mises à jour prioritaires'],
            'S\'abonner',
            '#',
            true
        )}
        </div>
      </div>
      ${components.Divider()}

      <h2>COMPOSANT : TABLE</h2>
      ${components.Table(
            ['Article', 'Quantité', 'Statut'],
            [
                ['Menu Poulet', '1', 'En cours'],
                ['Boisson', '2', 'Livré'],
                ['Dessert', '1', 'Annulé'],
            ],
            true // Lignes rayées
        )}
      ${components.Divider()}

      <h2>COMPOSANT : TOAST NOTIFICATION</h2>
      ${components.ToastNotification('Article ajouté au panier !', 'success', { text: 'Voir le panier', url: '#' })}
      ${components.ToastNotification('Connexion échouée.', 'error')}
      ${components.Divider()}
      
      <h2>COMPOSANT : SOCIAL LINKS</h2>
      ${components.SocialLinks(this.CHICKEN_NATION_SOCIAL_LINKS)}
      ${components.Divider()}

      <h2>COMPOSANT : FOOTER</h2>
      ${components.Footer(
            this.CHICKEN_NATION_NAME, // Nom de votre entreprise
            this.CHICKEN_NATION_DESCRIPTION, // Description de votre entreprise
            this.CHICKEN_NATION_SUPPORT, // Email de support
            this.CHICKEN_NATION_UNSUBSCRIBE_URL, // URL de désabonnement
            this.CHICKEN_NATION_URL, // URL de votre site web
            this.emailComponentsService.SocialLinks(this.CHICKEN_NATION_SOCIAL_LINKS)
        )}
      ${components.Divider()}
      <div style="height: 50px;"></div>
    `;
        return allHtml;
    }
}