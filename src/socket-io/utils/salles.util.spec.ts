import { EntityStatus } from '@prisma/client';
import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import {
  EVENEMENTS_RESTAURANT_POUR_LIVREURS,
  SALLE_BACKOFFICE,
  SALLE_CLIENTS,
  SALLE_PERSONNEL,
  estRelayeAuxLivreurs,
  restaurantSuiviParLivreur,
  salleClient,
  salleLivreur,
  salleLivreursRestaurant,
  sallePersonnelle,
  salleRestaurant,
  salleUtilisateur,
  sallesAJoindre,
  sallesDiffusionRestaurant,
  sallesLivreursARetirer,
} from './salles.util';

const R1 = 'resto-1';
const R2 = 'resto-2';

describe('salles.util', () => {
  describe('noms de salles', () => {
    it('garde les noms historiques des salles que les émetteurs ciblent déjà', () => {
      expect(SALLE_CLIENTS).toBe('customers');
      expect(SALLE_PERSONNEL).toBe('users');
      expect(SALLE_BACKOFFICE).toBe('backoffice_all');
      expect(salleClient('c1')).toBe('customer_c1');
      expect(salleUtilisateur('u1')).toBe('user_u1');
      expect(salleLivreur('d1')).toBe('deliverer_d1');
      expect(salleRestaurant(R1)).toBe('restaurant_resto-1');
    });

    it('donne aux livreurs une salle distincte de celle du personnel', () => {
      expect(salleLivreursRestaurant(R1)).toBe('livreurs_restaurant_resto-1');
      expect(salleLivreursRestaurant(R1)).not.toBe(salleRestaurant(R1));
    });

    it('associe chaque type de jeton à son canal privé', () => {
      expect(sallePersonnelle('customer', 'x')).toBe('customer_x');
      expect(sallePersonnelle('user', 'x')).toBe('user_x');
      expect(sallePersonnelle('deliverer', 'x')).toBe('deliverer_x');
    });
  });

  describe('sallesAJoindre', () => {
    it('client : la salle des clients et son canal privé, rien de plus', () => {
      expect(sallesAJoindre({ id: 'c1', type: 'customer' })).toEqual(['customers', 'customer_c1']);
    });

    it('client : ignore un restaurant ou un type de personnel qui lui serait attribué', () => {
      const salles = sallesAJoindre({
        id: 'c1',
        type: 'customer',
        userType: 'BACKOFFICE',
        restaurantId: R1,
      });
      expect(salles).toEqual(['customers', 'customer_c1']);
    });

    it('compte BACKOFFICE : personnel, canal privé et backoffice_all', () => {
      expect(sallesAJoindre({ id: 'u1', type: 'user', userType: 'BACKOFFICE' })).toEqual([
        'users',
        'user_u1',
        'backoffice_all',
      ]);
    });

    it('compte BACKOFFICE : jamais la salle d\'un restaurant, même rattaché', () => {
      const salles = sallesAJoindre({ id: 'u1', type: 'user', userType: 'BACKOFFICE', restaurantId: R1 });
      expect(salles).not.toContain(salleRestaurant(R1));
    });

    it('personnel d\'un point de vente : la salle de SON restaurant uniquement', () => {
      expect(
        sallesAJoindre({ id: 'u2', type: 'user', userType: 'RESTAURANT', restaurantId: R1 }),
      ).toEqual(['users', 'user_u2', 'restaurant_resto-1']);
    });

    it('personnel d\'un point de vente sans restaurant : aucune salle de restaurant', () => {
      expect(sallesAJoindre({ id: 'u2', type: 'user', userType: 'RESTAURANT' })).toEqual([
        'users',
        'user_u2',
      ]);
    });

    it('personnel sans type connu : ni backoffice_all ni restaurant', () => {
      expect(sallesAJoindre({ id: 'u3', type: 'user', restaurantId: R1 })).toEqual(['users', 'user_u3']);
    });

    it('livreur rattaché : son canal privé et la salle des livreurs du restaurant', () => {
      expect(sallesAJoindre({ id: 'd1', type: 'deliverer', restaurantId: R1 })).toEqual([
        'deliverer_d1',
        'livreurs_restaurant_resto-1',
      ]);
    });

    it('livreur rattaché : jamais la salle du personnel du restaurant', () => {
      const salles = sallesAJoindre({ id: 'd1', type: 'deliverer', restaurantId: R1 });
      expect(salles).not.toContain(salleRestaurant(R1));
      expect(salles).not.toContain('users');
      expect(salles).not.toContain('backoffice_all');
    });

    it('livreur sans restaurant : son canal privé seulement', () => {
      expect(sallesAJoindre({ id: 'd1', type: 'deliverer' })).toEqual(['deliverer_d1']);
    });

    it('livreur : ignore un type de personnel qui lui serait attribué', () => {
      const salles = sallesAJoindre({ id: 'd1', type: 'deliverer', userType: 'BACKOFFICE', restaurantId: R1 });
      expect(salles).toEqual(['deliverer_d1', 'livreurs_restaurant_resto-1']);
    });

    it('type inconnu : aucune salle', () => {
      expect(sallesAJoindre({ id: 'x', type: 'autre' as never })).toEqual([]);
    });

    it('plus aucune salle commune à tous les sockets ni à tous les livreurs', () => {
      const connexions = [
        { id: 'c1', type: 'customer' as const },
        { id: 'u1', type: 'user' as const, userType: 'BACKOFFICE' as const },
        { id: 'u2', type: 'user' as const, userType: 'RESTAURANT' as const, restaurantId: R1 },
        { id: 'd1', type: 'deliverer' as const, restaurantId: R1 },
      ];
      for (const connexion of connexions) {
        const salles = sallesAJoindre(connexion);
        expect(salles).not.toContain('restaurants');
        expect(salles).not.toContain('deliverers');
      }
    });

    it('seuls les clients sont dans la salle des clients', () => {
      expect(sallesAJoindre({ id: 'u1', type: 'user', userType: 'BACKOFFICE' })).not.toContain('customers');
      expect(sallesAJoindre({ id: 'd1', type: 'deliverer', restaurantId: R1 })).not.toContain('customers');
    });
  });

  describe('diffusion vers un restaurant', () => {
    it('ne relaie aux livreurs que la file d\'attente', () => {
      expect([...EVENEMENTS_RESTAURANT_POUR_LIVREURS]).toEqual([DelivererChannels.DELIVERER_QUEUE_CHANGED]);
      expect(estRelayeAuxLivreurs('deliverer:queue:changed')).toBe(true);
    });

    it('deliverer:queue:changed part au personnel ET aux livreurs du restaurant', () => {
      expect(sallesDiffusionRestaurant(R1, 'deliverer:queue:changed')).toEqual([
        'restaurant_resto-1',
        'livreurs_restaurant_resto-1',
      ]);
    });

    it.each([
      // Commandes : nom, téléphone, adresse et point GPS du client
      'order:created',
      'order:statusUpdated',
      'order:updated',
      'order:deleted',
      // Courses de tout le restaurant, celles des collègues comprises
      'course:assigned',
      'course:statut:changed',
      'course:completed',
      'course:cancelled',
      // Fiche complète des collègues et leur position à chaque relevé
      'deliverer:operational:changed',
      'deliverer:location:live',
      // Tickets, notes internes comprises, et conversations des clients
      'new:ticket',
      'update:ticket',
      'new:ticket_message',
      'new:customer_conversation',
      'new:message',
      'messages:read',
      // Cloche du personnel et promotions
      'notification:new',
      'promotion:created',
    ])('%s reste au personnel du restaurant', (evenement) => {
      expect(estRelayeAuxLivreurs(evenement)).toBe(false);
      expect(sallesDiffusionRestaurant(R1, evenement)).toEqual(['restaurant_resto-1']);
    });

    it('ne relaie pas un nom voisin ou un préfixe de la file', () => {
      expect(estRelayeAuxLivreurs('deliverer:queue')).toBe(false);
      expect(estRelayeAuxLivreurs('deliverer:queue:changed:x')).toBe(false);
      expect(estRelayeAuxLivreurs('DELIVERER:QUEUE:CHANGED')).toBe(false);
      expect(estRelayeAuxLivreurs('')).toBe(false);
    });

    it('reste dans le restaurant demandé', () => {
      const salles = sallesDiffusionRestaurant(R2, 'deliverer:queue:changed');
      expect(salles).toEqual(['restaurant_resto-2', 'livreurs_restaurant_resto-2']);
    });
  });

  describe('restaurantSuiviParLivreur', () => {
    it('livreur actif rattaché : son restaurant', () => {
      expect(restaurantSuiviParLivreur({ restaurant_id: R1, entity_status: EntityStatus.ACTIVE })).toBe(R1);
    });

    it('livreur supprimé : aucun, même s\'il garde un restaurant', () => {
      expect(restaurantSuiviParLivreur({ restaurant_id: R1, entity_status: EntityStatus.DELETED })).toBeNull();
    });

    it('livreur inactif : aucun', () => {
      expect(restaurantSuiviParLivreur({ restaurant_id: R1, entity_status: EntityStatus.INACTIVE })).toBeNull();
    });

    it('statut absent : aucun, par prudence', () => {
      expect(restaurantSuiviParLivreur({ restaurant_id: R1 })).toBeNull();
      expect(restaurantSuiviParLivreur({ restaurant_id: R1, entity_status: null })).toBeNull();
    });

    it('livreur actif sans restaurant : aucun', () => {
      expect(restaurantSuiviParLivreur({ restaurant_id: null, entity_status: EntityStatus.ACTIVE })).toBeNull();
      expect(restaurantSuiviParLivreur({ restaurant_id: '', entity_status: EntityStatus.ACTIVE })).toBeNull();
      expect(restaurantSuiviParLivreur({ entity_status: EntityStatus.ACTIVE })).toBeNull();
    });
  });

  describe('sallesLivreursARetirer', () => {
    const salles = new Set([
      'socket-id',
      'deliverer_d1',
      'livreurs_restaurant_resto-1',
      'livreurs_restaurant_resto-2',
    ]);

    it('réaffectation : retire l\'ancienne salle et garde la nouvelle', () => {
      expect(sallesLivreursARetirer(salles, salleLivreursRestaurant(R2))).toEqual([
        'livreurs_restaurant_resto-1',
      ]);
    });

    it('sans restaurant : retire toutes les salles de livreurs', () => {
      expect(sallesLivreursARetirer(salles, null)).toEqual([
        'livreurs_restaurant_resto-1',
        'livreurs_restaurant_resto-2',
      ]);
    });

    it('ne touche jamais au canal privé ni à la salle propre du socket', () => {
      const retirees = sallesLivreursARetirer(salles, null);
      expect(retirees).not.toContain('deliverer_d1');
      expect(retirees).not.toContain('socket-id');
    });

    it('ne confond pas la salle du personnel avec celle des livreurs', () => {
      expect(sallesLivreursARetirer(['restaurant_resto-1', 'user_u1', 'backoffice_all'], null)).toEqual([]);
    });

    it('rien à retirer quand le socket est déjà dans la bonne salle seulement', () => {
      expect(
        sallesLivreursARetirer(['deliverer_d1', 'livreurs_restaurant_resto-1'], salleLivreursRestaurant(R1)),
      ).toEqual([]);
    });
  });
});
