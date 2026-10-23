import { UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MESSAGE_JETON_EXPIRE } from 'src/json-web-token/json-web-token.service';
import { EVENEMENT_CONNEXION_ACCEPTEE } from '../utils/connexion-socket.util';
import { EVENEMENT_LIVREUR_CONNECTE } from '../utils/evenements-connexion.util';
import { AppGateway } from './app.gateway';

/**
 * Passerelle `/app` : contrôle d'entrée (acceptée, refusée avec un motif,
 * reportée sur panne passagère), salles rejointes à la connexion,
 * destinataires de chaque méthode d'émission, présence des livreurs et
 * révocation des salles. Le serveur socket.io est remplacé par un faux qui
 * enregistre les salles visées ; le client par un faux socket.
 */

type Emission = { salles: string | string[]; evenement: string; donnees: unknown };

function fauxServeur() {
  const emissions: Emission[] = [];
  const server = {
    to: jest.fn((salles: string | string[]) => ({
      emit: (evenement: string, donnees: unknown) => {
        emissions.push({ salles, evenement, donnees });
      },
    })),
    emit: jest.fn(),
    in: jest.fn(),
  };
  return { server, emissions };
}

function fauxPrisma() {
  return {
    customer: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    deliverer: { findUnique: jest.fn() },
    dailyPresenceCheck: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

function creerPasserelle() {
  const prisma = fauxPrisma();
  const jwt = { verifyToken: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const gateway = new AppGateway(prisma as never, jwt as never, eventEmitter as never);
  // Nouveaux essais sans attente dans les tests
  (gateway as unknown as { attentesRepriseMs: number[] }).attentesRepriseMs = [0, 0];
  const { server, emissions } = fauxServeur();
  gateway.server = server as never;
  const journal = {
    warn: jest.spyOn((gateway as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined),
    log: jest.spyOn((gateway as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined),
  };
  return { gateway, prisma, jwt, server, emissions, eventEmitter, journal };
}

function fauxClient(
  type: string | undefined,
  id = 'socket-1',
  handshake: { query?: Record<string, unknown>; auth?: Record<string, unknown> } = {
    query: { token: 'jeton', type },
  },
) {
  return {
    id,
    handshake: { query: {}, auth: {}, ...handshake },
    data: {} as Record<string, unknown>,
    join: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn(),
    once: jest.fn(),
    conn: { close: jest.fn() },
  };
}

/**
 * Parcours complet d'une connexion, comme socket.io : contrôle d'entrée, puis
 * `handleConnection` seulement si le contrôle a laissé passer.
 */
async function connecter(gateway: AppGateway, client: ReturnType<typeof fauxClient>) {
  const next = jest.fn();
  await gateway.controlerEntree(client as never, next);
  expect(next).toHaveBeenCalledTimes(1);
  const erreur = next.mock.calls[0][0] as (Error & { data?: unknown }) | undefined;
  if (!erreur) gateway.handleConnection(client as never);
  return erreur;
}

/** Erreur Prisma « base injoignable », comme en production quand Neon hoquette. */
const baseInjoignable = () =>
  new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
    code: 'P1001',
    clientVersion: 'test',
  });

describe('AppGateway', () => {
  describe('contrôle d\'entrée', () => {
    it('est branché sur l\'espace /app à l\'initialisation', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      const espace = { use: jest.fn() };
      gateway.afterInit(espace as never);
      expect(espace.use).toHaveBeenCalledTimes(1);

      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockResolvedValue({ id: 'd1', restaurant_id: null });
      const next = jest.fn();
      espace.use.mock.calls[0][0](fauxClient('deliverer'), next);
      await new Promise((r) => setImmediate(r));
      expect(next).toHaveBeenCalledWith();
    });

    it('accepté : salles rejointes AVANT « connect », puis accusé au client', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockResolvedValue({ id: 'd1', restaurant_id: 'r1' });
      const client = fauxClient('deliverer');

      const next = jest.fn(() => {
        // Au moment où socket.io enverra « connect », le socket est déjà dans ses salles.
        expect(client.join).toHaveBeenCalledWith(['deliverer_d1', 'livreurs_restaurant_r1']);
      });
      await gateway.controlerEntree(client as never, next);
      expect(next).toHaveBeenCalledWith();
      gateway.handleConnection(client as never);

      expect(client.emit).toHaveBeenCalledWith(EVENEMENT_CONNEXION_ACCEPTEE, { type: 'deliverer', id: 'd1' });
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.conn.close).not.toHaveBeenCalled();
    });

    it('jeton dans `auth` (paquet de connexion) : accepté comme dans la requête', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockResolvedValue({ id: 'd1', restaurant_id: null });
      const client = fauxClient(undefined, 's1', { auth: { token: 'jeton-auth', type: 'deliverer' } });

      expect(await connecter(gateway, client)).toBeUndefined();
      expect(jwt.verifyToken).toHaveBeenCalledWith('jeton-auth', 'deliverer');
    });

    it.each([
      ['sans jeton', { query: { type: 'deliverer' } }, 'JETON_ABSENT', true],
      ['sans type', { query: { token: 'jeton' } }, 'TYPE_INVALIDE', false],
      ['type inconnu', { query: { token: 'jeton', type: 'admin' } }, 'TYPE_INVALIDE', false],
    ])('%s : refus %s, sans toucher à la base', async (_cas, handshake, motif, rafraichir) => {
      const { gateway, jwt, prisma } = creerPasserelle();
      const client = fauxClient(undefined, 's1', handshake);

      const erreur = await connecter(gateway, client);

      expect(erreur?.message).toBe(motif);
      expect(erreur?.data).toEqual({ motif, rafraichir_jeton: rafraichir });
      expect(jwt.verifyToken).not.toHaveBeenCalled();
      expect(prisma.deliverer.findUnique).not.toHaveBeenCalled();
      expect(client.join).not.toHaveBeenCalled();
    });

    it('jeton refusé : JETON_INVALIDE, aucune salle, motif au journal', async () => {
      const { gateway, jwt, journal } = creerPasserelle();
      jwt.verifyToken.mockRejectedValue(new UnauthorizedException('Token invalide'));
      const client = fauxClient('deliverer');

      const erreur = await connecter(gateway, client);

      expect(erreur?.message).toBe('JETON_INVALIDE');
      expect(erreur?.data).toEqual({ motif: 'JETON_INVALIDE', rafraichir_jeton: true });
      expect(client.join).not.toHaveBeenCalled();
      expect(client.emit).not.toHaveBeenCalled();
      expect(client.conn.close).not.toHaveBeenCalled();
      expect(journal.warn).toHaveBeenCalledWith('Connexion refusée (JETON_INVALIDE) : livreur');
    });

    it('jeton périmé : JETON_EXPIRE, avec le livreur au journal', async () => {
      const { gateway, jwt, journal } = creerPasserelle();
      jwt.verifyToken.mockRejectedValue(new UnauthorizedException(MESSAGE_JETON_EXPIRE));
      const charge = Buffer.from(JSON.stringify({ sub: '5a0c0e7e-1111-2222-3333-444455556666' })).toString('base64url');
      const client = fauxClient('deliverer', 's1', { query: { token: `entete.${charge}.signature`, type: 'deliverer' } });

      const erreur = await connecter(gateway, client);

      expect(erreur?.message).toBe('JETON_EXPIRE');
      expect(erreur?.data).toEqual({ motif: 'JETON_EXPIRE', rafraichir_jeton: true });
      expect(journal.warn).toHaveBeenCalledWith('Connexion refusée (JETON_EXPIRE) : livreur 5a0c0e7e');
    });

    it('compte introuvable ou plus actif : COMPTE_INCONNU, un seul passage en base', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockResolvedValue(null);
      const client = fauxClient('deliverer');

      const erreur = await connecter(gateway, client);

      expect(erreur?.message).toBe('COMPTE_INCONNU');
      expect(erreur?.data).toEqual({ motif: 'COMPTE_INCONNU', rafraichir_jeton: false });
      expect(prisma.deliverer.findUnique).toHaveBeenCalledTimes(1);
      expect(client.conn.close).not.toHaveBeenCalled();
    });

    it('refus répétés : une ligne de journal par minute, le compte des autres ensuite', async () => {
      const { gateway, jwt, journal } = creerPasserelle();
      jwt.verifyToken.mockRejectedValue(new UnauthorizedException('Token invalide'));
      for (let i = 0; i < 5; i++) await connecter(gateway, fauxClient('deliverer', `s${i}`));
      expect(journal.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('panne passagère de la base pendant la connexion', () => {
    it('une erreur puis la base répond : la connexion aboutit (nouvel essai)', async () => {
      const { gateway, prisma, jwt, eventEmitter } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique
        .mockRejectedValueOnce(baseInjoignable())
        .mockResolvedValueOnce({ id: 'd1', restaurant_id: 'r1' });
      const client = fauxClient('deliverer');

      expect(await connecter(gateway, client)).toBeUndefined();

      expect(prisma.deliverer.findUnique).toHaveBeenCalledTimes(2);
      expect(client.join).toHaveBeenCalledWith(['deliverer_d1', 'livreurs_restaurant_r1']);
      expect(eventEmitter.emit).toHaveBeenCalledWith(EVENEMENT_LIVREUR_CONNECTE, { delivererId: 'd1' });
    });

    it('la base reste muette : transport fermé SANS refus, le client se reconnecte seul', async () => {
      const { gateway, prisma, jwt, journal } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: '5a0c0e7e-aaaa' });
      prisma.deliverer.findUnique.mockRejectedValue(baseInjoignable());
      const client = fauxClient('deliverer');
      const next = jest.fn();

      await gateway.controlerEntree(client as never, next);

      // Transport fermé AVANT next(erreur) : socket.io voit le transport fermé et
      // n'envoie aucun refus (le client voit « transport close », socket.active
      // reste vrai, la reconnexion automatique suit).
      expect(client.conn.close).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledTimes(1);
      expect(client.conn.close.mock.invocationCallOrder[0]).toBeLessThan(next.mock.invocationCallOrder[0]);
      const erreur = next.mock.calls[0][0] as Error & { data?: unknown };
      expect(erreur?.message).toBe('SERVICE_INDISPONIBLE');
      expect(erreur?.data).toBeUndefined();
      expect(prisma.deliverer.findUnique).toHaveBeenCalledTimes(3);
      expect(client.join).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(journal.warn).toHaveBeenCalledWith(
        'Connexion livreur 5a0c0e7e reportée (P1001) : le client va se reconnecter seul',
      );
    });

    it('l\'échec n\'est pas mis en cache : la tentative suivante relit la base et passe', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockRejectedValue(baseInjoignable());
      await connecter(gateway, fauxClient('deliverer', 's1'));

      prisma.deliverer.findUnique.mockReset().mockResolvedValue({ id: 'd1', restaurant_id: null });
      const client = fauxClient('deliverer', 's2');
      expect(await connecter(gateway, client)).toBeUndefined();
      expect(client.join).toHaveBeenCalledWith(['deliverer_d1']);
    });

    it('réserve de connexions saturée (P2024) : traitée comme une panne passagère', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'u1' });
      prisma.user.findUnique.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection', {
          code: 'P2024',
          clientVersion: 'test',
        }),
      );
      const client = fauxClient('user');

      await connecter(gateway, client);

      expect(client.conn.close).toHaveBeenCalledTimes(1);
    });

    it('requête mal formée (erreur définitive) : COMPTE_INCONNU sans nouvel essai', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'c1' });
      prisma.customer.findUnique.mockRejectedValue(
        new Prisma.PrismaClientValidationError('Argument id invalide', { clientVersion: 'test' }),
      );
      const client = fauxClient('customer');

      const erreur = await connecter(gateway, client);

      expect(erreur?.message).toBe('COMPTE_INCONNU');
      expect(prisma.customer.findUnique).toHaveBeenCalledTimes(1);
      expect(client.conn.close).not.toHaveBeenCalled();
    });

    it('une vague de reconnexions pendant la panne : une seule ligne de journal par minute', async () => {
      const { gateway, prisma, jwt, journal } = creerPasserelle();
      jwt.verifyToken.mockImplementation(async (token: string) => ({ sub: token }));
      prisma.deliverer.findUnique.mockRejectedValue(baseInjoignable());
      for (let i = 0; i < 4; i++) {
        await connecter(gateway, fauxClient('deliverer', `s${i}`, { query: { token: `d${i}`, type: 'deliverer' } }));
      }
      expect(journal.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('salles rejointes à la connexion', () => {
    it('livreur rattaché : son canal et la salle des livreurs, jamais restaurant_{id}', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockResolvedValue({ id: 'd1', restaurant_id: 'r1' });
      const client = fauxClient('deliverer');

      await connecter(gateway, client);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.join).toHaveBeenCalledTimes(1);
      expect(client.join).toHaveBeenCalledWith(['deliverer_d1', 'livreurs_restaurant_r1']);
    });

    it('livreur : annonce sa connexion pour que son offre en attente lui soit renvoyée', async () => {
      const { gateway, prisma, jwt, eventEmitter } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockResolvedValue({ id: 'd1', restaurant_id: 'r1' });

      await connecter(gateway, fauxClient('deliverer'));

      expect(eventEmitter.emit).toHaveBeenCalledWith(EVENEMENT_LIVREUR_CONNECTE, { delivererId: 'd1' });
    });

    it('livreur : connexion et déconnexion au journal, avec la raison socket.io', async () => {
      const { gateway, prisma, jwt, journal } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: '5a0c0e7e-aaaa' });
      prisma.deliverer.findUnique.mockResolvedValue({ id: '5a0c0e7e-aaaa', restaurant_id: 'r1' });
      const client = fauxClient('deliverer', 'socket-9');

      await connecter(gateway, client);
      expect(journal.log).toHaveBeenCalledWith('Livreur 5a0c0e7e connecté (socket socket-9)');

      const [evenement, surDeconnexion] = client.once.mock.calls[0];
      expect(evenement).toBe('disconnect');
      surDeconnexion('transport close');
      expect(journal.log).toHaveBeenLastCalledWith('Livreur 5a0c0e7e déconnecté (transport close) après 0 s');
    });

    it('version annoncée par l\'appli : écrite avec la connexion et avec un refus', async () => {
      const { gateway, prisma, jwt, journal } = creerPasserelle();
      jwt.verifyToken.mockResolvedValueOnce({ sub: '5a0c0e7e-aaaa' });
      prisma.deliverer.findUnique.mockResolvedValue({ id: '5a0c0e7e-aaaa', restaurant_id: null });
      await connecter(
        gateway,
        fauxClient('deliverer', 'socket-9', { auth: { token: 'jeton', type: 'deliverer', version: '1.4.2' } }),
      );
      expect(journal.log).toHaveBeenCalledWith('Livreur 5a0c0e7e connecté (socket socket-9, appli 1.4.2)');

      jwt.verifyToken.mockRejectedValueOnce(new UnauthorizedException('Token invalide'));
      await connecter(gateway, fauxClient('deliverer', 's2', { query: { token: 'j', type: 'deliverer', version: '1.3.0' } }));
      expect(journal.warn).toHaveBeenCalledWith('Connexion refusée (JETON_INVALIDE) : livreur (appli 1.3.0)');
    });

    it('personnel du point de vente : la salle de son restaurant', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'u1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', type: 'RESTAURANT', restaurant_id: 'r1' });
      const client = fauxClient('user');

      await connecter(gateway, client);

      expect(client.join).toHaveBeenCalledWith(['users', 'user_u1', 'restaurant_r1']);
    });

    it('backoffice : backoffice_all', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'u9' });
      prisma.user.findUnique.mockResolvedValue({ id: 'u9', type: 'BACKOFFICE', restaurant_id: null });
      const client = fauxClient('user');

      await connecter(gateway, client);

      expect(client.join).toHaveBeenCalledWith(['users', 'user_u9', 'backoffice_all']);
    });

    it('centre d\'appels : lit le rôle et rejoint la salle des relances', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'u7' });
      prisma.user.findUnique.mockResolvedValue({ id: 'u7', type: 'BACKOFFICE', restaurant_id: null, role: 'CALL_CENTER' });
      const client = fauxClient('user');

      await connecter(gateway, client);

      expect(prisma.user.findUnique.mock.calls[0][0].select).toEqual(
        expect.objectContaining({ role: true, type: true, restaurant_id: true }),
      );
      expect(client.join).toHaveBeenCalledWith(['users', 'user_u7', 'backoffice_all', 'relances_paniers']);
    });

    it('marketing : pas de salle des relances', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'u8' });
      prisma.user.findUnique.mockResolvedValue({ id: 'u8', type: 'BACKOFFICE', restaurant_id: null, role: 'MARKETING' });
      const client = fauxClient('user');

      await connecter(gateway, client);

      expect(client.join).toHaveBeenCalledWith(['users', 'user_u8', 'backoffice_all']);
    });

    it('client : la salle des clients et son canal, sans la salle « restaurants »', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'c1' });
      prisma.customer.findUnique.mockResolvedValue({ id: 'c1' });
      const client = fauxClient('customer');

      await connecter(gateway, client);

      expect(client.join).toHaveBeenCalledTimes(1);
      expect(client.join).toHaveBeenCalledWith(['customers', 'customer_c1']);
    });

    it('socket arrivé sans contrôle d\'entrée : coupé, jamais laissé sans salle', () => {
      const { gateway } = creerPasserelle();
      jest.spyOn((gateway as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
      const client = fauxClient('deliverer');

      gateway.handleConnection(client as never);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.emit).not.toHaveBeenCalled();
    });
  });

  describe('présence des livreurs', () => {
    const socketDistant = (salles: string[]) => ({ rooms: new Set(salles) });

    it('un seul aller-retour pour toute la liste, toutes instances comprises', async () => {
      const { gateway, server } = creerPasserelle();
      const fetchSockets = jest.fn().mockResolvedValue([
        socketDistant(['s1', 'deliverer_d1', 'livreurs_restaurant_r1']),
        socketDistant(['s2', 'deliverer_d1']),
        socketDistant(['s3', 'deliverer_d3']),
      ]);
      server.in.mockReturnValue({ fetchSockets });

      const connectes = await gateway.livreursConnectes(['d1', 'd2', 'd3']);

      expect(server.in).toHaveBeenCalledTimes(1);
      expect(server.in).toHaveBeenCalledWith(['deliverer_d1', 'deliverer_d2', 'deliverer_d3']);
      expect(connectes).toEqual(new Set(['d1', 'd3']));
      expect(await gateway.livreurConnecte('d2')).toBe(false);
    });

    it('liste vide : aucune question posée', async () => {
      const { gateway, server } = creerPasserelle();
      expect(await gateway.livreursConnectes([])).toEqual(new Set());
      expect(server.in).not.toHaveBeenCalled();
    });

    it('Redis en panne : présence inconnue (null), jamais « pas connecté »', async () => {
      const { gateway, server } = creerPasserelle();
      server.in.mockReturnValue({ fetchSockets: jest.fn().mockRejectedValue(new Error('timeout reached')) });
      expect(await gateway.livreursConnectes(['d1'])).toBeNull();
      expect(await gateway.livreurConnecte('d1')).toBeNull();
    });

    it('Redis muet : réponse inconnue au bout de 1,5 s, sans bloquer l\'appelant', async () => {
      jest.useFakeTimers();
      try {
        const { gateway, server } = creerPasserelle();
        server.in.mockReturnValue({ fetchSockets: jest.fn(() => new Promise(() => undefined)) });
        const reponse = gateway.livreurConnecte('d1');
        await jest.advanceTimersByTimeAsync(1500);
        expect(await reponse).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('ping', () => {
    it('accusé `{ connecte: true }` pour un socket connu, `pong` dans son canal comme avant', async () => {
      const { gateway, prisma, jwt, emissions } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockResolvedValue({ id: 'd1', restaurant_id: null });
      const client = fauxClient('deliverer', 's1');
      await connecter(gateway, client);

      expect(gateway.handlePing(client as never)).toEqual({ connecte: true });
      expect(emissions).toEqual([expect.objectContaining({ salles: 'deliverer_d1', evenement: 'pong' })]);
      expect(gateway.handlePing(fauxClient('deliverer', 'inconnu') as never)).toEqual({ connecte: false });
    });
  });

  describe('émissions', () => {
    it('emitToRestaurant : une commande reste au personnel du restaurant', () => {
      const { gateway, emissions } = creerPasserelle();
      gateway.emitToRestaurant('r1', 'order:created', { id: 'o1', phone: '+2250700000000' });
      expect(emissions).toEqual([
        { salles: ['restaurant_r1'], evenement: 'order:created', donnees: { id: 'o1', phone: '+2250700000000' } },
      ]);
    });

    it('emitToRestaurant : la file d\'attente atteint aussi les livreurs, en une seule émission', () => {
      const { gateway, emissions } = creerPasserelle();
      const charge = { delivererId: 'd2', timestamp: '2026-09-25T10:00:00.000Z' };
      gateway.emitToRestaurant('r1', 'deliverer:queue:changed', charge);
      expect(emissions).toEqual([
        {
          salles: ['restaurant_r1', 'livreurs_restaurant_r1'],
          evenement: 'deliverer:queue:changed',
          donnees: charge,
        },
      ]);
    });

    it('emitToRestaurant : retire toujours les secrets du restaurant', () => {
      const { gateway, emissions } = creerPasserelle();
      gateway.emitToRestaurant('r1', 'order:updated', {
        id: 'o1',
        restaurant: { id: 'r1', name: 'Zone 4', apikey: 'cle-turbo', hubrise_access_token: 'jeton' },
      });
      expect(emissions[0].donnees).toEqual({ id: 'o1', restaurant: { id: 'r1', name: 'Zone 4' } });
    });

    it('emitToUser et emitToDeliverer visent le canal privé', () => {
      const { gateway, emissions } = creerPasserelle();
      gateway.emitToUser('c1', 'customer', 'a', 1);
      gateway.emitToUser('u1', 'user', 'b', 2);
      gateway.emitToUser('d1', 'deliverer', 'c', 3);
      gateway.emitToDeliverer('d2', 'd', 4);
      expect(emissions.map((e) => e.salles)).toEqual(['customer_c1', 'user_u1', 'deliverer_d1', 'deliverer_d2']);
    });

    it('emitToBackoffice vise backoffice_all', () => {
      const { gateway, emissions } = creerPasserelle();
      gateway.emitToBackoffice('x', {});
      expect(emissions[0].salles).toBe('backoffice_all');
    });

    it('emitToRelances vise la seule salle des relances', () => {
      const { gateway, emissions } = creerPasserelle();
      gateway.emitToRelances('relance:changed', { motif: 'alerte', ids: ['o1'], nouvelles: ['o1'] });
      expect(emissions).toEqual([
        {
          salles: 'relances_paniers',
          evenement: 'relance:changed',
          donnees: { motif: 'alerte', ids: ['o1'], nouvelles: ['o1'] },
        },
      ]);
    });

    it('emitToUserType garde les salles « customers » et « users »', () => {
      const { gateway, emissions } = creerPasserelle();
      gateway.emitToUserType('customers', 'menu:updated', { id: 'p1' });
      gateway.emitToUserType('users', 'x', {});
      expect(emissions.map((e) => e.salles)).toEqual(['customers', 'users']);
    });

    it('n\'expose plus d\'émission vers tous les livreurs', () => {
      const { gateway } = creerPasserelle();
      expect((gateway as unknown as Record<string, unknown>).emitToAllDeliverers).toBeUndefined();
    });
  });

  describe('resynchroniserSallesLivreur', () => {
    function socketLivreur(salles: string[]) {
      const rooms = new Set(salles);
      return {
        rooms,
        join: jest.fn((salle: string) => {
          rooms.add(salle);
        }),
        leave: jest.fn((salle: string) => {
          rooms.delete(salle);
        }),
      };
    }

    it('réaffectation : quitte l\'ancienne salle des livreurs et rejoint la nouvelle', async () => {
      const { gateway, server } = creerPasserelle();
      const telephone = socketLivreur(['s1', 'deliverer_d1', 'livreurs_restaurant_r1']);
      const tablette = socketLivreur(['s2', 'deliverer_d1', 'livreurs_restaurant_r1']);
      server.in.mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([telephone, tablette]) });

      await gateway.resynchroniserSallesLivreur('d1', 'r2');

      expect(server.in).toHaveBeenCalledWith('deliverer_d1');
      for (const socket of [telephone, tablette]) {
        expect(socket.leave).toHaveBeenCalledWith('livreurs_restaurant_r1');
        expect(socket.join).toHaveBeenCalledWith('livreurs_restaurant_r2');
        expect(socket.rooms.has('deliverer_d1')).toBe(true);
      }
    });

    it('livreur supprimé ou sans restaurant : ne garde que son canal privé', async () => {
      const { gateway, server } = creerPasserelle();
      const socket = socketLivreur(['s1', 'deliverer_d1', 'livreurs_restaurant_r1']);
      server.in.mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([socket]) });

      await gateway.resynchroniserSallesLivreur('d1', null);

      expect([...socket.rooms]).toEqual(['s1', 'deliverer_d1']);
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('déjà dans la bonne salle : rien ne bouge', async () => {
      const { gateway, server } = creerPasserelle();
      const socket = socketLivreur(['s1', 'deliverer_d1', 'livreurs_restaurant_r1']);
      server.in.mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([socket]) });

      await gateway.resynchroniserSallesLivreur('d1', 'r1');

      expect(socket.leave).not.toHaveBeenCalled();
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('vide le cache : la connexion suivante relit la fiche du livreur', async () => {
      const { gateway, server, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockResolvedValueOnce({ id: 'd1', restaurant_id: 'r1' });
      await connecter(gateway, fauxClient('deliverer', 's1'));

      server.in.mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([]) });
      await gateway.resynchroniserSallesLivreur('d1', 'r2');

      prisma.deliverer.findUnique.mockResolvedValueOnce({ id: 'd1', restaurant_id: 'r2' });
      const client = fauxClient('deliverer', 's2');
      await connecter(gateway, client);

      expect(prisma.deliverer.findUnique).toHaveBeenCalledTimes(2);
      expect(client.join).toHaveBeenCalledWith(['deliverer_d1', 'livreurs_restaurant_r2']);
    });
  });

  describe('deconnecterUtilisateur', () => {
    it('coupe tous les sockets du compte, et seulement les siens', () => {
      const { gateway, server } = creerPasserelle();
      const disconnectSockets = jest.fn();
      server.in.mockReturnValue({ disconnectSockets });

      gateway.deconnecterUtilisateur('u1');

      expect(server.in).toHaveBeenCalledWith('user_u1');
      expect(disconnectSockets).toHaveBeenCalledWith(true);
    });

    it('vide le cache : la reconnexion relit le compte (désactivé, donc refusée)', async () => {
      const { gateway, server, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'u1' });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', type: 'BACKOFFICE', restaurant_id: null });
      await connecter(gateway, fauxClient('user', 's1'));

      server.in.mockReturnValue({ disconnectSockets: jest.fn() });
      gateway.deconnecterUtilisateur('u1');

      prisma.user.findUnique.mockResolvedValueOnce(null);
      const client = fauxClient('user', 's2');
      const erreur = await connecter(gateway, client);

      expect(client.join).not.toHaveBeenCalled();
      expect(erreur?.message).toBe('COMPTE_INCONNU');
    });
  });
});
