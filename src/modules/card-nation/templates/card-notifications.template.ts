import { notificationIcons } from 'src/modules/notifications/constantes/notifications.constante';
import { NotificationTemplate } from 'src/modules/notifications/interfaces/notifications.interface';

/**
 * Templates de notifications « cloche » pour la Carte de la Nation (Phase 3).
 * Le push Expo est envoyé séparément (cf. CardNotificationService).
 */
export class CardNotificationsTemplate {
  // Demande de carte reçue (accusé de réception — AVANT validation backoffice)
  static CARD_REQUEST_RECEIVED: NotificationTemplate<{ first_name?: string | null; level?: string | null }> = {
    title: () => '📨 Demande de carte reçue',
    message: (ctx) =>
      `Merci ${ctx.data.first_name ?? 'cher client'} ! Ta demande de Carte de la Nation est bien reçue, on la valide très vite.`,
    icon: () => notificationIcons.joice.url,
    iconBgColor: () => notificationIcons.joice.color,
    showChevron: true,
  };

  // Carte émise / prête
  static CARD_READY: NotificationTemplate<{ first_name?: string | null; level?: string | null }> = {
    title: () => '🎉 Votre Carte de la Nation est prête !',
    message: (ctx) =>
      `Félicitations ${ctx.data.first_name ?? 'cher client'} ! Votre Carte de la Nation${ctx.data.level ? ` (niveau ${ctx.data.level})` : ''
      } vient d'être émise. Retrouvez-la dans l'application.`,
    icon: () => notificationIcons.joice.url,
    iconBgColor: () => notificationIcons.joice.color,
    showChevron: true,
  };

  // Carte mise à jour suite à un changement de niveau
  static CARD_LEVEL_CHANGED: NotificationTemplate<{ first_name?: string | null; level?: string | null }> = {
    title: (ctx) => `✨ Votre carte passe au niveau ${ctx.data.level ?? ''} !`,
    message: (ctx) =>
      `Bravo ${ctx.data.first_name ?? 'cher client'} ! Votre Carte de la Nation a été mise à jour au niveau ${ctx.data.level ?? ''
      }. Son nouveau design vous attend dans l'application.`,
    icon: () => notificationIcons.good.url,
    iconBgColor: () => '#FFD700',
    showChevron: true,
  };
}
