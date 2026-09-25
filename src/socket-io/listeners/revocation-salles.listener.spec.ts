import { EntityStatus } from '@prisma/client';
import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter/dist/constants';
import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import { RevocationSallesListener } from './revocation-salles.listener';

function creer() {
  const gateway = {
    resynchroniserSallesLivreur: jest.fn().mockResolvedValue(undefined),
    deconnecterUtilisateur: jest.fn(),
  };
  const listener = new RevocationSallesListener(gateway as never);
  return { gateway, listener };
}

function evenementsEcoutes(methode: keyof RevocationSallesListener): string[] {
  const metadonnees = Reflect.getMetadata(
    EVENT_LISTENER_METADATA,
    RevocationSallesListener.prototype[methode],
  ) as { event: string }[];
  return metadonnees.map((m) => m.event);
}

describe('RevocationSallesListener', () => {
  it('écoute les événements internes déjà émis par les modules livreurs et utilisateurs', () => {
    expect(evenementsEcoutes('surLivreurModifie')).toEqual([DelivererChannels.DELIVERER_OPERATIONAL_CHANGED]);
    expect(evenementsEcoutes('surCompteDesactive')).toEqual(['user.deactivated']);
    expect(evenementsEcoutes('surCompteSupprime')).toEqual(['user.deleted']);
  });

  describe('livreur modifié', () => {
    it('réaffecté : rejoint la salle des livreurs du nouveau restaurant', async () => {
      const { gateway, listener } = creer();
      await listener.surLivreurModifie({
        deliverer: { id: 'd1', restaurant_id: 'r2', entity_status: EntityStatus.ACTIVE },
      });
      expect(gateway.resynchroniserSallesLivreur).toHaveBeenCalledWith('d1', 'r2');
    });

    it('supprimé : quitte toute salle de livreurs', async () => {
      const { gateway, listener } = creer();
      await listener.surLivreurModifie({
        deliverer: { id: 'd1', restaurant_id: 'r1', entity_status: EntityStatus.DELETED },
      });
      expect(gateway.resynchroniserSallesLivreur).toHaveBeenCalledWith('d1', null);
    });

    it('sans identifiant : ne fait rien', async () => {
      const { gateway, listener } = creer();
      await listener.surLivreurModifie({});
      await listener.surLivreurModifie({ deliverer: null });
      await listener.surLivreurModifie(undefined as never);
      expect(gateway.resynchroniserSallesLivreur).not.toHaveBeenCalled();
    });

    it('une erreur de la passerelle ne remonte jamais au flux métier', async () => {
      const { gateway, listener } = creer();
      gateway.resynchroniserSallesLivreur.mockRejectedValue(new Error('délai Redis dépassé'));
      await expect(
        listener.surLivreurModifie({
          deliverer: { id: 'd1', restaurant_id: 'r1', entity_status: EntityStatus.ACTIVE },
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('compte du personnel', () => {
    it('désactivé : ses sockets sont coupés', () => {
      const { gateway, listener } = creer();
      listener.surCompteDesactive({ data: { id: 'u1' } });
      expect(gateway.deconnecterUtilisateur).toHaveBeenCalledWith('u1');
    });

    it('supprimé : ses sockets sont coupés', () => {
      const { gateway, listener } = creer();
      listener.surCompteSupprime({ data: { id: 'u2' } });
      expect(gateway.deconnecterUtilisateur).toHaveBeenCalledWith('u2');
    });

    it('sans identifiant : ne fait rien', () => {
      const { gateway, listener } = creer();
      listener.surCompteDesactive({});
      listener.surCompteSupprime({ data: null });
      expect(gateway.deconnecterUtilisateur).not.toHaveBeenCalled();
    });

    it('une erreur de la passerelle ne remonte jamais au flux métier', () => {
      const { gateway, listener } = creer();
      gateway.deconnecterUtilisateur.mockImplementation(() => {
        throw new Error('Redis indisponible');
      });
      expect(() => listener.surCompteDesactive({ data: { id: 'u1' } })).not.toThrow();
    });
  });
});
