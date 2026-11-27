import { HttpException } from '@nestjs/common';

import { SupportWebSocketService } from '../websockets/support-websocket.service';
import { TicketMessageService } from './message.service';

/**
 * Note vocale dans un ticket (27/11) : « il n'y a pas un bouton pour envoyer
 * une note vocale dans message ». Le client l'envoie dans son ticket comme
 * dans une conversation ; elle est servie au personnel et au client.
 */
describe('TicketMessageService : note vocale du client', () => {
  const CLIENT = 'cli-1';

  function monter(options: { stockage?: 'ok' | 'panne' } = {}) {
    const ecrits: Record<string, any>[] = [];
    const prisma = {
      user: { findUnique: jest.fn(async () => null) },
      customer: { findUnique: jest.fn(async () => ({ id: CLIENT })) },
      deliverer: { findUnique: jest.fn(async () => null) },
      ticketThread: {
        update: jest.fn(async () => ({ customerId: CLIENT, delivererId: null, orderId: null, order: null })),
      },
      ticketMessage: {
        create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
          const ligne = {
            id: `msg-${ecrits.length + 1}`,
            ...data,
            isRead: false,
            createdAt: new Date('2026-11-27T10:00:00Z'),
            updatedAt: new Date('2026-11-27T10:00:00Z'),
            deletedAt: null,
            reactions: [],
            authorUser: null,
            authorDeliverer: null,
            authorCustomer: { id: CLIENT, first_name: 'Awa', last_name: 'Koné', email: null, image: null },
            ticket: { id: data.ticketId, code: 'CMD-00001' },
          };
          ecrits.push(ligne);
          return ligne;
        }),
      },
    };
    const appGateway = { emitToBackoffice: jest.fn(), emitToUser: jest.fn(), emitToRestaurant: jest.fn(), emitToRoom: jest.fn() };
    const websocket = new SupportWebSocketService(appGateway as never);
    const diffuse = jest.spyOn(websocket, 'emitNewTicketMessage').mockImplementation(() => undefined as never);
    const s3 = {
      uploadFile: jest.fn(async ({ path }: { path: string }) =>
        options.stockage === 'panne' ? null : { key: `${path}/1-note.m4a`, url: 'x' },
      ),
    };
    const service = new TicketMessageService(prisma as never, websocket, {} as never, {} as never, s3 as never);
    return { service, prisma, s3, ecrits, diffuse };
  }

  const audio = (taille = 2048) =>
    ({ buffer: Buffer.alloc(8), size: taille, originalname: 'note.m4a', mimetype: 'audio/m4a' }) as unknown as Express.Multer.File;

  const message = (body: string) => ({ ticketId: 't-1', body, internal: false, authorId: CLIENT, authorType: 'CUSTOMER' as const });

  it('une note vocale sans texte part avec un corps lisible, sa clé et sa durée', async () => {
    const { service, s3, ecrits, diffuse } = monter();
    const rendu = await service.createMessage('t-1', message(''), { audio: audio(), audioDurationMs: 4200 });

    expect(s3.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'chicken-nation/tickets-audio', mimetype: 'audio/m4a' }));
    expect(ecrits[0].body).toBe('Message vocal');
    expect(ecrits[0].meta).toEqual({ audioUrl: 'chicken-nation/tickets-audio/1-note.m4a', audioDurationMs: 4200 });
    expect(ecrits[0].authorCustomerId).toBe(CLIENT);
    expect(rendu.meta).toEqual({ audioUrl: 'chicken-nation/tickets-audio/1-note.m4a', audioDurationMs: 4200 });
    // Le personnel la reçoit en direct, avec la pièce jointe.
    expect((diffuse.mock.calls[0][1] as { message: { meta: unknown } }).message.meta).toEqual(rendu.meta);
  });

  it('le texte qui accompagne la note vocale est gardé', async () => {
    const { service, ecrits } = monter();
    await service.createMessage('t-1', message('Écoutez ça'), { audio: audio(), audioDurationMs: null });
    expect(ecrits[0].body).toBe('Écoutez ça');
    expect(ecrits[0].meta).toEqual({ audioUrl: 'chicken-nation/tickets-audio/1-note.m4a', audioDurationMs: null });
  });

  it("stockage en panne : l'envoi échoue, aucun message vide n'est écrit", async () => {
    const { service, prisma } = monter({ stockage: 'panne' });
    await expect(service.createMessage('t-1', message(''), { audio: audio() })).rejects.toBeInstanceOf(HttpException);
    expect(prisma.ticketMessage.create).not.toHaveBeenCalled();
  });

  it('une note vocale trop lourde est refusée avant le stockage', async () => {
    const { service, s3 } = monter();
    await expect(service.createMessage('t-1', message(''), { audio: audio(17 * 1024 * 1024) })).rejects.toBeInstanceOf(HttpException);
    expect(s3.uploadFile).not.toHaveBeenCalled();
  });

  it("un message de texte reste comme avant : rien au stockage, pas de pièce jointe servie", async () => {
    const { service, s3, ecrits } = monter();
    const rendu = await service.createMessage('t-1', { ...message('Bonjour'), meta: 'mobile_app' });
    expect(s3.uploadFile).not.toHaveBeenCalled();
    expect(ecrits[0].body).toBe('Bonjour');
    expect(rendu.meta).toBeNull();
  });
});
