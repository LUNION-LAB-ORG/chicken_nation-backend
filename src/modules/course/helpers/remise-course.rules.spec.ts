/**
 * Annulation automatique d'une course bloquée : jamais une commande de client
 * (« une commande ne s'annule que manuellement »), et frais de livraison.
 */
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { evaluer } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import {
  WHERE_COURSE_ENCORE_A_REMETTRE,
  fraisLivraisonCourse,
  issueAnnulationAuto,
  messageValidationImpossible,
  trierCommandesAnnulationAuto,
} from './remise-course.rules';
import { whereCoursesARemettre } from './code-retrait.rules';

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

describe('validation par code : condition d’écriture', () => {
  const journee = { debut: new Date('2026-10-22T04:00:00.000Z'), fin: new Date('2026-10-23T04:00:00.000Z') };
  const recherche = whereCoursesARemettre('421', undefined, journee);
  const ligne = (statut: CourseStatut, turbo: Date | null = null) => ({
    pickup_code: '421',
    created_at: new Date('2026-10-22T12:00:00.000Z'),
    statut,
    turbo_escalated_at: turbo,
  });

  it('mêmes statuts que la recherche par code : le GPS ou un webhook Turbo ne bloque pas la remise', () => {
    const cas = [
      ligne(CourseStatut.PENDING_ASSIGNMENT),
      ligne(CourseStatut.PENDING_ASSIGNMENT, new Date()),
      ligne(CourseStatut.ACCEPTED),
      ligne(CourseStatut.AT_RESTAURANT),
      ligne(CourseStatut.ACCEPTED, new Date()),
      ligne(CourseStatut.IN_DELIVERY),
      ligne(CourseStatut.COMPLETED),
      ligne(CourseStatut.CANCELLED),
      ligne(CourseStatut.EXPIRED),
    ];
    for (const c of cas) {
      expect([c.statut, c.turbo_escalated_at !== null, evaluer(c, WHERE_COURSE_ENCORE_A_REMETTRE)]).toEqual([
        c.statut,
        c.turbo_escalated_at !== null,
        evaluer(c, recherche),
      ]);
    }
  });

  it('refus : le message dit si la course est partie, annulée, ou si rien n’est enregistré', () => {
    expect(messageValidationImpossible(CourseStatut.IN_DELIVERY)).toBe("Cette course vient d'être remise au livreur.");
    expect(messageValidationImpossible(CourseStatut.COMPLETED)).toBe("Cette course vient d'être remise au livreur.");
    expect(messageValidationImpossible(CourseStatut.CANCELLED)).toBe(
      "Cette course vient d'être annulée : la remise n'est pas enregistrée.",
    );
    expect(messageValidationImpossible(null)).toBe(
      "Cette course vient de changer : la remise n'est pas enregistrée, vérifiez les commandes et validez à nouveau.",
    );
    for (const statut of Object.values(CourseStatut)) expect(messageValidationImpossible(statut)).not.toMatch(/[—–]/);
  });
});
