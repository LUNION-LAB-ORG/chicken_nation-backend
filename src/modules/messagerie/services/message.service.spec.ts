import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { MessageService } from './message.service';

/**
 * Réponse à un message précis, mentions et position : ce que le service
 * décide, avec une base simulée. Aucune base, aucun serveur.
 */

const U = {
  auteur: '11111111-1111-4111-8111-111111111111',
  awa: '22222222-2222-4222-8222-222222222222',
  cuisine: '33333333-3333-4333-8333-333333333333',
  koffi: '44444444-4444-4444-8444-444444444444',
};
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const M1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const M2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const date = new Date('2026-09-26T18:26:00Z');

const staff = { id: U.auteur, role: 'ADMIN', type: 'BACKOFFICE', fullname: 'Jean Yao', email: 'j@cn.ci' };
const client = { id: 'client-1', first_name: 'Yao', last_name: 'Kouassi' };
const req = (user: object) => ({ user }) as unknown as Request;

const flush = () => new Promise((r) => setImmediate(r));

beforeAll(() => Logger.overrideLogger(false));

type Brut = Record<string, any>;

/** Messages existants, par identifiant. */
function originaux(): Record<string, Brut> {
  return {
    [M1]: {
      id: M1,
      conversationId: CONV,
      body: 'On ferme à 23 h ce soir',
      meta: {},
      deletedAt: null,
      createdAt: date,
      broadcastId: null,
      authorUserId: U.awa,
      authorUser: { id: U.awa, fullname: 'Awa Koné' },
      authorCustomer: null,
    },
    [M2]: {
      id: M2,
      conversationId: CONV,
      body: 'Stock de frites bas',
      meta: {},
      deletedAt: null,
      createdAt: date,
      broadcastId: null,
      authorUserId: U.koffi,
      authorUser: { id: U.koffi, fullname: 'Koffi Yapi' },
      authorCustomer: null,
    },
  };
}

/** Membres de la conversation interne. */
const membres: Record<string, { id: string; fullname: string; role: string; entity_status: string }> = {
  [U.auteur]: { id: U.auteur, fullname: 'Jean Yao', role: 'ADMIN', entity_status: 'ACTIVE' },
  [U.awa]: { id: U.awa, fullname: 'Awa Koné', role: 'CAISSIER', entity_status: 'ACTIVE' },
  [U.cuisine]: { id: U.cuisine, fullname: 'Ali Cuisine', role: 'CUISINE', entity_status: 'ACTIVE' },
  [U.koffi]: { id: U.koffi, fullname: 'Koffi Yapi', role: 'MANAGER', entity_status: 'ACTIVE' },
};

function monter(conversation: Brut = { id: CONV, customerId: null, restaurantId: 'r1', subject: 'Équipe Zone 4' }) {
  const existants = originaux();
  const crees: Brut[] = [];
  let n = 0;

  const prisma = {
    message: {
      findFirst: jest.fn(async (args: Brut) => {
        // Vérification du message cité / de la cible de position.
        if (args.select && args.where?.id) {
          const m = existants[args.where.id];
          if (!m || m.conversationId !== args.where.conversationId) return null;
          return {
            id: m.id,
            deletedAt: m.deletedAt,
            authorUserId: m.authorUserId,
            createdAt: m.createdAt,
          };
        }
        // Garde anti-doublon : même texte, même auteur, même message cité.
        const w = args.where;
        return (
          crees.find(
            (c) =>
              c.body === w.body &&
              c.authorUserId === (w.authorUserId ?? null) &&
              c.authorCustomerId === (w.authorCustomerId ?? null) &&
              c.replyToId === w.replyToId,
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: Brut) => {
        n += 1;
        const cite = data.replyToId ? existants[data.replyToId] : null;
        const ligne = {
          id: `nouveau-${n}`,
          conversationId: data.conversationId,
          body: data.body,
          meta: data.meta,
          isRead: false,
          readAt: null,
          deletedAt: null,
          createdAt: date,
          updatedAt: date,
          authorUserId: data.authorUserId,
          authorCustomerId: data.authorCustomerId,
          authorUser: data.authorUserId ? { id: data.authorUserId, fullname: 'Jean Yao', email: 'j@cn.ci' } : null,
          authorCustomer: data.authorCustomerId ? { id: data.authorCustomerId, first_name: 'Yao', last_name: 'Kouassi' } : null,
          replyToId: data.replyToId,
          replyTo: cite,
          mentions: (data.mentions?.create ?? []).map((m: Brut) => ({ userId: m.userId, libelle: m.libelle })),
          conversation: {
            id: conversation.id,
            customerId: conversation.customerId,
            restaurantId: conversation.restaurantId,
            users: Object.keys(membres).map((userId) => ({ userId })),
          },
        };
        crees.push(ligne);
        return ligne;
      }),
      count: jest.fn(async (_args?: Brut) => 0),
      findMany: jest.fn(async (_args?: Brut) => [] as Brut[]),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    conversation: {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(),
    },
    conversationUser: {
      findMany: jest.fn(async (args: Brut) =>
        (args.where.userId.in as string[])
          .filter((id) => membres[id])
          .map((id) => ({ user: membres[id] })),
      ),
      findUnique: jest.fn(async (args: Brut) => {
        const id = args.where.conversationId_userId.userId;
        return membres[id] ? { user: membres[id] } : null;
      }),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    user: { findFirst: jest.fn() },
  };

  const conversations = { getConversationById: jest.fn(async () => conversation) };
  const sockets = { emitNewMessage: jest.fn(), emitMessageSupprime: jest.fn(), emitMessagesRead: jest.fn() };
  const notifications = {
    notifyStaffMention: jest.fn(async (_p: Brut) => 1),
    notifyStaffNewMessage: jest.fn(async () => undefined),
    masquerApercuNotificationsMessage: jest.fn(async () => 0),
    marquerNotificationsConversationLues: jest.fn(async () => 0),
  };
  const audit = { record: jest.fn() };

  const service = new MessageService(
    conversations as any,
    prisma as any,
    sockets as any,
    {} as any,
    { sendPushNotifications: jest.fn() } as any,
    notifications as any,
    audit as any,
  );

  return { service, prisma, conversations, sockets, notifications, audit, crees };
}

describe('MessageService.createMessage : réponse à un message précis', () => {
  it("message cité d'une autre conversation : 404, rien n'est écrit", async () => {
    const { service, prisma } = monter();
    // M1 vit dans une AUTRE conversation : la recherche bornée à CONV échoue.
    prisma.message.findFirst.mockImplementationOnce(async (args: Brut) => {
      expect(args.where).toEqual({ id: M1, conversationId: CONV });
      return null;
    });
    await expect(
      service.createMessage(req(staff), CONV, { body: 'Vu', replyToId: M1 }),
    ).rejects.toThrow(new NotFoundException('Message cité introuvable'));
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('original supprimé : 400', async () => {
    const { service, prisma } = monter();
    prisma.message.findFirst.mockResolvedValueOnce({ id: M1, deletedAt: new Date(), authorUserId: U.awa });
    await expect(
      service.createMessage(req(staff), CONV, { body: 'Vu', replyToId: M1 }),
    ).rejects.toThrow(new BadRequestException('Impossible de répondre à un message supprimé'));
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('la réponse est écrite avec replyToId et renvoie la citation', async () => {
    const { service, prisma } = monter();
    const r = await service.createMessage(req(staff), CONV, { body: 'Bien noté', replyToId: M1 });
    expect(prisma.message.create.mock.calls[0][0].data.replyToId).toBe(M1);
    expect(r.replyTo).toMatchObject({
      id: M1,
      deleted: false,
      kind: 'text',
      excerpt: 'On ferme à 23 h ce soir',
      author: { kind: 'user', id: U.awa, name: 'Awa Koné' },
    });
  });

  it('anti-doublon : deux « OK » en réponse à deux messages différents font deux messages', async () => {
    const { service, prisma } = monter();
    await service.createMessage(req(staff), CONV, { body: 'OK', replyToId: M1 });
    await service.createMessage(req(staff), CONV, { body: 'OK', replyToId: M2 });
    expect(prisma.message.create).toHaveBeenCalledTimes(2);

    // La garde compare bien le message cité.
    const gardes = prisma.message.findFirst.mock.calls
      .map((c) => c[0] as Brut)
      .filter((a) => a.where?.body === 'OK');
    expect(gardes.map((g) => g.where.replyToId)).toEqual([M1, M2]);
  });

  it('anti-doublon : le même « OK » au même message dans la foulée reste un seul message', async () => {
    const { service, prisma, sockets } = monter();
    const a = await service.createMessage(req(staff), CONV, { body: 'OK', replyToId: M1 });
    const b = await service.createMessage(req(staff), CONV, { body: 'OK', replyToId: M1 });
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(b.id).toBe(a.id);
    expect(sockets.emitNewMessage).toHaveBeenCalledTimes(1);
  });

  it('anti-doublon : un « OK » sans citation reste distinct d’un « OK » en réponse', async () => {
    const { service, prisma } = monter();
    await service.createMessage(req(staff), CONV, { body: 'OK', replyToId: M1 });
    await service.createMessage(req(staff), CONV, { body: 'OK' });
    expect(prisma.message.create).toHaveBeenCalledTimes(2);
    expect(prisma.message.create.mock.calls[1][0].data.replyToId).toBeNull();
  });
});

describe('MessageService.createMessage : mentions et notifications', () => {
  it('conversation avec un client : mentions refusées (400)', async () => {
    const { service, prisma } = monter({ id: CONV, customerId: 'client-1', restaurantId: 'r1', subject: null });
    await expect(
      service.createMessage(req(staff), CONV, { body: '@Awa Koné', mentionUserIds: [U.awa] }),
    ).rejects.toThrow('Les mentions sont réservées aux conversations internes');
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('client auteur : mentions refusées (400)', async () => {
    const { service } = monter({ id: CONV, customerId: 'client-1', restaurantId: 'r1', subject: null });
    await expect(
      service.createMessage(req(client), CONV, { body: '@Awa Koné', mentionUserIds: [U.awa] }),
    ).rejects.toThrow('Les mentions sont réservées au personnel');
  });

  it('écrit les seules mentions retenues dans la même requête, et ne prévient qu’elles', async () => {
    const { service, prisma, notifications } = monter();
    const r = await service.createMessage(req(staff), CONV, {
      body: '@Awa Koné et @Ali Cuisine, on ferme',
      mentionUserIds: [U.awa, U.cuisine, U.auteur],
    });
    await flush();

    expect(prisma.message.create.mock.calls[0][0].data.mentions).toEqual({
      create: [{ userId: U.awa, libelle: 'Awa Koné' }],
    });
    expect(r.mentions).toEqual([{ userId: U.awa, label: 'Awa Koné' }]);

    expect(notifications.notifyStaffMention).toHaveBeenCalledTimes(1);
    expect(notifications.notifyStaffMention).toHaveBeenCalledWith(
      expect.objectContaining({
        motif: 'mention',
        userIds: [U.awa],
        auteurNom: 'Jean Yao',
        conversationId: CONV,
        messageId: r.id,
        restaurantId: 'r1',
        libelleConversation: 'Équipe Zone 4',
      }),
    );
  });

  it("répondre à un collègue le prévient (réponse implicite)", async () => {
    const { service, notifications } = monter();
    const r = await service.createMessage(req(staff), CONV, { body: 'Bien noté', replyToId: M2 });
    await flush();
    expect(notifications.notifyStaffMention).toHaveBeenCalledTimes(1);
    expect(notifications.notifyStaffMention).toHaveBeenCalledWith(
      expect.objectContaining({ motif: 'reponse', userIds: [U.koffi], messageId: r.id }),
    );
  });

  it("l'auteur cité déjà mentionné n'est prévenu qu'une fois, comme mentionné", async () => {
    const { service, notifications } = monter();
    await service.createMessage(req(staff), CONV, {
      body: '@Awa Koné oui',
      replyToId: M1,
      mentionUserIds: [U.awa],
    });
    await flush();
    expect(notifications.notifyStaffMention).toHaveBeenCalledTimes(1);
    expect(notifications.notifyStaffMention.mock.calls[0][0]).toMatchObject({ motif: 'mention', userIds: [U.awa] });
  });

  it("répondre à son propre message ou à une alerte ne prévient personne", async () => {
    const { service, prisma, notifications } = monter();
    prisma.message.findFirst.mockResolvedValueOnce({ id: M1, deletedAt: null, authorUserId: U.auteur });
    await service.createMessage(req(staff), CONV, { body: 'Je complète', replyToId: M1 });
    prisma.message.findFirst.mockResolvedValueOnce({ id: M2, deletedAt: null, authorUserId: null });
    await service.createMessage(req(staff), CONV, { body: 'Je regarde', replyToId: M2 });
    await flush();
    expect(notifications.notifyStaffMention).not.toHaveBeenCalled();
  });

  it("l'auteur cité sans accès à la messagerie n'est pas prévenu", async () => {
    const { service, prisma, notifications } = monter();
    prisma.message.findFirst.mockResolvedValueOnce({ id: M1, deletedAt: null, authorUserId: U.cuisine });
    await service.createMessage(req(staff), CONV, { body: 'Merci', replyToId: M1 });
    await flush();
    expect(notifications.notifyStaffMention).not.toHaveBeenCalled();
  });

  it('conversation client : réponse permise, aucune notification ciblée, version client au client', async () => {
    const { service, notifications } = monter({ id: CONV, customerId: 'client-1', restaurantId: 'r1', subject: null });
    const r = await service.createMessage(req(client), CONV, { body: 'Merci', replyToId: M1 });
    await flush();
    expect(notifications.notifyStaffMention).not.toHaveBeenCalled();
    expect(r.replyTo?.author).toEqual({ kind: 'user', id: null, name: 'Chicken Nation' });
    expect(r.mentions).toEqual([]);
  });

  it("une notification en échec ne fait pas échouer l'envoi", async () => {
    const { service, notifications } = monter();
    notifications.notifyStaffMention.mockRejectedValueOnce(new Error('panne'));
    await expect(
      service.createMessage(req(staff), CONV, { body: '@Awa Koné', mentionUserIds: [U.awa] }),
    ).resolves.toMatchObject({ body: '@Awa Koné' });
    await flush();
  });
});

describe('MessageService.getMessages : lecture', () => {
  const ligne = (): Brut => ({
    id: 'r1',
    conversationId: CONV,
    body: '@Awa Koné regarde',
    meta: {},
    isRead: false,
    readAt: null,
    deletedAt: null,
    createdAt: date,
    updatedAt: date,
    authorUser: { id: U.auteur, fullname: 'Jean Yao', email: 'j@cn.ci' },
    authorCustomer: null,
    reactions: [],
    conversation: { customerId: null, restaurantId: 'r1' },
    replyTo: originaux()[M1],
    mentions: [{ userId: U.awa, libelle: 'Awa Koné' }],
  });

  it('tri stable (date puis identifiant) et citation et mentions pour le personnel', async () => {
    const { service, prisma } = monter();
    prisma.message.findMany.mockResolvedValueOnce([ligne()]);
    prisma.message.count.mockResolvedValueOnce(1);
    const r = await service.getMessages(req(staff), CONV, { page: 1, limit: 100 });

    const requete = prisma.message.findMany.mock.calls[0][0]!;
    expect(requete.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(requete.include.replyTo).toBeDefined();
    expect(requete.include.mentions).toBeDefined();

    expect(r.data[0].replyTo?.author).toEqual({ kind: 'user', id: U.awa, name: 'Awa Koné' });
    expect(r.data[0].mentions).toEqual([{ userId: U.awa, label: 'Awa Koné' }]);
  });

  it('lecteur client : agent cité « Chicken Nation » et aucune mention', async () => {
    const { service, prisma } = monter({ id: CONV, customerId: 'client-1', restaurantId: 'r1', subject: null });
    prisma.message.findMany.mockResolvedValueOnce([ligne()]);
    prisma.message.count.mockResolvedValueOnce(1);
    prisma.conversation.findUnique.mockResolvedValue(null); // marquage de lecture ignoré
    const r = await service.getMessages(req(client), CONV, { page: 1, limit: 10 });
    expect(r.data[0].replyTo?.author).toEqual({ kind: 'user', id: null, name: 'Chicken Nation' });
    expect(r.data[0].mentions).toEqual([]);
    expect(JSON.stringify(r.data[0].replyTo)).not.toContain('Awa');
  });

  it('message supprimé : ni citation ni mentions', async () => {
    const { service, prisma } = monter();
    prisma.message.findMany.mockResolvedValueOnce([{ ...ligne(), deletedAt: new Date() }]);
    prisma.message.count.mockResolvedValueOnce(1);
    const r = await service.getMessages(req(staff), CONV, {});
    expect(r.data[0].replyTo).toBeNull();
    expect(r.data[0].mentions).toEqual([]);
  });

  it("citation d'un original supprimé : texte de remplacement", async () => {
    const { service, prisma } = monter();
    prisma.message.findMany.mockResolvedValueOnce([
      { ...ligne(), replyTo: { ...originaux()[M1], deletedAt: new Date() } },
    ]);
    prisma.message.count.mockResolvedValueOnce(1);
    const r = await service.getMessages(req(staff), CONV, {});
    expect(r.data[0].replyTo).toMatchObject({ deleted: true, excerpt: 'Ce message a été supprimé' });
    expect(JSON.stringify(r.data[0].replyTo)).not.toContain('23 h');
  });
});

describe('MessageService.getPositionMessage', () => {
  it.each([
    [0, 100, 1],
    [99, 100, 1],
    [100, 100, 2],
    [250, 100, 3],
    [25, 10, 3],
  ])('%i messages plus récents, pages de %i : page %i', async (plusRecents, limit, page) => {
    const { service, prisma } = monter();
    prisma.message.count.mockResolvedValueOnce(plusRecents);
    await expect(service.getPositionMessage(req(staff), CONV, M1, limit)).resolves.toEqual({
      messageId: M1,
      page,
      limit,
    });
  });

  it("compte avec le même ordre que la liste (date, puis identifiant)", async () => {
    const { service, prisma } = monter();
    await service.getPositionMessage(req(staff), CONV, M1, 100);
    expect(prisma.message.count.mock.calls[0][0]).toEqual({
      where: {
        conversationId: CONV,
        OR: [
          { createdAt: { gt: date } },
          { createdAt: date, id: { gt: M1 } },
        ],
      },
    });
  });

  it("message d'une autre conversation : 404", async () => {
    const { service, prisma } = monter();
    prisma.message.findFirst.mockResolvedValueOnce(null);
    await expect(service.getPositionMessage(req(staff), CONV, M1, 100)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.message.count).not.toHaveBeenCalled();
  });

  it('conversation inaccessible : 404', async () => {
    const { service, conversations } = monter();
    conversations.getConversationById.mockResolvedValueOnce(null as any);
    await expect(service.getPositionMessage(req(staff), CONV, M1, 100)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('MessageService.supprimerMessage : aperçu des notifications', () => {
  it('masque les notifications des personnes mentionnées et de l’auteur cité', async () => {
    const { service, prisma, notifications } = monter();
    prisma.message.findFirst.mockResolvedValueOnce({
      id: 'r1',
      authorUserId: U.auteur,
      deletedAt: null,
      conversation: { id: CONV, customerId: null, restaurantId: 'r1', users: [{ userId: U.auteur }] },
      mentions: [{ userId: U.awa }],
      replyTo: { authorUserId: U.koffi },
    });
    prisma.message.findUnique.mockResolvedValueOnce({
      id: 'r1',
      conversationId: CONV,
      body: 'secret',
      meta: {},
      deletedAt: new Date(),
      createdAt: date,
      updatedAt: date,
      authorUser: { id: U.auteur, fullname: 'Jean Yao' },
      authorCustomer: null,
      reactions: [],
      conversation: { customerId: null, restaurantId: 'r1' },
      replyTo: originaux()[M2],
      mentions: [{ userId: U.awa, libelle: 'Awa Koné' }],
    });

    const r = await service.supprimerMessage(req(staff), CONV, 'r1');
    await flush();

    expect(notifications.masquerApercuNotificationsMessage).toHaveBeenCalledWith({
      messageId: 'r1',
      userIds: [U.awa, U.koffi],
    });
    expect(r.body).toBe('Ce message a été supprimé');
    expect(r.replyTo).toBeNull();
    expect(r.mentions).toEqual([]);
  });
});

describe('MessageService.markMessagesAsRead : notifications de mention', () => {
  const conversationEnBase = (customerId: string | null) => ({
    id: CONV,
    customerId,
    restaurantId: 'r1',
    isBroadcast: false,
    hasReply: false,
    users: [{ userId: U.auteur, conversationId: CONV }],
  });

  it('conversation interne : les marque lues pour ce lecteur', async () => {
    const { service, prisma, notifications } = monter();
    prisma.conversation.findUnique.mockResolvedValueOnce(conversationEnBase(null));
    (prisma as any).message.updateMany = jest.fn(async () => ({ count: 0 }));
    prisma.conversationUser.findUnique.mockResolvedValueOnce(null);
    await service.markMessagesAsRead(CONV, 'USER', U.auteur);
    expect(notifications.marquerNotificationsConversationLues).toHaveBeenCalledWith({
      userId: U.auteur,
      conversationId: CONV,
    });
  });

  it('conversation client : rien à marquer', async () => {
    const { service, prisma, notifications } = monter();
    prisma.conversation.findUnique.mockResolvedValueOnce(conversationEnBase('client-1'));
    (prisma as any).message.updateMany = jest.fn(async () => ({ count: 0 }));
    await service.markMessagesAsRead(CONV, 'USER', U.auteur);
    expect(notifications.marquerNotificationsConversationLues).not.toHaveBeenCalled();
  });
});
