/**
 * Annulation automatique d'une course bloquée : jamais une commande de client
 * (« une commande ne s'annule que manuellement »), et frais de livraison.
 */
import { DeliveryStatut, OrderStatus } from '@prisma/client';

import { fraisLivraisonCourse, issueAnnulationAuto, trierCommandesAnnulationAuto } from './remise-course.rules';

const l = (id: string, status: OrderStatus, statut: DeliveryStatut = DeliveryStatut.PENDING) => ({
  id,
  statut,
  order: { id: `o-${id}`, reference: `CMD-${id}`, status },
});

describe('trierCommandesAnnulationAuto', () => {
  it('remises (PICKED_UP et au-delà), au restaurant (READY), le reste intact', () => {
    const tri = trierCommandesAnnulationAuto([
      l('a', OrderStatus.READY),
      l('b', OrderStatus.PICKED_UP),
      l('c', OrderStatus.COLLECTED),
      l('d', OrderStatus.COMPLETED),
      l('e', OrderStatus.CANCELLED, DeliveryStatut.CANCELLED),
      // Commande prête mais livraison déjà détachée : plus rien à relancer ici.
      l('f', OrderStatus.READY, DeliveryStatut.CANCELLED),
    ]);
    expect(tri.remises.map((x) => x.id)).toEqual(['b', 'c', 'd']);
    expect(tri.auRestaurant.map((x) => x.id)).toEqual(['a']);
    expect(tri.autres.map((x) => x.id)).toEqual(['e', 'f']);
  });

  it('au moins une commande remise : la course part en livraison ; aucune : annulée (pas ses commandes)', () => {
    expect(issueAnnulationAuto(trierCommandesAnnulationAuto([l('a', OrderStatus.READY), l('b', OrderStatus.PICKED_UP)]))).toBe(
      'EN_LIVRAISON',
    );
    expect(issueAnnulationAuto(trierCommandesAnnulationAuto([l('a', OrderStatus.READY)]))).toBe('ANNULEE');
    expect(issueAnnulationAuto(trierCommandesAnnulationAuto([]))).toBe('ANNULEE');
  });
});

describe('fraisLivraisonCourse', () => {
  it('somme des frais des livraisons non annulées', () => {
    expect(
      fraisLivraisonCourse([
        { statut: DeliveryStatut.PENDING, order: { delivery_fee: 1000 } },
        { statut: DeliveryStatut.DELIVERED, order: { delivery_fee: 1500 } },
        { statut: DeliveryStatut.CANCELLED, order: { delivery_fee: 700 } },
        { statut: DeliveryStatut.IN_ROUTE, order: { delivery_fee: null } },
      ]),
    ).toBe(2500);
    expect(fraisLivraisonCourse([])).toBe(0);
  });
});
