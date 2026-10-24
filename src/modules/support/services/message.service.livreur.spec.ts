import { HttpException } from '@nestjs/common';

import { SupportWebSocketService } from '../websockets/support-websocket.service';
import { TicketMessageService } from './message.service';

/**
 * Le livreur écrit dans un ticket déjà ouvert (relecture de l'appli livreur).
 *
 * `createMessage` ne connaissait que USER et CUSTOMER : un livreur recevait
 * 404 « Author not found » à chaque réponse, seul le premier message, posé à la
 * création du ticket, passait. Il écrit désormais dans SES tickets, jamais dans
 * celui d'un autre livreur ni d'un client, avec la même diffusion que les
 * autres auteurs.
 */
describe('TicketMessageService : message écrit par un livreur', () => {
  const LIVREUR = 'liv-1';
  const AUTRE_LIVREUR = 'liv-2';
  const AGENT = 'agent-1';

  const fils: Record<string, { delivererId: string | null; customerId: string | null }> = {
    'ticket-livreur': { delivererId: LIVREUR, customerId: null },
    'ticket-autre-livreur': { delivererId: AUTRE_LIVREUR, customerId: null },
    'ticket-client': { delivererId: null, customerId: 'cli-1' },
  };

  function monter() {
    const livreurs: Record<string, { id: string; first_name: string; last_name: string; image: string | null }> = {
      [LIVREUR]: { id: LIVREUR, first_name: 'Awa', last_name: 'Koné', image: null },
      [AUTRE_LIVREUR]: { id: AUTRE_LIVREUR, first_name: 'Yao', last_name: 'Kouassi', image: null },
    };

    const agents: Record<string, { id: string; fullname: string; email: string; image: string | null }> = {
      [AGENT]: { id: AGENT, fullname: 'Service client', email: 'support@exemple.ci', image: null },
    };

    const prisma = {
      user: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => agents[where.id] ?? null) },
      customer: { findUnique: jest.fn(async () => null) },
      deliverer: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => livreurs[where.id] ?? null),
      },
      ticketThread: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => fils[where.id] ?? null),
        update: jest.fn(async ({ where }: { where: { id: string } }) => ({
          ...fils[where.id],
          orderId: null,
          order: null,
        })),
      },
      ticketMessage: {
        // Rend la ligne comme Prisma avec `MessageInclude` : l'auteur livreur
        // n'est inclus que si `authorDelivererId` a été posé.
        create: jest.fn(async ({ data }: { data: Record<string, any> }) => ({
          id: 'msg-1',
          body: data.body,
          internal: data.internal,
          isRead: false,
          createdAt: new Date('2026-10-24T10:00:00Z'),
          updatedAt: new Date('2026-10-24T10:00:00Z'),
          deletedAt: null,
          reactions: [],
          authorUser: data.authorUserId ? agents[data.authorUserId] : null,
          authorCustomer: null,
          authorDeliverer: data.authorDelivererId ? livreurs[data.authorDelivererId] : null,
          ticket: { id: data.ticketId, code: 'LIV-0001' },
        })),
      },
    };
    const appGateway = { emitToBackoffice: jest.fn(), emitToRestaurant: jest.fn(), emitToUser: jest.fn() };
    const websocket = new SupportWebSocketService(appGateway as never);
    jest.spyOn((websocket as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);
    const expoPush = { sendPushNotifications: jest.fn(async () => ({})) };
    const service = new TicketMessageService(prisma as never, websocket, expoPush as never, {} as never);
    return { service, prisma, appGateway, expoPush };
  }

  const ecrire = (service: TicketMessageService, ticketId: string, authorId: string) =>
    service.createMessage(ticketId, {
      ticketId,
      body: 'Le client ne répond pas',
      internal: false,
      authorId,
      authorType: 'DELIVERER',
    });

  it('écrit dans SON ticket : auteur livreur dans la réponse et dans new:ticket_message', async () => {
    const t = monter();

    const reponse = await ecrire(t.service, 'ticket-livreur', LIVREUR);

    expect(t.prisma.ticketMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorDelivererId: LIVREUR,
          authorCustomerId: null,
          authorUserId: null,
        }),
      }),
    );
    expect(reponse.authorDeliverer).toEqual(
      expect.objectContaining({ id: LIVREUR, name: 'Awa Koné' }),
    );
    expect(reponse.authorUser).toBeNull();
    expect(reponse.authorCustomer).toBeNull();

    expect(t.appGateway.emitToBackoffice).toHaveBeenCalledWith('new:ticket_message', {
      ticketId: 'ticket-livreur',
      message: expect.objectContaining({
        authorDeliverer: expect.objectContaining({ id: LIVREUR, name: 'Awa Koné' }),
      }),
    });
  });

  it("mêmes notifications qu'un client : le personnel par le temps réel, aucune notification au livreur lui-même", async () => {
    const t = monter();
    await ecrire(t.service, 'ticket-livreur', LIVREUR);
    await new Promise((r) => setImmediate(r));
    expect(t.expoPush.sendPushNotifications).not.toHaveBeenCalled();
  });

  it.each([
    ['un autre livreur', 'ticket-autre-livreur'],
    ['un client', 'ticket-client'],
  ])('refuse le ticket d\'%s : 403, rien écrit ni diffusé', async (_qui, ticketId) => {
    const t = monter();

    const erreur = await ecrire(t.service, ticketId, LIVREUR).catch((e) => e);

    expect(erreur).toBeInstanceOf(HttpException);
    expect((erreur as HttpException).getStatus()).toBe(403);
    expect(t.prisma.ticketMessage.create).not.toHaveBeenCalled();
    expect(t.prisma.ticketThread.update).not.toHaveBeenCalled();
    expect(t.appGateway.emitToBackoffice).not.toHaveBeenCalled();
  });

  it('livreur inconnu : 404 « Author not found », rien écrit', async () => {
    const t = monter();

    const erreur = await ecrire(t.service, 'ticket-livreur', 'liv-inconnu').catch((e) => e);

    expect((erreur as HttpException).getStatus()).toBe(404);
    expect((erreur as HttpException).message).toBe('Author not found');
    expect(t.prisma.ticketMessage.create).not.toHaveBeenCalled();
  });

  /**
   * L'appli livreur écoute `new:ticket_message` dans son canal privé pour
   * recharger le fil, mais rien n'y partait : la réponse du service client
   * n'arrivait que par la notification, ou au rechargement suivant.
   */
  describe('réponse du personnel : new:ticket_message dans la salle du livreur', () => {
    const repondre = (service: TicketMessageService, ticketId: string, internal = false) =>
      service.createMessage(ticketId, {
        ticketId,
        body: 'On appelle le client',
        internal,
        authorId: AGENT,
        authorType: 'USER',
      });

    const versLivreur = (appGateway: { emitToUser: jest.Mock }, livreurId: string) =>
      appGateway.emitToUser.mock.calls.filter(
        ([id, type, evenement]) => id === livreurId && type === 'deliverer' && evenement === 'new:ticket_message',
      );

    it('ticket du livreur : il reçoit le message, même forme que le backoffice', async () => {
      const t = monter();

      await repondre(t.service, 'ticket-livreur');

      expect(t.appGateway.emitToUser).toHaveBeenCalledWith(LIVREUR, 'deliverer', 'new:ticket_message', {
        ticketId: 'ticket-livreur',
        message: expect.objectContaining({
          body: 'On appelle le client',
          authorUser: expect.objectContaining({ id: AGENT, name: 'Service client' }),
          authorDeliverer: null,
          authorCustomer: null,
        }),
      });
      const [, , , charge] = versLivreur(t.appGateway, LIVREUR)[0];
      expect(t.appGateway.emitToBackoffice).toHaveBeenCalledWith('new:ticket_message', charge);
    });

    it("ticket d'un client ou d'un autre livreur : rien dans sa salle", async () => {
      const t = monter();

      await repondre(t.service, 'ticket-client');
      await repondre(t.service, 'ticket-autre-livreur');

      expect(versLivreur(t.appGateway, LIVREUR)).toHaveLength(0);
      expect(versLivreur(t.appGateway, AUTRE_LIVREUR)).toHaveLength(1);
      expect(
        t.appGateway.emitToUser.mock.calls.filter(([, type]) => type === 'deliverer'),
      ).toHaveLength(1);
    });

    it('note interne : jamais dans sa salle', async () => {
      const t = monter();

      await repondre(t.service, 'ticket-livreur', true);

      expect(versLivreur(t.appGateway, LIVREUR)).toHaveLength(0);
      expect(t.appGateway.emitToBackoffice).toHaveBeenCalledWith('new:ticket_message', expect.anything());
    });

    it("son propre message : pas renvoyé, l'appli recharge déjà le fil à l'envoi", async () => {
      const t = monter();

      await ecrire(t.service, 'ticket-livreur', LIVREUR);

      expect(versLivreur(t.appGateway, LIVREUR)).toHaveLength(0);
    });
  });
});
