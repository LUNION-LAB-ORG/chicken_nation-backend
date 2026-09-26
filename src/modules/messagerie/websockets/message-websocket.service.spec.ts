import { Logger } from '@nestjs/common';
import { MessageWebSocketService } from './message-websocket.service';

/**
 * Qui reçoit quoi par socket, pour un message qui cite et qui mentionne.
 * Passerelle simulée : aucune connexion réelle.
 */

beforeAll(() => Logger.overrideLogger(false));

function monter() {
  const passerelle = { emitToUser: jest.fn(), emitToRestaurant: jest.fn() };
  const service = new MessageWebSocketService(passerelle as any);
  return { service, passerelle };
}

const message = () =>
  ({
    id: 'm2',
    body: 'Bien noté',
    authorUser: { id: 'agent-1', name: 'Jean Yao', email: 'j@cn.ci', image: null },
    authorCustomer: null,
    replyTo: {
      id: 'm1',
      deleted: false,
      kind: 'text',
      excerpt: 'On ferme à 23 h',
      author: { kind: 'user', id: 'agent-2', name: 'Awa Koné' },
      createdAt: new Date('2026-09-26T18:26:00Z'),
    },
    mentions: [{ userId: 'agent-2', label: 'Awa Koné' }],
  }) as any;

/** Charges envoyées à une personne donnée, pour un évènement donné. */
const recu = (p: { emitToUser: jest.Mock }, qui: string, evenement: string) =>
  p.emitToUser.mock.calls.filter((c) => c[0] === qui && c[2] === evenement).map((c) => c[3]);

describe('MessageWebSocketService.emitNewMessage', () => {
  it("le client reçoit SA version : agent cité « Chicken Nation », aucune mention", () => {
    const { service, passerelle } = monter();
    service.emitNewMessage(['agent-1', 'agent-2'], { restaurantId: 'r1', customerId: 'client-1' }, message());

    const [pourLeClient] = recu(passerelle, 'client-1', 'new:message');
    expect(pourLeClient.replyTo.author).toEqual({ kind: 'user', id: null, name: 'Chicken Nation' });
    expect(pourLeClient.mentions).toEqual([]);
    expect(JSON.stringify(pourLeClient.replyTo)).not.toContain('Awa');

    // Le personnel garde la version complète.
    const [pourAwa] = recu(passerelle, 'agent-2', 'new:message');
    expect(pourAwa.replyTo.author.name).toBe('Awa Koné');
    expect(pourAwa.mentions).toHaveLength(1);
  });

  it("conversation interne : personne hors des membres, jamais la salle du restaurant", () => {
    const { service, passerelle } = monter();
    service.emitNewMessage(['agent-1', 'agent-2'], { restaurantId: 'r1', customerId: null }, message());
    expect(passerelle.emitToRestaurant).not.toHaveBeenCalled();
    const destinataires = passerelle.emitToUser.mock.calls.map((c) => c[0]);
    expect(destinataires).toEqual(['agent-2']); // l'auteur ne se reçoit pas
  });
});

describe('MessageWebSocketService.emitMessageSupprime', () => {
  it('le client reçoit aussi sa version', () => {
    const { service, passerelle } = monter();
    service.emitMessageSupprime({ id: 'c1', customerId: 'client-1' }, ['agent-2'], message());
    const [pourLeClient] = recu(passerelle, 'client-1', 'message:supprime');
    expect(pourLeClient.conversationId).toBe('c1');
    expect(pourLeClient.message.replyTo.author.id).toBeNull();
    expect(pourLeClient.message.mentions).toEqual([]);
  });
});
