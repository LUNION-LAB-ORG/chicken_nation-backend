import { Logger } from '@nestjs/common';
import { NotificationRecipientService } from '../recipients/notification-recipient.service';
import { NotificationsTemplate } from '../templates/notifications.template';
import { NotificationsSenderService } from './notifications-sender.service';

/**
 * Notifications CIBLÉES de la messagerie interne : mention et réponse.
 * Base simulée : aucune écriture réelle.
 */

const utilisateur = (id: string, surcharge: Record<string, unknown> = {}) => ({
  id,
  fullname: `Agent ${id}`,
  email: `${id}@cn.ci`,
  phone: null,
  type: 'RESTAURANT',
  role: 'CAISSIER',
  restaurant_id: 'r1',
  restaurant: { name: 'Zone 4' },
  email_notifications_enabled: true,
  in_app_notifications_enabled: true,
  ...surcharge,
});

function monter() {
  const prisma = {
    user: { findMany: jest.fn(async (_a?: any) => [] as any[]) },
    notification: { updateMany: jest.fn(async (_a?: any) => ({ count: 0 })) },
  };
  const notificationsService = {
    sendNotificationToMultiple: jest.fn(async (_t: any, ctx: any, _type?: any) =>
      ctx.recipients.map((r: any) => ({ id: `n-${r.id}`, user_id: r.id })),
    ),
  };
  const ws = { emitNotification: jest.fn(), emitBulkNotificationRead: jest.fn() };
  const email = { sendMail: jest.fn() };
  const service = new NotificationsSenderService(
    new NotificationRecipientService({} as any),
    notificationsService as any,
    ws as any,
    prisma as any,
    email as any,
  );
  return { service, prisma, notificationsService, ws, email };
}

const params = {
  motif: 'mention' as const,
  userIds: ['u1', 'u2', 'u1', ''],
  auteurNom: 'Jean Yao',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  restaurantId: 'r1',
  libelleConversation: 'Équipe Zone 4',
  extrait: '@Agent u1 on ferme à 23 h',
};

beforeAll(() => Logger.overrideLogger(false));

describe('Gabarits de la messagerie interne', () => {
  const ctx = (data: any) => ({ actor: {} as any, recipients: [], data });

  it('mention : « X vous a mentionné » et « Sujet : extrait »', () => {
    const c = ctx({ auteurNom: 'Jean Yao', libelleConversation: 'Discussion privée', extrait: 'Tu passes ?' });
    expect(NotificationsTemplate.MENTION_STAFF.title(c)).toBe('Jean Yao vous a mentionné');
    expect(NotificationsTemplate.MENTION_STAFF.message(c)).toBe('Discussion privée : Tu passes ?');
  });

  it('réponse : « X a répondu à votre message »', () => {
    const c = ctx({ auteurNom: 'Awa Koné', libelleConversation: 'Équipe', extrait: 'OK' });
    expect(NotificationsTemplate.REPONSE_STAFF.title(c)).toBe('Awa Koné a répondu à votre message');
    expect(NotificationsTemplate.REPONSE_STAFF.message(c)).toBe('Équipe : OK');
  });
});

describe('NotificationsSenderService.notifyStaffMention', () => {
  it('relit les comptes actifs, respecte la préférence, et émet UN PAR UN vers la salle personnelle', async () => {
    const { service, prisma, notificationsService, ws, email } = monter();
    prisma.user.findMany.mockResolvedValueOnce([
      utilisateur('u1'),
      utilisateur('u2', { in_app_notifications_enabled: false, type: 'BACKOFFICE' }),
    ]);

    const envoyees = await service.notifyStaffMention(params);

    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['u1', 'u2'] },
      entity_status: 'ACTIVE',
    });
    expect(envoyees).toBe(1);

    const [gabarit, contexte, type] = notificationsService.sendNotificationToMultiple.mock.calls[0];
    expect(gabarit).toBe(NotificationsTemplate.MENTION_STAFF);
    expect(type).toBe('SYSTEM');
    expect(contexte.recipients.map((r: any) => r.id)).toEqual(['u1']);
    expect(contexte.meta).toEqual({
      kind: 'mention',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      restaurantId: 'r1',
      deep_link: '/gestion?module=inbox&conversation=conv-1&message=msg-1',
    });

    // Émission ciblée : jamais la diffusion de groupe vers un restaurant.
    expect(ws.emitNotification).toHaveBeenCalledTimes(1);
    expect(ws.emitNotification.mock.calls[0]).toHaveLength(2);
    expect(ws.emitNotification.mock.calls[0][1]).toMatchObject({ id: 'u1', type: 'restaurant_user' });

    // Ni courriel ni notification poussée.
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('réponse : gabarit dédié et motif dans les données', async () => {
    const { service, prisma, notificationsService } = monter();
    prisma.user.findMany.mockResolvedValueOnce([utilisateur('u1')]);
    await service.notifyStaffMention({ ...params, motif: 'reponse', userIds: ['u1'] });
    const [gabarit, contexte] = notificationsService.sendNotificationToMultiple.mock.calls[0];
    expect(gabarit).toBe(NotificationsTemplate.REPONSE_STAFF);
    expect(contexte.meta.kind).toBe('reponse');
  });

  it('extrait réduit à 120 caractères, sujet de repli « Discussion privée »', async () => {
    const { service, prisma, notificationsService } = monter();
    prisma.user.findMany.mockResolvedValueOnce([utilisateur('u1')]);
    await service.notifyStaffMention({
      ...params,
      libelleConversation: '',
      extrait: 'mot '.repeat(80),
    });
    const contexte = notificationsService.sendNotificationToMultiple.mock.calls[0][1];
    expect(contexte.data.extrait.length).toBeLessThanOrEqual(120);
    expect(contexte.data.extrait.endsWith('…')).toBe(true);
    expect(contexte.data.libelleConversation).toBe('Discussion privée');
  });

  it("chaque notification part vers la personne qu'elle nomme, même si l'ordre change", async () => {
    const { service, prisma, notificationsService, ws } = monter();
    prisma.user.findMany.mockResolvedValueOnce([utilisateur('u1'), utilisateur('u2')]);
    // Réponse dans l'ordre INVERSE des destinataires.
    notificationsService.sendNotificationToMultiple.mockImplementationOnce(async (_t: any, ctx: any) =>
      [...ctx.recipients].reverse().map((r: any) => ({ id: `n-${r.id}`, user_id: r.id })),
    );
    await expect(service.notifyStaffMention({ ...params, userIds: ['u1', 'u2'] })).resolves.toBe(2);
    for (const [notif, destinataire] of ws.emitNotification.mock.calls) {
      expect(notif.user_id).toBe(destinataire.id);
    }
  });

  it("extrait plein d'emojis : jamais une moitié d'emoji (chaîne refusée par Prisma)", async () => {
    const { service, prisma, notificationsService } = monter();
    prisma.user.findMany.mockResolvedValueOnce([utilisateur('u1')]);
    await service.notifyStaffMention({ ...params, extrait: 'ab' + '👍'.repeat(100) });
    const extrait: string = notificationsService.sendNotificationToMultiple.mock.calls[0][1].data.extrait;
    expect(extrait.length).toBeLessThanOrEqual(120);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(extrait)).toBe(false);
  });

  it('personne à prévenir : aucune lecture, aucun envoi', async () => {
    const { service, prisma, notificationsService } = monter();
    await expect(service.notifyStaffMention({ ...params, userIds: [] })).resolves.toBe(0);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(notificationsService.sendNotificationToMultiple).not.toHaveBeenCalled();
  });
});

describe('NotificationsSenderService : suppression et lecture', () => {
  it("message retiré : l'aperçu des notifications qui le citaient est remplacé", async () => {
    const { service, prisma } = monter();
    prisma.notification.updateMany.mockResolvedValueOnce({ count: 2 });
    await expect(
      service.masquerApercuNotificationsMessage({ messageId: 'msg-1', userIds: ['u1', 'u2', 'u1'] }),
    ).resolves.toBe(2);
    const { where, data } = prisma.notification.updateMany.mock.calls[0][0];
    expect(where).toEqual({
      user_id: { in: ['u1', 'u2'] },
      target: 'USER',
      data: { path: ['messageId'], equals: 'msg-1' },
    });
    expect(data.message).toBe('Ce message a été supprimé');
  });

  it("ouvrir la conversation marque lues SES mentions et réponses, et prévient la cloche", async () => {
    const { service, prisma, ws } = monter();
    prisma.notification.updateMany.mockResolvedValueOnce({ count: 3 });
    await service.marquerNotificationsConversationLues({ userId: 'u1', conversationId: 'conv-1' });
    const { where, data } = prisma.notification.updateMany.mock.calls[0][0];
    expect(where).toEqual({
      user_id: 'u1',
      target: 'USER',
      is_read: false,
      AND: [
        { data: { path: ['conversationId'], equals: 'conv-1' } },
        {
          OR: [
            { data: { path: ['kind'], equals: 'mention' } },
            { data: { path: ['kind'], equals: 'reponse' } },
          ],
        },
      ],
    });
    expect(data.is_read).toBe(true);
    expect(ws.emitBulkNotificationRead).toHaveBeenCalledWith('u1', 'user', 3);
  });

  it('rien à marquer : aucun évènement', async () => {
    const { service, ws } = monter();
    await service.marquerNotificationsConversationLues({ userId: 'u1', conversationId: 'conv-1' });
    expect(ws.emitBulkNotificationRead).not.toHaveBeenCalled();
  });
});
