/**
 * Alerte « campagne suspendue depuis N jours » (analyse du 02/11, problème 7) :
 * une seule alerte par suspension, même avec deux serveurs, à la direction et
 * au pilote sans doublon.
 */
jest.mock('src/database/services/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('src/modules/notifications/services/notifications.service', () => ({ NotificationsService: class {} }));
jest.mock('src/modules/notifications/recipients/notification-recipient.service', () => ({ NotificationRecipientService: class {} }));
jest.mock('src/modules/notifications/websockets/notifications-websocket.service', () => ({ NotificationsWebSocketService: class {} }));

import { CrmNotificationsTemplate } from '../templates/crm-notifications.template';
import { CrmAccessService } from './crm-access.service';
import { CrmAlertService } from './crm-alert.service';
import { campagne, monterBase, utilisateur } from './crm-base-memoire.fixture';

const JOUR = 86_400_000;
const ilYA = (jours: number) => new Date(Date.now() - jours * JOUR);

const DIRECTION = utilisateur('u-direction', 'Direction', 'ADMIN');
const PILOTE = utilisateur('u-pilote', 'Pilote Paul', 'CALL_CENTER');

function monter(campagnes: Record<string, unknown>[], jours = 3) {
  const base = monterBase({ users: [DIRECTION, PILOTE], campagnes });
  const destinataire = (u: Record<string, any>) => ({ id: u.id as string, name: u.fullname as string, type: 'user' });
  const recipients = {
    getAllUsersByBackofficeAndRole: jest.fn(async (roles: string[]) =>
      [DIRECTION, PILOTE].filter((u) => roles.includes(u.role)).map(destinataire),
    ),
    getUser: jest.fn(async (id: string) => destinataire([DIRECTION, PILOTE].find((u) => u.id === id)!)),
  };
  const notifications = { sendNotificationToMultiple: jest.fn(async (_t: unknown, ctx: { recipients: unknown[] }) => ctx.recipients.map(() => ({}))) };
  const config = { lireReglages: async () => ({ suspension_alert_days: jours }) };
  const service = new CrmAlertService(
    base.prisma,
    config as any,
    {} as any,
    notifications as any,
    recipients as any,
    { emitNotification: jest.fn() } as any,
    new CrmAccessService(base.prisma),
  );
  return { ...base, service, notifications, recipients };
}

describe('alerterSuspensions', () => {
  it('alerte la direction et le pilote une seule fois, passé le délai réglé', async () => {
    const m = monter([
      campagne('LONGUE', { name: 'Inscrits septembre', status: 'SUSPENDED', suspended_at: ilYA(4), lead_agent_id: PILOTE.id }),
      campagne('RECENTE', { status: 'SUSPENDED', suspended_at: ilYA(1), lead_agent_id: PILOTE.id }),
      campagne('ACTIVE', { status: 'ACTIVE', lead_agent_id: PILOTE.id }),
    ]);
    expect(await m.service.alerterSuspensions()).toBe(1);
    expect(m.notifications.sendNotificationToMultiple).toHaveBeenCalledTimes(1);
    const [gabarit, ctx] = m.notifications.sendNotificationToMultiple.mock.calls[0] as unknown as [
      typeof CrmNotificationsTemplate.CAMPAGNE_SUSPENDUE,
      { recipients: { id: string }[]; data: { campagne: string; jours: number }; meta: unknown },
    ];
    expect(gabarit).toBe(CrmNotificationsTemplate.CAMPAGNE_SUSPENDUE);
    expect(ctx.recipients.map((r) => r.id)).toEqual([DIRECTION.id, PILOTE.id]);
    expect(ctx.meta).toEqual({ kind: 'crm', campaign_id: 'LONGUE' });
    expect(gabarit.message({ data: ctx.data } as any)).toBe(
      '« Inscrits septembre » est suspendue depuis 4 jours : ses contacts ne sont dans aucune file. Reprenez-la ou terminez-la.',
    );
    expect(m.campagnes[0].suspension_alert_sent_at).toBeInstanceOf(Date);

    // Heure suivante, ou second serveur : plus rien.
    expect(await m.service.alerterSuspensions()).toBe(0);
    expect(m.notifications.sendNotificationToMultiple).toHaveBeenCalledTimes(1);
  });

  it('claim : un autre serveur a déjà alerté entre la lecture et l’écriture, rien n’est envoyé', async () => {
    const m = monter([campagne('C1', { status: 'SUSPENDED', suspended_at: ilYA(5), lead_agent_id: PILOTE.id })]);
    const ecrire = m.prisma.crmCampaign.updateMany;
    m.prisma.crmCampaign.updateMany = jest.fn(async () => ({ count: 0 }));
    expect(await m.service.alerterSuspensions()).toBe(0);
    expect(m.notifications.sendNotificationToMultiple).not.toHaveBeenCalled();
    m.prisma.crmCampaign.updateMany = ecrire;
  });

  it('le pilote de la direction n’est prévenu qu’une fois ; le délai suit le réglage', async () => {
    const m = monter([campagne('C1', { status: 'SUSPENDED', suspended_at: ilYA(4), lead_agent_id: DIRECTION.id })], 5);
    expect(await m.service.alerterSuspensions()).toBe(0);
    const m2 = monter([campagne('C1', { status: 'SUSPENDED', suspended_at: ilYA(4), lead_agent_id: DIRECTION.id })], 3);
    expect(await m2.service.alerterSuspensions()).toBe(1);
    const ctx = m2.notifications.sendNotificationToMultiple.mock.calls[0][1] as unknown as { recipients: { id: string }[] };
    expect(ctx.recipients.map((r) => r.id)).toEqual([DIRECTION.id]);
  });
});
