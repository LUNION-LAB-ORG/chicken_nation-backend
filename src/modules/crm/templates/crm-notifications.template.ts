import { notificationIcons } from 'src/modules/notifications/constantes/notifications.constante';
import { NotificationTemplate } from 'src/modules/notifications/interfaces/notifications.interface';
import { compter } from '../crm.rules';

/** Notifications « cloche » du module Contacts (cahier §8). */
export class CrmNotificationsTemplate {
  static NON_CONTACTES: NotificationTemplate<{ nombre: number; campagne: string; heures: number; agent: string }> = {
    title: () => "Contacts en attente d'appel",
    message: (ctx) => {
      const n = ctx.data.nombre;
      return `${n} contact${n > 1 ? 's' : ''} de « ${ctx.data.campagne} » attend${n > 1 ? 'ent' : ''} un premier appel depuis plus de ${ctx.data.heures} h (${ctx.data.agent}).`;
    },
    icon: () => notificationIcons.waiting.url,
    iconBgColor: () => notificationIcons.waiting.color,
    showChevron: true,
  };

  static CAMPAGNE_TERMINEE: NotificationTemplate<{ campagne: string; conversions: number; cibles: number }> = {
    title: () => 'Campagne terminée',
    message: (ctx) =>
      `« ${ctx.data.campagne} » est terminée : ${compter(ctx.data.conversions, 'conversion')} sur ${compter(ctx.data.cibles, 'contact')}. Le rapport est disponible.`,
    icon: () => notificationIcons.ok.url,
    iconBgColor: () => notificationIcons.ok.color,
    showChevron: true,
  };
}
