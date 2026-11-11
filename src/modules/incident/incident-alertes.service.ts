import { Injectable, Logger } from '@nestjs/common';
import { IncidentGeste, IncidentGravite, IncidentPole, NotificationType, UserRole } from '@prisma/client';
import { notificationIcons } from 'src/modules/notifications/constantes/notifications.constante';
import {
  NotificationRecipient,
  NotificationTemplate,
} from 'src/modules/notifications/interfaces/notifications.interface';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { ROLES_RESTAURANT_INCIDENT } from 'src/modules/auth/constantes/roles-incidents';
import { LIBELLE_GESTE, extrait, formatJourHeure } from './incident.rules';

/** Événement temps réel : un incident a été créé ou a changé. Sans donnée personnelle. */
export const EVENEMENT_INCIDENT = 'incident:changed';

const EXTRAIT_CLOCHE = 80;

interface DonneesNouveau {
  categorie: string;
  restaurant: string;
  reference: string;
  extrait: string;
  haute: boolean;
}

interface DonneesResolu {
  code: string;
  categorie: string;
  restaurant: string;
  geste: string;
}

interface DonneesRetard {
  code: string;
  categorie: string;
  restaurant: string;
  echeance: string;
}

/**
 * Textes de la cloche. Les données jointes sont `{ kind: 'incident',
 * incident_id }` seulement : une `reference` ou un `order_id` détourneraient
 * le clic vers les commandes.
 */
export class IncidentNotificationsTemplate {
  static NOUVEAU: NotificationTemplate<DonneesNouveau> = {
    title: () => 'Incident à traiter',
    message: ({ data }) =>
      `${data.categorie} · ${data.restaurant} · ${data.reference} : « ${data.extrait} ».` +
      (data.haute ? ' Gravité haute.' : ''),
    icon: () => notificationIcons.waiting.url,
    iconBgColor: () => notificationIcons.waiting.color,
    showChevron: true,
  };

  static RESOLU: NotificationTemplate<DonneesResolu> = {
    title: () => 'Incident résolu : client à informer',
    message: ({ data }) => `${data.code} · ${data.categorie} · ${data.restaurant}. Geste : ${data.geste}.`,
    icon: () => notificationIcons.ok.url,
    iconBgColor: () => notificationIcons.ok.color,
    showChevron: true,
  };

  static RETARD: NotificationTemplate<DonneesRetard> = {
    title: () => 'Incident en retard',
    message: ({ data }) => `${data.code} · ${data.categorie} · ${data.restaurant} : à résoudre avant le ${data.echeance}.`,
    icon: () => notificationIcons.waiting.url,
    iconBgColor: () => notificationIcons.waiting.color,
    showChevron: true,
  };
}

/** Ce qu'une alerte lit d'un incident. */
export interface IncidentAlerte {
  id: string;
  code: string;
  order_id: string;
  restaurant_id: string;
  statut: string;
  pole: IncidentPole;
  gravite: IncidentGravite;
  description: string;
  geste: IncidentGeste | null;
  echeance_at: Date;
  categorie: { nom: string };
  restaurant: { name: string };
  order: { reference: string };
}

/**
 * Cloche et temps réel des incidents. Rien ici ne fait échouer un geste :
 * une alerte ratée est journalisée et avalée, l'incident est déjà écrit.
 */
@Injectable()
export class IncidentAlertesService {
  private readonly logger = new Logger(IncidentAlertesService.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly ws: NotificationsWebSocketService,
    private readonly destinataires: NotificationRecipientService,
    private readonly gateway: AppGateway,
  ) {}

  /** Les écrans ouverts (siège et restaurant de la commande) relisent leurs incidents. */
  diffuser(i: { id: string; order_id: string; restaurant_id: string; statut: string }): void {
    try {
      const charge = { id: i.id, order_id: i.order_id, restaurant_id: i.restaurant_id, statut: i.statut };
      this.gateway.emitToBackoffice(EVENEMENT_INCIDENT, charge);
      this.gateway.emitToRestaurant(i.restaurant_id, EVENEMENT_INCIDENT, charge);
    } catch (erreur) {
      this.logger.warn(`Diffusion de l'incident ${i.id} impossible : ${(erreur as Error)?.message ?? erreur}`);
    }
  }

  /** Qui répond d'un incident : le restaurant de la commande, sinon le call center. */
  private async duPole(i: Pick<IncidentAlerte, 'pole' | 'restaurant_id'>): Promise<NotificationRecipient[]> {
    if (i.pole === IncidentPole.RESTAURANT) {
      return this.destinataires.getAllUsersByRestaurantAndRole(i.restaurant_id, [...ROLES_RESTAURANT_INCIDENT]);
    }
    return this.destinataires.getAllUsersByBackofficeAndRole([UserRole.CALL_CENTER]);
  }

  /** Nouvel incident : son pôle, et les administrateurs quand il est grave. Jamais son auteur. */
  async nouveau(i: IncidentAlerte, auteurId: string | null): Promise<void> {
    try {
      const cibles = await this.duPole(i);
      if (i.gravite === IncidentGravite.HAUTE) {
        cibles.push(...(await this.destinataires.getAllUsersByBackofficeAndRole([UserRole.ADMIN])));
      }
      await this.envoyer(
        IncidentNotificationsTemplate.NOUVEAU,
        cibles,
        {
          categorie: i.categorie.nom,
          restaurant: i.restaurant.name,
          reference: i.order.reference,
          extrait: extrait(i.description, EXTRAIT_CLOCHE),
          haute: i.gravite === IncidentGravite.HAUTE,
        },
        i.id,
        auteurId,
      );
    } catch (erreur) {
      this.logger.error(`Cloche de l'incident ${i.code} non envoyée : ${(erreur as Error)?.message ?? erreur}`);
    }
  }

  /** Incident résolu : le call center rappelle le client et clôture. */
  async resolu(i: IncidentAlerte, auteurId: string | null): Promise<void> {
    try {
      const cibles = await this.destinataires.getAllUsersByBackofficeAndRole([UserRole.CALL_CENTER]);
      await this.envoyer(
        IncidentNotificationsTemplate.RESOLU,
        cibles,
        {
          code: i.code,
          categorie: i.categorie.nom,
          restaurant: i.restaurant.name,
          geste: i.geste ? LIBELLE_GESTE[i.geste].toLowerCase() : LIBELLE_GESTE.AUCUN.toLowerCase(),
        },
        i.id,
        auteurId,
      );
    } catch (erreur) {
      this.logger.error(`Cloche de l'incident résolu ${i.code} non envoyée : ${(erreur as Error)?.message ?? erreur}`);
    }
  }

  /** Délai dépassé : le pôle et les administrateurs. Renvoie le nombre de personnes prévenues. */
  async retard(i: IncidentAlerte): Promise<number> {
    const cibles = [
      ...(await this.duPole(i)),
      ...(await this.destinataires.getAllUsersByBackofficeAndRole([UserRole.ADMIN])),
    ];
    return this.envoyer(
      IncidentNotificationsTemplate.RETARD,
      cibles,
      {
        code: i.code,
        categorie: i.categorie.nom,
        restaurant: i.restaurant.name,
        echeance: formatJourHeure(i.echeance_at),
      },
      i.id,
      null,
    );
  }

  /**
   * Une notification par personne (comptes en double retirés), sans l'auteur
   * du geste, et seulement à ceux qui n'ont pas coupé la cloche.
   */
  private async envoyer<T>(
    template: NotificationTemplate<T>,
    destinataires: NotificationRecipient[],
    data: T,
    incidentId: string,
    saufId: string | null,
  ): Promise<number> {
    const vus = new Set<string>();
    const cibles = destinataires.filter((d) => {
      if (d.id === saufId || vus.has(d.id) || d.in_app_notifications_enabled === false) return false;
      vus.add(d.id);
      return true;
    });
    if (cibles.length === 0) return 0;
    const notifs = await this.notifications.sendNotificationToMultiple(
      template,
      { actor: cibles[0], recipients: cibles, data, meta: { kind: 'incident', incident_id: incidentId } },
      NotificationType.SYSTEM,
    );
    notifs.forEach((n, index) => this.ws.emitNotification(n, cibles[index]));
    return cibles.length;
  }
}
