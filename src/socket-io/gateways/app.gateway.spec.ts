import { AppGateway } from './app.gateway';

/**
 * Passerelle `/app` : salles rejointes à la connexion, destinataires de chaque
 * méthode d'émission et révocation des salles. Le serveur socket.io est
 * remplacé par un faux qui enregistre les salles visées.
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
  const { server, emissions } = fauxServeur();
  gateway.server = server as never;
  return { gateway, prisma, jwt, server, emissions };
}

function fauxClient(type: string, id = 'socket-1') {
  return {
    id,
    handshake: { query: { token: 'jeton', type } },
    join: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn(),
  };
}

describe('AppGateway', () => {
  describe('salles rejointes à la connexion', () => {
    it('livreur rattaché : son canal et la salle des livreurs, jamais restaurant_{id}', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'd1' });
      prisma.deliverer.findUnique.mockResolvedValue({ id: 'd1', restaurant_id: 'r1' });
      const client = fauxClient('deliverer');

      await gateway.handleConnection(client as never);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.join).toHaveBeenCalledTimes(1);
      expect(client.join).toHaveBeenCalledWith(['deliverer_d1', 'livreurs_restaurant_r1']);
    });

    it('personnel du point de vente : la salle de son restaurant', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'u1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', type: 'RESTAURANT', restaurant_id: 'r1' });
      const client = fauxClient('user');

      await gateway.handleConnection(client as never);

      expect(client.join).toHaveBeenCalledWith(['users', 'user_u1', 'restaurant_r1']);
    });

    it('backoffice : backoffice_all', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'u9' });
      prisma.user.findUnique.mockResolvedValue({ id: 'u9', type: 'BACKOFFICE', restaurant_id: null });
      const client = fauxClient('user');

      await gateway.handleConnection(client as never);

      expect(client.join).toHaveBeenCalledWith(['users', 'user_u9', 'backoffice_all']);
    });

    it('client : la salle des clients et son canal, sans la salle « restaurants »', async () => {
      const { gateway, prisma, jwt } = creerPasserelle();
      jwt.verifyToken.mockResolvedValue({ sub: 'c1' });
      prisma.customer.findUnique.mockResolvedValue({ id: 'c1' });
      const client = fauxClient('customer');

      await gateway.handleConnection(client as never);

      expect(client.join).toHaveBeenCalledTimes(1);
      expect(client.join).toHaveBeenCalledWith(['customers', 'customer_c1']);
    });

    it('jeton refusé : aucune salle', async () => {
      const { gateway, jwt } = creerPasserelle();
      jwt.verifyToken.mockRejectedValue(new Error('invalide'));
      const client = fauxClient('deliverer');

      await gateway.handleConnection(client as never);

      expect(client.join).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
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
      await gateway.handleConnection(fauxClient('deliverer', 's1') as never);

      server.in.mockReturnValue({ fetchSockets: jest.fn().mockResolvedValue([]) });
      await gateway.resynchroniserSallesLivreur('d1', 'r2');

      prisma.deliverer.findUnique.mockResolvedValueOnce({ id: 'd1', restaurant_id: 'r2' });
      const client = fauxClient('deliverer', 's2');
      await gateway.handleConnection(client as never);

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
      await gateway.handleConnection(fauxClient('user', 's1') as never);

      server.in.mockReturnValue({ disconnectSockets: jest.fn() });
      gateway.deconnecterUtilisateur('u1');

      prisma.user.findUnique.mockResolvedValueOnce(null);
      const client = fauxClient('user', 's2');
      await gateway.handleConnection(client as never);

      expect(client.join).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
    });
  });
});
