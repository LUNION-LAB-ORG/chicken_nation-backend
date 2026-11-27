import { HttpException } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';

import { TicketService } from './ticket.service';

/**
 * Tickets vus par le CLIENT (27/11).
 *
 *  - « Support » depuis une commande retrouve la demande en cours de cette
 *    commande au lieu d'en créer une autre ;
 *  - un client ne lit que SES tickets, quoi que dise la requête.
 */
describe('TicketService : tickets du client', () => {
  const CLIENT = 'cli-1';
  const AUTRE = 'cli-2';

  type Fil = { id: string; code: string; subject: string; status: TicketStatus; customerId: string; orderId: string | null; createdAt: Date };

  function monter(fils: Fil[]) {
    const correspond = (f: Fil, where: Record<string, any>) => {
      if (where.id !== undefined && f.id !== where.id) return false;
      if (where.customerId !== undefined && f.customerId !== where.customerId) return false;
      if (where.orderId !== undefined && f.orderId !== where.orderId) return false;
      if (where.status?.in && !where.status.in.includes(f.status)) return false;
      return true;
    };
    const complet = (f: Fil) => ({
      ...f,
      priority: 'MEDIUM',
      customer: { id: f.customerId, first_name: 'Awa', last_name: 'Koné', email: null, image: null },
      deliverer: null,
      assignee: null,
      participants: [],
      messages: [],
      order: f.orderId ? { id: f.orderId, reference: `ORD-${f.orderId}`, restaurant_id: 'r-1' } : null,
      category: { id: 'cat-1', name: 'Commande en retard' },
      _count: { messages: 0 },
      updatedAt: f.createdAt,
    });
    const trier = (liste: Fil[]) => [...liste].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const prisma = {
      ticketThread: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, any> }) => {
          const trouve = trier(fils.filter((f) => correspond(f, where)))[0];
          return trouve ? complet(trouve) : null;
        }),
        findMany: jest.fn(async ({ where }: { where: Record<string, any> }) =>
          trier(fils.filter((f) => correspond(f, where))).map(complet),
        ),
        count: jest.fn(async ({ where }: { where: Record<string, any> }) => fils.filter((f) => correspond(f, where)).length),
        create: jest.fn(),
      },
    };
    const service = new TicketService(prisma as never, { emitTicketCreated: jest.fn() } as never, {} as never);
    return { service, prisma };
  }

  const fil = (id: string, p: Partial<Fil> = {}): Fil => ({
    id,
    code: `CMD-${id}`,
    subject: 'Problème: Commande en retard',
    status: TicketStatus.OPEN,
    customerId: CLIENT,
    orderId: 'cmd-1',
    createdAt: new Date('2026-11-27T10:00:00Z'),
    ...p,
  });

  it('la demande en cours de la commande est retrouvée', async () => {
    const { service } = monter([fil('t-1')]);
    const ticket = await service.getCustomerTicketEnCours(CLIENT, 'cmd-1');
    expect(ticket?.id).toBe('t-1');
    expect(ticket?.order).toEqual({ id: 'cmd-1', reference: 'ORD-cmd-1', restaurantId: 'r-1' });
  });

  it('une demande en traitement compte ; résolue ou fermée, elle ne compte plus', async () => {
    expect((await monter([fil('t-1', { status: TicketStatus.IN_PROGRESS })]).service.getCustomerTicketEnCours(CLIENT, 'cmd-1'))?.id).toBe('t-1');
    expect(await monter([fil('t-1', { status: TicketStatus.RESOLVED })]).service.getCustomerTicketEnCours(CLIENT, 'cmd-1')).toBeNull();
    expect(await monter([fil('t-1', { status: TicketStatus.CLOSED })]).service.getCustomerTicketEnCours(CLIENT, 'cmd-1')).toBeNull();
  });

  it("la demande d'une autre commande, ou d'un autre client, n'est pas rendue", async () => {
    const { service } = monter([fil('t-1', { orderId: 'cmd-2' }), fil('t-2', { customerId: AUTRE })]);
    expect(await service.getCustomerTicketEnCours(CLIENT, 'cmd-1')).toBeNull();
  });

  it('créer pour la même commande ne crée rien : la demande en cours est désignée', async () => {
    const { service, prisma } = monter([fil('t-1')]);
    let erreur: HttpException | null = null;
    try {
      await service.createTicket(
        { subject: 'Problème', categoryId: 'cat-1', orderId: 'cmd-1', customerId: CLIENT } as never,
        { enforceSingleOpenCustomer: true },
      );
    } catch (e) {
      erreur = e as HttpException;
    }
    expect(erreur).toBeInstanceOf(HttpException);
    const corps = erreur!.getResponse() as Record<string, any>;
    expect(erreur!.getStatus()).toBe(409);
    expect(corps.code).toBe('TICKET_ALREADY_OPEN');
    expect(corps.existingTicket.id).toBe('t-1');
    expect(corps.memeCommande).toBe(true);
    expect(prisma.ticketThread.create).not.toHaveBeenCalled();
  });

  it("une demande en cours sur une autre commande est désignée, sans dire que c'est la même", async () => {
    const { service, prisma } = monter([fil('t-1', { orderId: 'cmd-2' })]);
    let corps: Record<string, any> = {};
    try {
      await service.createTicket(
        { subject: 'Problème', categoryId: 'cat-1', orderId: 'cmd-1', customerId: CLIENT } as never,
        { enforceSingleOpenCustomer: true },
      );
    } catch (e) {
      corps = (e as HttpException).getResponse() as Record<string, any>;
    }
    expect(corps.existingTicket.id).toBe('t-1');
    expect(corps.memeCommande).toBe(false);
    expect(prisma.ticketThread.create).not.toHaveBeenCalled();
  });

  it("un client ne lit que SES tickets, même s'il demande ceux d'un autre", async () => {
    const { service, prisma } = monter([fil('t-1'), fil('t-2', { customerId: AUTRE })]);
    const liste = await service.getCustomerTickets(CLIENT, { clientId: AUTRE } as never);
    expect(liste.data.map((t) => t.id)).toEqual(['t-1']);
    expect(prisma.ticketThread.findMany.mock.calls[0][0].where.customerId).toBe(CLIENT);
  });

  it("le ticket d'un autre client est introuvable", async () => {
    const { service } = monter([fil('t-2', { customerId: AUTRE })]);
    await expect(service.getCustomerTicket(CLIENT, 't-2')).rejects.toMatchObject({ status: 404 });
    await expect(monter([fil('t-1')]).service.getCustomerTicket(CLIENT, 't-1')).resolves.toMatchObject({ id: 't-1' });
  });
});
