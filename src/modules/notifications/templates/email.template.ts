import { EmailTemplate } from "../interfaces/notifications.interface";

class EmailTemplates {
    // COMMANDES - Pour le client
    static ORDER_CREATED_CUSTOMER: EmailTemplate = {
        subject: (ctx) => `🛒 Commande ${ctx.data.reference} créée`,
        content: (ctx) => `
            <div class="greeting">Bonjour ${ctx.actor.name} ! 🎉</div>
            
            <div class="message">
                Votre commande a été créée avec succès et est en cours de préparation.
            </div>
            
            <div class="order-summary">
                <h3>📋 Résumé de votre commande ${ctx.data.reference}</h3>
                ${ctx.data.items?.map(item => `
                    <div class="order-item">
                        <span>${item.name} x${item.quantity}</span>
                        <span>${item.price} XOF</span>
                    </div>
                `).join('') || ''}
                <div class="order-item">
                    <span><strong>Total</strong></span>
                    <span><strong>${ctx.data.amount} XOF</strong></span>
                </div>
            </div>
            
            ${ctx.data.restaurant_name ? `
            <div class="restaurant-info">
                <h4>📍 Restaurant</h4>
                <p><strong>${ctx.data.restaurant_name}</strong></p>
                ${ctx.data.restaurant_address ? `<p>${ctx.data.restaurant_address}</p>` : ''}
                ${ctx.data.estimated_time ? `<p>⏰ Temps estimé: ${ctx.data.estimated_time}</p>` : ''}
            </div>
            ` : ''}
            
            <div class="info-box">
                <p><strong>💡 Bon à savoir :</strong> Vous recevrez une notification dès que votre commande sera prête !</p>
            </div>
        `
    };

    // COMMANDES - Pour le restaurant
    static ORDER_CREATED_RESTAURANT: EmailTemplate = {
        subject: (ctx) => `📋 Nouvelle commande ${ctx.data.reference}`,
        content: (ctx) => `
            <div class="greeting">Nouvelle commande reçue ! 📋</div>
            
            <div class="message">
                Une nouvelle commande de ${ctx.actor.name || 'Client'} vient d'être passée.
            </div>
            
            <div class="order-summary">
                <h3>Commande ${ctx.data.reference}</h3>
                <div class="info-item">
                    <span>Client:</span>
                    <span><strong>${ctx.actor.name}</strong></span>
                </div>
                <div class="info-item">
                    <span>Montant:</span>
                    <span><strong>${ctx.data.amount} XOF</strong></span>
                </div>
                ${ctx.data.payment_method ? `
                <div class="info-item">
                    <span>Paiement:</span>
                    <span>${ctx.data.payment_method}</span>
                </div>
                ` : ''}
            </div>
            
            <div class="info-box">
                <p><strong>⚡ Action requise :</strong> Veuillez confirmer la commande dans votre interface de gestion.</p>
            </div>
        `
    };

    // PAIEMENT - Pour le client
    static PAYMENT_SUCCESS_CUSTOMER: EmailTemplate = {
        subject: (ctx) => `💳 Paiement confirmé - Commande ${ctx.data.reference}`,
        content: (ctx) => `
            <div class="greeting">Paiement confirmé ! 💳</div>
            
            <div class="message">
                Votre paiement a été confirmé avec succès pour votre commande ${ctx.data.reference}.
            </div>
            
            <div class="info-card">
                <h3>💰 Détails du paiement</h3>
                <div class="info-item">
                    <span>Montant:</span>
                    <span><strong>${ctx.data.amount} XOF</strong></span>
                </div>
                <div class="info-item">
                    <span>Méthode:</span>
                    <span>${ctx.data.payment_method || 'Non spécifiée'}</span>
                </div>
                <div class="info-item">
                    <span>Statut:</span>
                    <span style="color: #28a745;"><strong>Confirmé ✅</strong></span>
                </div>
            </div>
            
            <div class="info-box">
                <p><strong>🍗 Prochaine étape :</strong> Votre commande est maintenant en préparation !</p>
            </div>
        `
    };

    // FIDÉLITÉ - Points gagnés
    static LOYALTY_POINTS_EARNED: EmailTemplate = {
        subject: (ctx) => `🎉 Vous avez gagné ${ctx.data.points} points !`,
        content: (ctx) => `
            <div class="greeting">Félicitations ${ctx.actor.name} ! 🎉</div>
            
            <div class="message">
                Vous avez gagné des points de fidélité avec votre dernière commande !
            </div>
            
            <div class="info-card">
                <h3>💎 Vos points de fidélité</h3>
                <div class="info-item">
                    <span>Points gagnés:</span>
                    <span><strong>+${ctx.data.points} points</strong></span>
                </div>
                <div class="info-item">
                    <span>Total actuel:</span>
                    <span><strong>${ctx.data.total_points} points</strong></span>
                </div>
                ${ctx.actor.loyalty_level ? `
                <div class="info-item">
                    <span>Votre niveau:</span>
                    <span><span class="loyalty-badge">${ctx.actor.loyalty_level}</span></span>
                </div>
                ` : ''}
            </div>
            
            <div class="info-box">
                <p><strong>💡 Astuce :</strong> Utilisez vos points lors de votre prochaine commande pour obtenir des réductions !</p>
            </div>
        `
    };

    // FIDÉLITÉ - Changement de niveau
    static LOYALTY_LEVEL_UP: EmailTemplate = {
        subject: (ctx) => `🏆 Nouveau niveau atteint : ${ctx.data.new_level} !`,
        content: (ctx) => `
            <div class="greeting">Incroyable ${ctx.actor.name} ! 🏆</div>
            
            <div class="message">
                Vous avez atteint un nouveau niveau de fidélité ! Votre engagement est récompensé.
            </div>
            
            <div class="info-card">
                <h3>🎖️ Nouveau niveau débloqué</h3>
                <div class="info-item">
                    <span>Nouveau niveau:</span>
                    <span><span class="loyalty-badge">${ctx.data.new_level}</span></span>
                </div>
                <div class="info-item">
                    <span>Bonus de niveau:</span>
                    <span><strong>+${ctx.data.bonus_points} points</strong></span>
                </div>
                <div class="info-item">
                    <span>Total points:</span>
                    <span><strong>${ctx.data.total_points} points</strong></span>
                </div>
            </div>
            
            <div class="info-box">
                <p><strong>🎁 Avantages débloqués :</strong> Découvrez vos nouveaux privilèges dans l'application !</p>
            </div>
        `
    };

    // PROMOTIONS
    static PROMOTION_AVAILABLE: EmailTemplate = {
        subject: (ctx) => `🎉 Nouvelle promotion : ${ctx.data.promotion_title}`,
        content: (ctx) => `
            <div class="greeting">Promotion spéciale pour vous ! 🎊</div>
            
            <div class="message">
                Une nouvelle promotion vient d'être lancée et elle vous attend !
            </div>
            
            <div class="info-card">
                <h3>🎁 ${ctx.data.promotion_title}</h3>
                <p style="font-size: 16px; margin-bottom: 15px;">${ctx.data.promotion_description}</p>
                ${ctx.data.discount_amount ? `
                <div class="info-item">
                    <span>Réduction:</span>
                    <span><strong>${ctx.data.discount_amount} XOF</strong></span>
                </div>
                ` : ''}
                ${ctx.data.valid_until ? `
                <div class="info-item">
                    <span>Valide jusqu'au:</span>
                    <span>${ctx.data.valid_until}</span>
                </div>
                ` : ''}
            </div>
            
            <div style="text-align: center;">
                <a href="${ctx.data.promotion_url || '#'}" class="cta-button">
                    Profiter de l'offre ! 🛒
                </a>
            </div>
        `
    };

    // BIENVENUE
    static WELCOME_NEW_CUSTOMER: EmailTemplate = {
        subject: (ctx) => `🎉 Bienvenue chez ${ctx.data.brand_name || 'Chicken Nation'} !`,
        content: (ctx) => `
            <div class="greeting">Bienvenue ${ctx.actor.name} ! 🎊</div>
            
            <div class="message">
                Nous sommes ravis de vous accueillir dans la famille Chicken Nation ! 
                Votre aventure gourmande commence maintenant.
            </div>
            
            ${ctx.data.welcome_points ? `
            <div class="info-card">
                <h3>🎁 Cadeau de bienvenue</h3>
                <div class="info-item">
                    <span>Points offerts:</span>
                    <span><strong>${ctx.data.welcome_points} points</strong></span>
                </div>
                <p style="margin-top: 15px; font-size: 14px; color: #666;">
                    Utilisez ces points lors de votre première commande !
                </p>
            </div>
            ` : ''}
            
            <div style="text-align: center;">
                <a href="${ctx.data.menu_url || '#'}" class="cta-button">
                    Découvrir notre menu 🍗
                </a>
            </div>
            
            <div class="info-box">
                <p><strong>💡 Le saviez-vous ?</strong> Chaque commande vous fait gagner des points de fidélité !</p>
            </div>
        `
    };

    // COMMANDE ANNULÉE
    static ORDER_CANCELLED_BY_RESTAURANT: EmailTemplate = {
        subject: (ctx) => `❌ Commande ${ctx.data.reference} annulée`,
        content: (ctx) => `
            <div class="greeting">Information importante</div>
            
            <div class="message">
                Nous sommes désolés de vous informer que votre commande ${ctx.data.reference} 
                a dû être annulée par le restaurant.
            </div>
            
            <div class="info-card">
                <h3>📝 Détails de l'annulation</h3>
                <div class="info-item">
                    <span>Commande:</span>
                    <span><strong>${ctx.data.reference}</strong></span>
                </div>
                <div class="info-item">
                    <span>Montant:</span>
                    <span><strong>${ctx.data.amount} XOF</strong></span>
                </div>
                <div class="info-item">
                    <span>Raison:</span>
                    <span>${ctx.data.reason || 'Non spécifiée'}</span>
                </div>
            </div>
            
            <div class="info-box">
                <p><strong>💳 Remboursement :</strong> Si un paiement a été effectué, vous serez remboursé sous 3-5 jours ouvrables.</p>
            </div>
            
            <div style="text-align: center;">
                <a href="${ctx.data.reorder_url || '#'}" class="cta-button">
                    Commander à nouveau 🔄
                </a>
            </div>
        `
    };

    // Template par défaut
    static DEFAULT: EmailTemplate = {
        subject: (ctx) => `Notification ${ctx.data.brand_name || 'Chicken Nation'}`,
        content: (ctx) => `
            <div class="greeting">Bonjour ${ctx.actor.name} !</div>
            
            <div class="message">
                Nous vous contactons concernant votre compte.
            </div>
            
            <div class="info-box">
                <p>Pour plus d'informations, n'hésitez pas à nous contacter.</p>
            </div>
        `
    };
}
