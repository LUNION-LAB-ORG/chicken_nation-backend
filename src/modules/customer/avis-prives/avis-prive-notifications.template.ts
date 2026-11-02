import { NotificationType } from '@prisma/client';
import { notificationIcons } from 'src/modules/notifications/constantes/notifications.constante';
import {
  NotificationRecipient,
  NotificationTemplate,
} from 'src/modules/notifications/interfaces/notifications.interface';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';

export interface DonneesClochePasContent {
  /** Prénom affiché, ou « Sans prénom ». */
  nom: string;
  /** Restaurant, ou « Store inconnu ». */
  store: string;
  /** 80 caractères du commentaire, puis « … ». */
  extrait: string;
  /** `03/11 à 08:42`, ou `null` sans accord de rappel. */
  echeance: string | null;
}

export interface DonneesClocheRetard {
  nom: string;
  store: string;
  echeance: string;
}

/**
 * Notifications « cloche » des retours privés (« Ton avis compte »). Les
 * données jointes sont `{ kind: 'avis', avis_id }` seulement : une
 * `reference`, un `order_id` ou un `search` détourneraient le clic vers les
 * commandes ou les clients.
 */
export class AvisPriveNotificationsTemplate {
  static PAS_CONTENT: NotificationTemplate<DonneesClochePasContent> = {
    title: () => 'Client pas content',
    message: ({ data }) =>
      `${data.nom} · ${data.store} : « ${data.extrait} ». ` +
      (data.echeance ? `À rappeler avant le ${data.echeance}.` : "Pas d'accord de rappel."),
    icon: () => notificationIcons.waiting.url,
    iconBgColor: () => notificationIcons.waiting.color,
    showChevron: true,
  };

  static RETARD: NotificationTemplate<DonneesClocheRetard> = {
    title: () => 'Avis en retard',
    message: ({ data }) => `${data.nom} · ${data.store} : rappel promis avant le ${data.echeance}.`,
    icon: () => notificationIcons.waiting.url,
    iconBgColor: () => notificationIcons.waiting.color,
    showChevron: true,
  };
}

/** Ce qu'il faut pour poser une notification dans la cloche et la pousser en direct. */
export interface ServicesCloche {
  notifications: Pick<NotificationsService, 'sendNotificationToMultiple'>;
  ws: Pick<NotificationsWebSocketService, 'emitNotification'>;
}

/**
 * Une notification par destinataire (sans émission groupée, qui la
 * dupliquait ailleurs dans le back-office), comptes en double retirés, et
 * seulement à ceux qui n'ont pas coupé les notifications dans le back-office.
 * Renvoie le nombre de destinataires servis. Une erreur remonte : l'appelant
 * la journalise et l'avale.
 */
export async function envoyerCloche<T>(
  services: ServicesCloche,
  template: NotificationTemplate<T>,
  destinataires: NotificationRecipient[],
  data: T,
  meta: { kind: 'avis'; avis_id: string },
): Promise<number> {
  const vus = new Set<string>();
  const cibles = destinataires.filter((d) => {
    if (vus.has(d.id) || d.in_app_notifications_enabled === false) return false;
    vus.add(d.id);
    return true;
  });
  if (cibles.length === 0) return 0;
  const notifs = await services.notifications.sendNotificationToMultiple(
    template,
    { actor: cibles[0], recipients: cibles, data, meta },
    NotificationType.SYSTEM,
  );
  notifs.forEach((n, i) => services.ws.emitNotification(n, cibles[i]));
  return cibles.length;
}
