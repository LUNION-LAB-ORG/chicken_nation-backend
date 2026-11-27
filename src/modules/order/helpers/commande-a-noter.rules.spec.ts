import { EntityStatus, OrderStatus } from '@prisma/client';

import {
  DELAI_AVANT_NOTE_MS,
  commandeNotable,
  commandesANoterWhere,
  refusDeNoter,
} from './commande-a-noter.rules';

/**
 * Note d'une commande (27/11) : « le client ne doit pas noter et laisser un
 * commentaire pour une commande qui n'a pas été terminée ».
 */
describe('commandes à noter', () => {
  const commande = (status: OrderStatus, entity_status: EntityStatus = EntityStatus.ACTIVE) => ({ status, entity_status });

  it('une commande terminée ou remise au client se note', () => {
    expect(commandeNotable(commande(OrderStatus.COMPLETED))).toBe(true);
    expect(commandeNotable(commande(OrderStatus.COLLECTED))).toBe(true);
    expect(refusDeNoter(commande(OrderStatus.COMPLETED))).toBeNull();
  });

  it('une commande annulée ne se note pas', () => {
    expect(commandeNotable(commande(OrderStatus.CANCELLED))).toBe(false);
    expect(refusDeNoter(commande(OrderStatus.CANCELLED))).toBe('Cette commande a été annulée : elle ne peut pas être notée.');
  });

  it('une commande supprimée ne se note pas, même terminée', () => {
    expect(commandeNotable(commande(OrderStatus.COMPLETED, EntityStatus.DELETED))).toBe(false);
    expect(commandeNotable(commande(OrderStatus.COLLECTED, EntityStatus.DELETED))).toBe(false);
    expect(refusDeNoter(commande(OrderStatus.COMPLETED, EntityStatus.DELETED))).toBe(
      'Cette commande a été annulée : elle ne peut pas être notée.',
    );
  });

  it("une commande qui n'est pas finie ne se note pas", () => {
    for (const statut of [OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.IN_PROGRESS, OrderStatus.READY, OrderStatus.PICKED_UP]) {
      expect(commandeNotable(commande(statut))).toBe(false);
      expect(refusDeNoter(commande(statut))).toBe('Vous ne pouvez commenter que les commandes terminées');
    }
  });

  it('la liste ne garde que les commandes finies depuis trente minutes, non supprimées, sans note', () => {
    const maintenant = new Date('2026-11-27T12:00:00Z');
    const where = commandesANoterWhere('cli-1', maintenant);
    expect(where.customer_id).toBe('cli-1');
    expect(where.status).toEqual({ in: [OrderStatus.COLLECTED, OrderStatus.COMPLETED] });
    expect(where.entity_status).toEqual({ not: EntityStatus.DELETED });
    expect(where.Comment).toEqual({ none: {} });
    const seuil = new Date(maintenant.getTime() - DELAI_AVANT_NOTE_MS);
    expect(seuil.toISOString()).toBe('2026-11-27T11:30:00.000Z');
    expect(where.OR).toEqual([{ completed_at: { lte: seuil } }, { collected_at: { lte: seuil } }]);
  });
});
