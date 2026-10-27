/**
 * Commande à livrer passée à emporter ou sur place (demande du 27/10) : que
 * devient sa livraison ? Règle pure, un cas par test.
 */
import { CourseStatut, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import {
  deciderDetachement,
  LivraisonDeLaCommande,
  MESSAGE_ENVOI_TURBO_EN_COURS,
  messageLivreurTurboEngage,
  messageSacChezLeLivreur,
  quitteLaLivraison,
  raisonCourseVide,
  raisonRelanceImpossible,
  suiteDuRetrait,
} from './detachement-commande.rules';

const MAINTENANT = new Date('2026-10-27T12:00:00.000Z');
const ilYa = (s: number) => new Date(MAINTENANT.getTime() - s * 1000);

function livraison(
  course: Partial<LivraisonDeLaCommande['course']> = {},
  statut: DeliveryStatut = DeliveryStatut.PENDING,
): LivraisonDeLaCommande {
  return {
    id: 'liv-a',
    statut,
    course: {
      id: 'course-1',
      statut: CourseStatut.PENDING_ASSIGNMENT,
      deliverer_id: null,
      parti_at: null,
      turbo_escalated_at: null,
      deliveries: [{ turbo_courier_id: null }],
      ...course,
    },
  };
}

const decider = (l: LivraisonDeLaCommande | null, statutCommande: OrderStatus = OrderStatus.READY, typeApres: OrderType = OrderType.PICKUP) =>
  deciderDetachement({ statutCommande, typeApres, livraison: l, maintenant: MAINTENANT });

describe('quitteLaLivraison', () => {
  it('à livrer vers à emporter ou sur place : oui ; le reste : non', () => {
    expect(quitteLaLivraison(OrderType.DELIVERY, OrderType.PICKUP)).toBe(true);
    expect(quitteLaLivraison(OrderType.DELIVERY, OrderType.TABLE)).toBe(true);
    expect(quitteLaLivraison(OrderType.DELIVERY, OrderType.DELIVERY)).toBe(false);
    expect(quitteLaLivraison(OrderType.DELIVERY, undefined)).toBe(false);
    // L'inverse ne retire rien : la commande entre dans le circuit normal quand elle sera prête.
    expect(quitteLaLivraison(OrderType.PICKUP, OrderType.DELIVERY)).toBe(false);
  });
});

describe('deciderDetachement', () => {
  it('pas de course : rien', () => {
    expect(decider(null)).toEqual({ action: 'RIEN' });
  });

  it('course sans livreur ou proposée : livraison retirée', () => {
    expect(decider(livraison())).toEqual({ action: 'DETACHER', cas: 'SANS_LIVREUR' });
    expect(decider(livraison({ statut: CourseStatut.EXPIRED }))).toEqual({ action: 'DETACHER', cas: 'SANS_LIVREUR' });
  });

  it('livreur en route, au restaurant, ou course récupérée sans cette commande : livraison retirée', () => {
    for (const statut of [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY]) {
      expect(decider(livraison({ statut, deliverer_id: 'livreur-1' }))).toEqual({ action: 'DETACHER', cas: 'AVEC_LIVREUR' });
    }
  });

  it('commande déjà remise au livreur : refus, le sac est avec lui', () => {
    const refus = decider(livraison({ statut: CourseStatut.IN_DELIVERY, deliverer_id: 'livreur-1' }), OrderStatus.PICKED_UP);
    expect(refus).toEqual({ action: 'REFUSER', message: messageSacChezLeLivreur(OrderType.PICKUP) });
    expect(messageSacChezLeLivreur(OrderType.PICKUP)).toBe(
      'Le livreur a déjà récupéré cette commande : le sac est avec lui, elle ne peut plus passer à emporter.',
    );
  });

  it('livraison déjà commencée : refus', () => {
    const l = livraison({ statut: CourseStatut.IN_DELIVERY, deliverer_id: 'livreur-1', parti_at: ilYa(60) }, DeliveryStatut.IN_ROUTE);
    expect(decider(l)).toEqual({ action: 'REFUSER', message: messageSacChezLeLivreur(OrderType.PICKUP) });
  });

  it('course partie sans cette commande, restée au comptoir : livraison retirée', () => {
    const l = livraison({ statut: CourseStatut.IN_DELIVERY, deliverer_id: 'livreur-1', parti_at: ilYa(60) });
    expect(decider(l, OrderStatus.READY, OrderType.TABLE)).toEqual({ action: 'DETACHER', cas: 'AVEC_LIVREUR' });
  });

  it('course confiée à Turbo, aucun livreur Turbo : retrait par l’annulation chez Turbo', () => {
    expect(decider(livraison({ turbo_escalated_at: ilYa(300) }))).toEqual({ action: 'DETACHER', cas: 'TURBO' });
  });

  it('livreur Turbo déjà engagé (course acceptée ou livreur affecté) : refus', () => {
    const message = messageLivreurTurboEngage(OrderType.PICKUP);
    expect(decider(livraison({ turbo_escalated_at: ilYa(300), statut: CourseStatut.ACCEPTED }))).toEqual({ action: 'REFUSER', message });
    expect(
      decider(livraison({ turbo_escalated_at: ilYa(300), deliveries: [{ turbo_courier_id: 'turbo-7' }] })),
    ).toEqual({ action: 'REFUSER', message });
  });

  it('course confiée à Turbo il y a moins de 30 s : refus, l’envoi est peut-être en route', () => {
    expect(decider(livraison({ turbo_escalated_at: ilYa(10) }))).toEqual({ action: 'REFUSER', message: MESSAGE_ENVOI_TURBO_EN_COURS });
  });

  it('livraison ou course terminée, commande annulée : rien', () => {
    expect(decider(livraison({}, DeliveryStatut.CANCELLED))).toEqual({ action: 'RIEN' });
    expect(decider(livraison({}, DeliveryStatut.DELIVERED), OrderStatus.COMPLETED)).toEqual({ action: 'RIEN' });
    expect(decider(livraison({ statut: CourseStatut.CANCELLED }))).toEqual({ action: 'RIEN' });
    expect(decider(livraison(), OrderStatus.CANCELLED)).toEqual({ action: 'RIEN' });
  });

  it('raison de la course vide, en mots d’avant', () => {
    expect(raisonCourseVide('CMD-A', OrderType.PICKUP)).toBe('Plus aucune commande à livrer : CMD-A passée à emporter');
    expect(raisonRelanceImpossible('CMD-A', OrderType.TABLE)).toBe(
      'groupe annulé après le passage de CMD-A sur place, relance automatique impossible',
    );
  });
});

describe('suiteDuRetrait', () => {
  it('d’autres commandes à livrer : la course continue', () => {
    expect(suiteDuRetrait({ turbo: false, restantes: 1, faites: 0 })).toBe('RETRAIT');
    expect(suiteDuRetrait({ turbo: false, restantes: 1, faites: 2 })).toBe('RETRAIT');
  });

  it('plus rien à livrer ni de livré : course annulée', () => {
    expect(suiteDuRetrait({ turbo: false, restantes: 0, faites: 0 })).toBe('ANNULEE');
  });

  it('plus rien à livrer, des livraisons faites (course partie sans la commande) : course terminée', () => {
    expect(suiteDuRetrait({ turbo: false, restantes: 0, faites: 1 })).toBe('TERMINEE');
  });

  it('course Turbo : annulée, ses autres commandes relancées s’il en reste', () => {
    expect(suiteDuRetrait({ turbo: true, restantes: 2, faites: 0 })).toBe('TURBO_RELANCE');
    expect(suiteDuRetrait({ turbo: true, restantes: 0, faites: 0 })).toBe('ANNULEE');
  });
});
