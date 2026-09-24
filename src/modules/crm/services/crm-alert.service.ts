import { Injectable, Logger } from '@nestjs/common';
import { CampaignStatus, CrmEventType, NotificationType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  NotificationRecipient,
  NotificationTemplate,
} from 'src/modules/notifications/interfaces/notifications.interface';
import { NotificationRecipientService } from 'src/modules/notifications/recipients/notification-recipient.service';
import { NotificationsService } from 'src/modules/notifications/services/notifications.service';
import { NotificationsWebSocketService } from 'src/modules/notifications/websockets/notifications-websocket.service';
import { CrmNotificationsTemplate } from '../templates/crm-notifications.template';
import { CrmConfigService } from './crm-config.service';
import { CrmEventsService } from './crm-events.service';

/**
 * Alertes du module Contacts (cahier §8), dans la cloche du backoffice.
 * Chaque destinataire reçoit SA notification : pas d'émission groupée, qui
 * dupliquait les notifications ailleurs dans le backoffice.
 */
@Injectable()
export class CrmAlertService {
  private readonly logger = new Logger(CrmAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: CrmConfigService,
    private readonly events: CrmEventsService,
    private readonly notifications: NotificationsService,
    private readonly recipients: NotificationRecipientService,
    private readonly ws: NotificationsWebSocketService,
  ) {}

  /**
   * Contacts affectés dans une campagne en cours, toujours pas appelés après
   * le délai réglé. Une alerte par couple agent et campagne, une seule fois
   * par affectation : la réaffectation remet le compteur à zéro.
   */
  async alerterNonContactes(): Promise<number> {
    const { alert_delay_hours: heures } = await this.config.lireReglages();
    const lignes = await this.prisma.$queryRaw<
      { member_id: string; contact_id: string; agent_id: string; campaign_id: string; campagne: string; lead_agent_id: string }[]
    >`
      SELECT m.id AS member_id, m.contact_id, m.agent_id, m.campaign_id, c.name AS campagne, c.lead_agent_id
      FROM "CrmCampaignMember" m
      JOIN "ConversionCampaign" c ON c.id = m.campaign_id AND c.status = 'ACTIVE'
      JOIN "CrmContact" p ON p.id = m.contact_id AND p.status <> 'CONVERTI' AND p.entity_status <> 'DELETED'
      WHERE m.released_at IS NULL AND m.agent_id IS NOT NULL AND m.alert_sent_at IS NULL
        AND m.assigned_at < now() - make_interval(hours => ${heures}::int)
        AND (p.last_call_at IS NULL OR p.last_call_at < m.assigned_at)
      LIMIT 5000`;
    if (lignes.length === 0) return 0;

    const groupes = new Map<string, typeof lignes>();
    for (const l of lignes) {
      const cle = `${l.campaign_id}|${l.agent_id}`;
      groupes.set(cle, [...(groupes.get(cle) ?? []), l]);
    }
    for (const groupe of groupes.values()) {
      const { agent_id, lead_agent_id, campagne, campaign_id } = groupe[0];
      const agent = await this.destinataire(agent_id);
      const pilote = lead_agent_id !== agent_id ? await this.destinataire(lead_agent_id) : null;
      await this.envoyer(
        CrmNotificationsTemplate.NON_CONTACTES,
        [agent, pilote].filter((r): r is NotificationRecipient => !!r),
        { nombre: groupe.length, campagne, heures, agent: agent?.name ?? 'agent' },
        { kind: 'crm', campaign_id, agent_id },
      );
    }
    await this.prisma.crmCampaignMember.updateMany({
      where: { id: { in: lignes.map((l) => l.member_id) } },
      data: { alert_sent_at: new Date() },
    });
    await this.events.journaliser(
      lignes.map((l) => ({
        contact_id: l.contact_id,
        type: CrmEventType.ALERTE,
        label: `Toujours pas appelé ${heures} h après son affectation : alerte envoyée`,
        campaign_id: l.campaign_id,
      })),
    );
    return lignes.length;
  }

  async notifierFinCampagne(campagneId: string, indicateurs: { conversions: number; cibles: number }) {
    const c = await this.prisma.crmCampaign.findUnique({
      where: { id: campagneId },
      select: { name: true, status: true, lead_agent_id: true, created_by_id: true },
    });
    if (!c || c.status !== CampaignStatus.COMPLETED) return;
    const ids = [...new Set([c.lead_agent_id, c.created_by_id].filter((v): v is string => !!v))];
    const destinataires = (await Promise.all(ids.map((id) => this.destinataire(id)))).filter(
      (r): r is NotificationRecipient => !!r,
    );
    await this.envoyer(
      CrmNotificationsTemplate.CAMPAGNE_TERMINEE,
      destinataires,
      { campagne: c.name, conversions: indicateurs.conversions, cibles: indicateurs.cibles },
      { kind: 'crm', campaign_id: campagneId },
    );
  }

  private async destinataire(userId: string): Promise<NotificationRecipient | null> {
    try {
      return await this.recipients.getUser(userId);
    } catch {
      return null; // compte désactivé entre-temps
    }
  }

  private async envoyer<T>(
    template: NotificationTemplate<T>,
    destinataires: NotificationRecipient[],
    data: T,
    meta: Record<string, unknown>,
  ) {
    if (destinataires.length === 0) return;
    try {
      const notifs = await this.notifications.sendNotificationToMultiple(
        template,
        { actor: destinataires[0], recipients: destinataires, data, meta },
        NotificationType.SYSTEM,
      );
      notifs.forEach((n, i) => this.ws.emitNotification(n, destinataires[i]));
    } catch (e) {
      this.logger.warn(`Notification du module Contacts non envoyée : ${(e as Error).message}`);
    }
  }
}
