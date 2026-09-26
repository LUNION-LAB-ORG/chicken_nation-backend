import type { Request } from 'express';
import { ConversationsService } from './conversations.service';

/**
 * Forme d'une conversation servie : messages supprimés masqués partout, et
 * participants mentionnables calculés par le serveur.
 */

const date = new Date('2026-09-26T18:26:00Z');

const participant = (id: string, role: string, entity_status = 'ACTIVE') => ({
  user: { id, fullname: `Agent ${id}`, role, entity_status, image: null },
});

function monter(conversation: Record<string, any>) {
  const prisma = {
    conversation: { findUnique: jest.fn(async (_a?: any) => conversation) },
    message: { count: jest.fn(async () => 0) },
    conversationUser: { findFirst: jest.fn(async () => null) },
  };
  const service = new ConversationsService(prisma as any, {} as any);
  return { service, prisma };
}

const base = () => ({
  id: 'conv-1',
  customerId: 'client-1',
  subject: null,
  isGroup: false,
  receivesAlerts: false,
  isBroadcast: false,
  createdAt: date,
  updatedAt: date,
  customer: { id: 'client-1', first_name: 'Yao', last_name: 'Kouassi', email: null, phone: null, image: null },
  restaurant: { id: 'r1', name: 'Zone 4', image: null },
  users: [
    participant('u-caisse', 'CAISSIER'),
    participant('u-cuisine', 'CUISINE'),
    participant('u-parti', 'MANAGER', 'INACTIVE'),
  ],
  messages: [
    {
      id: 'm2',
      body: 'Mon code est 4521',
      isRead: false,
      deletedAt: date,
      createdAt: date,
      updatedAt: date,
      authorUser: null,
      authorCustomer: { id: 'client-1', first_name: 'Yao', last_name: 'Kouassi', image: null },
    },
    {
      id: 'm1',
      body: 'Bonjour',
      isRead: true,
      deletedAt: null,
      createdAt: date,
      updatedAt: date,
      authorUser: { id: 'u-caisse', fullname: 'Agent u-caisse', email: 'x@cn.ci', image: null },
      authorCustomer: null,
    },
  ],
});

describe('ConversationsService.getConversationById : forme servie', () => {
  const req = { user: { id: 'client-1' } } as unknown as Request;

  it("un message supprimé ne sert plus son texte d'origine (aperçu et 50 derniers)", async () => {
    const { service } = monter(base());
    const c = (await service.getConversationById(req, 'conv-1'))!;
    const supprime = c.messages.find((m) => m.id === 'm2')!;
    expect(supprime.body).toBe('Ce message a été supprimé');
    expect(supprime.deleted).toBe(true);
    expect(JSON.stringify(c)).not.toContain('4521');

    const intact = c.messages.find((m) => m.id === 'm1')!;
    expect(intact.body).toBe('Bonjour');
    expect(intact.deleted).toBe(false);
  });

  it('participants : rôle et « mentionnable » (actif ET accès à la messagerie), sans statut brut', async () => {
    const { service, prisma } = monter(base());
    const c = (await service.getConversationById(req, 'conv-1'))!;
    expect(c.users).toEqual([
      { id: 'u-caisse', fullName: 'Agent u-caisse', image: null, role: 'CAISSIER', mentionnable: true },
      { id: 'u-cuisine', fullName: 'Agent u-cuisine', image: null, role: 'CUISINE', mentionnable: false },
      { id: 'u-parti', fullName: 'Agent u-parti', image: null, role: 'MANAGER', mentionnable: false },
    ]);
    expect(JSON.stringify(c.users)).not.toContain('entity_status');

    // Le statut est bien lu en base pour le calcul.
    const include = prisma.conversation.findUnique.mock.calls[0][0].include;
    expect(include.users.select.user.select.entity_status).toBe(true);
  });
});

describe('ConversationsService.createConversationWithInitialMessage : participants', () => {
  it('la réponse de création lit rôle et statut, pour que « mentionnable » soit juste dès le départ', async () => {
    const creee = {
      id: 'conv-2',
      customerId: null,
      restaurantId: null,
      subject: null,
      isGroup: false,
      receivesAlerts: false,
      isBroadcast: false,
      createdAt: date,
      updatedAt: date,
      customer: null,
      restaurant: null,
      users: [participant('u-admin', 'ADMIN'), participant('u-caisse', 'CAISSIER')],
      messages: [
        { id: 'm1', body: 'Salut', isRead: false, deletedAt: null, createdAt: date, updatedAt: date },
      ],
    };
    const tx = {
      conversation: {
        findFirst: jest.fn(async (_a?: any) => null),
        create: jest.fn(async (_a?: any) => creee),
      },
    };
    const prisma = {
      user: { findMany: jest.fn(async (_a?: any) => [{ id: 'u-caisse' }]) },
      $transaction: jest.fn(async (travail: (t: typeof tx) => unknown) => travail(tx)),
    };
    const sockets = { emitConversationCreated: jest.fn() };
    const service = new ConversationsService(prisma as any, sockets as any);
    jest.spyOn(service as any, 'countUnreadMessages').mockResolvedValue(0);

    const req = {
      user: { id: 'u-admin', role: 'ADMIN', type: 'BACKOFFICE', restaurant_id: null, fullname: 'Jean Yao' },
    } as unknown as Request;
    const r = await service.createConversationWithInitialMessage(req, {
      seed_message: 'Salut',
      receiver_user_id: 'u-caisse',
    } as any);

    const include = tx.conversation.create.mock.calls[0][0].include;
    expect(include.users.select.user.select).toMatchObject({ role: true, entity_status: true });
    expect(r.users.find((u) => u.id === 'u-caisse')).toMatchObject({
      role: 'CAISSIER',
      mentionnable: true,
    });
    expect(sockets.emitConversationCreated).toHaveBeenCalledWith(r);
  });
});
