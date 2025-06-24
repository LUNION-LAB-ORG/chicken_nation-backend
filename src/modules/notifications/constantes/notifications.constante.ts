import { join } from 'path';


export const notificationIcons = {
    collected: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/collected.png'),
        color: "#4CAF50" // Vert pour "collecté/terminé"
    },
    delivery: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/delivery.png'),
        color: "#FF5722" // Rouge-orange pour la livraison
    },
    good: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/good.png'),
        color: "#FFC107" // Jaune/doré pour "bon/positif"
    },
    joice: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/joice.png'),
        color: "#FFEB3B" // Jaune vif pour la joie/bonheur
    },
    ok: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/ok.png'),
        color: "#4CAF50" // Vert pour "ok/validé"
    },
    progress: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/progress.png'),
        color: "#03A9F4" // Bleu clair pour le progrès
    },
    promotion: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/promotion.png'),
        color: "#E91E63" // Rose/magenta pour les promotions
    },
    setting: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/setting.png'),
        color: "#607D8B" // Gris-bleu pour les paramètres
    },
    waiting: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/notifications/icons/waiting.png'),
        color: "#795548" // Marron pour l'attente/temps
    }
}