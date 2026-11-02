import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AvisSuiviType, EntityStatus, UserRole } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationRecipient } from 'src/modules/notifications/interfaces/notifications.interface';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { AvisPriveNotificationsTemplate, envoyerCloche } from './avis-prive-notifications.template';
import {
  formatJourHeure,
  prenomAffiche,
  SANS_PRENOM,
  STATUTS_ECHEANCE,
  STORE_INCONNU,
  TEXTE_RETARD,
} from './avis-prive.rules';

/** Avis traités au plus par passage. */
const LOT = 100;

/**
 * ÉCHÉANCE DE RAPPEL DÉPASSÉE (contrat 3.6) : toutes les 5 minutes, les avis
 * dont le rappel promis sous 24 h n'a pas eu lieu (aucun « Joint », toujours
 * À rappeler, En cours ou Injoignable) sonnent UNE fois dans la cloche :
 * l'agent assigné s'il est actif, sinon tout le call center, plus les
 * administrateurs.
 *
 * Deux serveurs : chaque avis est REVENDIQUÉ par une écriture conditionnée
 * (`alerte_retard_at` encore vide) ; le second processus ne trouve plus la
 * ligne dans l'état attendu et n'alerte pas.
 *
 * Désactivable par DISABLE_AVIS_RETARD_CRON=true (banc de test).
 */
@Injectable()
export class AvisPriveRetardTask {
  private readonly logger = new Logger(AvisPriveRetardTask.name);
  private enCours = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly ws: NotificationsWebSocketService,
    private readonly destinataires: NotificationRecipientService,
  ) {}

  @Cron('*/5 * * * *')
  async verifier(): Promise<string[]> {
    if (process.env.DISABLE_AVIS_RETARD_CRON === 'true') return [];
    if (this.enCours) return [];
    this.enCours = true;
    try {
      return await this.passage(new Date());
    } catch (e) {
      this.logger.warn(`Avis en retard : passage interrompu : ${(e as Error)?.message}`);
      return [];
    } finally {
      this.enCours = false;
    }
  }

  /** Un passage, à une heure donnée. Renvoie les avis alertés par CE processus. */
  async passage(maintenant: Date): Promise<string[]> {
    const candidats = await this.prisma.avisPrive.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        alerte_retard_at: null,
        premier_contact_at: null,
        echeance_at: { lt: maintenant },
        statut: { in: STATUTS_ECHEANCE },
      },
      select: {
        id: true,
        prenom: true,
        echeance_at: true,
        agent_id: true,
        restaurant: { select: { name: true } },
        customer: { select: { first_name: true } },
      },
      orderBy: { echeance_at: 'asc' },
      take: LOT,
    });

    const alertes: string[] = [];
    for (const a of candidats) {
      // Revendication sur l'état lu : un « Joint » ou une clôture arrivés
      // entre-temps font aussi passer son tour à l'avis.
      const pris = await this.prisma.avisPrive.updateMany({
        where: {
          id: a.id,
          alerte_retard_at: null,
          premier_contact_at: null,
          statut: { in: STATUTS_ECHEANCE },
          entity_status: { not: EntityStatus.DELETED },
        },
        data: { alerte_retard_at: maintenant },
      });
      if (pris.count === 0) continue;
      alertes.push(a.id);
      try {
        const servis = await envoyerCloche(
          { notifications: this.notifications, ws: this.ws },
          AvisPriveNotificationsTemplate.RETARD,
          await this.qui(a.agent_id),
          {
            nom: prenomAffiche(a.prenom, a.customer?.first_name) ?? SANS_PRENOM,
            store: a.restaurant?.name ?? STORE_INCONNU,
            echeance: formatJourHeure(a.echeance_at as Date),
          },
          { kind: 'avis', avis_id: a.id },
        );
        if (servis > 0) {
          await this.prisma.avisPriveSuivi.create({
            data: { avis_id: a.id, type: AvisSuiviType.SYSTEME, note: TEXTE_RETARD },
          });
        }
      } catch (e) {
        this.logger.error(`Cloche de retard de l'avis ${a.id} non envoyée : ${(e as Error)?.message ?? e}`);
      }
    }
    return alertes;
  }

  /** L'agent assigné s'il est actif, sinon tout le call center ; plus les administrateurs. */
  private async qui(agentId: string | null): Promise<NotificationRecipient[]> {
    let agent: NotificationRecipient | null = null;
    if (agentId) {
      try {
        agent = await this.destinataires.getUser(agentId);
      } catch {
        agent = null; // compte désactivé entre-temps
      }
    }
    const equipe = agent ? [agent] : await this.destinataires.getAllUsersByBackofficeAndRole([UserRole.CALL_CENTER]);
    const admins = await this.destinataires.getAllUsersByBackofficeAndRole([UserRole.ADMIN]);
    return [...equipe, ...admins];
  }
}
