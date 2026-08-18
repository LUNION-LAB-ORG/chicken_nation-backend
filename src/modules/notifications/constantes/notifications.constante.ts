import { urlPublique } from '../../../common/utils/url-publique.util';


export const notificationIcons = {
    collected: {
        url: urlPublique('uploads/assets/notifications/icons/collected.png'),
        color: "#4CAF50" // Vert pour "collecté/terminé"
    },
    delivery: {
        url: urlPublique('uploads/assets/notifications/icons/delivery.png'),
        color: "#FF5722" // Rouge-orange pour la livraison
    },
    good: {
        url: urlPublique('uploads/assets/notifications/icons/good.png'),
        color: "#FFC107" // Jaune/doré pour "bon/positif"
    },
    joice: {
        url: urlPublique('uploads/assets/notifications/icons/joice.png'),
        color: "#FFEB3B" // Jaune vif pour la joie/bonheur
    },
    ok: {
        url: urlPublique('uploads/assets/notifications/icons/ok.png'),
        color: "#4CAF50" // Vert pour "ok/validé"
    },
    progress: {
        url: urlPublique('uploads/assets/notifications/icons/progress.png'),
        color: "#03A9F4" // Bleu clair pour le progrès
    },
    promotion: {
        url: urlPublique('uploads/assets/notifications/icons/promotion.png'),
        color: "#E91E63" // Rose/magenta pour les promotions
    },
    setting: {
        url: urlPublique('uploads/assets/notifications/icons/setting.png'),
        color: "#607D8B" // Gris-bleu pour les paramètres
    },
    waiting: {
        url: urlPublique('uploads/assets/notifications/icons/waiting.png'),
        color: "#795548" // Marron pour l'attente/temps
    }
}