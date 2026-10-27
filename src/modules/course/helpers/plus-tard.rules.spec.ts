/**
 * « Plus tard » : le livreur passe un client qui pose problème, livre les
 * autres, puis revient sur lui (demande du client du 27/10). Règle pure
 * (contrat `tournee-contrat.md`, B1 et B2, tests P1 à P7).
 */
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import {
  CoursePlusTard,
  DecisionPlusTard,
  LivraisonPlusTard,
  MESSAGE_CLIENT_EN_COURS,
  MESSAGE_DEJA_REPORTEE,
  MESSAGE_PAS_ENCORE_EN_ROUTE,
  MESSAGE_PAS_ENCORE_PARTI,
  MESSAGE_PLUS_D_AUTRE_CLIENT,
  reglePlusTard,
} from './plus-tard.rules';

const MAINTENANT = new Date('2026-10-27T12:08:00.000Z');
const PARTI = new Date('2026-10-27T11:40:00.000Z');
const LIVREUR = 'liv-1';

const liv = (id: string, sequence_order: number, statut: DeliveryStatut, o: Partial<LivraisonPlusTard> = {}): LivraisonPlusTard => ({
  id,
  statut,
  sequence_order,
  reportee_at: null,
  arrived_at: null,
  in_route_at: null,
  ajoutee_apres_retrait: false,
  order: { status: statut === DeliveryStatut.DELIVERED ? OrderStatus.COMPLETED : OrderStatus.PICKED_UP, reference: `CMD-${id}` },
  ...o,
});

const course = (deliveries: LivraisonPlusTard[], o: Partial<CoursePlusTard> = {}): CoursePlusTard => ({
  deliverer_id: LIVREUR,
  statut: CourseStatut.IN_DELIVERY,
  parti_at: PARTI,
  deliveries,
  ...o,
});

const decider = (k: CoursePlusTard | null, id: string, livreur = LIVREUR) =>
  reglePlusTard({ livraisonId: id, delivererId: livreur, course: k, maintenant: MAINTENANT });

function reportee(d: DecisionPlusTard) {
  if (d.type !== 'REPORTER') throw new Error(`attendu REPORTER, reçu ${JSON.stringify(d)}`);
  return d;
}

const ordre = (d: DecisionPlusTard) => reportee(d).livraisons.map((l) => l.id);

describe('P1 : B en route sur A, B, C', () => {
  it('rangs A, C, B ; C démarre ; B en attente, en dernier', () => {
    const d = reportee(
      decider(
        course([liv('A', 1, DeliveryStatut.DELIVERED), liv('B', 2, DeliveryStatut.IN_ROUTE, { in_route_at: PARTI }), liv('C', 3, DeliveryStatut.PENDING)]),
        'B',
      ),
    );
    expect(Object.fromEntries(d.rangs)).toEqual({ A: 1, C: 2, B: 3 });
    expect(d.suivante).toEqual({ id: 'C', a_demarrer: true });
    expect(d.reportee).toMatchObject({ id: 'B', statut_avant: DeliveryStatut.IN_ROUTE, rang_avant: 2, rang_apres: 3 });
    expect(ordre(d)).toEqual(['A', 'C', 'B']);
    const [, c, b] = d.livraisons;
    expect(b).toMatchObject({ statut: DeliveryStatut.PENDING, reportee_at: MAINTENANT, sequence_order: 3, in_route_at: PARTI });
    expect(c).toMatchObject({ statut: DeliveryStatut.IN_ROUTE, in_route_at: MAINTENANT, sequence_order: 2 });
  });
});

describe('P2 : B arrivée chez le client', () => {
  it('l’heure d’arrivée est remise à vide, l’ancienne gardée pour le journal', () => {
    const arrivee = new Date('2026-10-27T12:05:00.000Z');
    const d = reportee(
      decider(course([liv('B', 1, DeliveryStatut.ARRIVED, { arrived_at: arrivee }), liv('C', 2, DeliveryStatut.PENDING)]), 'B'),
    );
    expect(d.reportee.arrivee_avant).toEqual(arrivee);
    expect(d.livraisons.find((l) => l.id === 'B')).toMatchObject({ statut: DeliveryStatut.PENDING, arrived_at: null, reportee_at: MAINTENANT });
    expect(ordre(d)).toEqual(['C', 'B']);
  });
});

describe('P3 : refus, dans l’ordre du contrat', () => {
  const tournee = () => [liv('B', 1, DeliveryStatut.IN_ROUTE), liv('C', 2, DeliveryStatut.PENDING)];

  it('404 livraison inconnue', () => {
    expect(decider(null, 'B')).toEqual({ type: 'REFUS', code: 404, message: 'Delivery non trouvée' });
    expect(decider(course(tournee()), 'Z')).toEqual({ type: 'REFUS', code: 404, message: 'Delivery non trouvée' });
  });

  it('403 autre livreur, avant tout état de la course', () => {
    expect(decider(course(tournee(), { statut: CourseStatut.COMPLETED, parti_at: null }), 'B', 'liv-2')).toEqual({
      type: 'REFUS',
      code: 403,
      message: 'Cette livraison ne vous est pas affectée',
    });
  });

  it('400 course pas en livraison, puis 409 « Pas encore parti. »', () => {
    expect(decider(course(tournee(), { statut: CourseStatut.AT_RESTAURANT, parti_at: null }), 'B')).toEqual({
      type: 'REFUS',
      code: 400,
      message: 'La course doit être en phase IN_DELIVERY',
    });
    expect(decider(course(tournee(), { parti_at: null }), 'B')).toEqual({ type: 'REFUS', code: 409, message: MESSAGE_PAS_ENCORE_PARTI });
    expect(MESSAGE_PAS_ENCORE_PARTI).toBe('Pas encore parti.');
  });

  it.each([DeliveryStatut.DELIVERED, DeliveryStatut.FAILED, DeliveryStatut.CANCELLED])('400 livraison %s', (statut) => {
    expect(decider(course([liv('B', 1, statut), liv('C', 2, DeliveryStatut.PENDING)]), 'B')).toEqual({
      type: 'REFUS',
      code: 400,
      message: `Statut delivery attendu PENDING ou IN_ROUTE ou ARRIVED, actuel ${statut}`,
    });
  });

  it('livraison en attente : seulement si aucune autre n’est en route ou chez le client', () => {
    const enCours = course([liv('A', 1, DeliveryStatut.IN_ROUTE), liv('B', 2, DeliveryStatut.PENDING), liv('C', 3, DeliveryStatut.PENDING)]);
    expect(decider(enCours, 'B')).toEqual({ type: 'REFUS', code: 409, message: MESSAGE_CLIENT_EN_COURS });
    // Personne en route, B déjà partie une fois vers son client (code déjà
    // envoyé) : B est la prochaine ; C démarre, B va à la fin.
    const libre = course([
      liv('A', 1, DeliveryStatut.DELIVERED),
      liv('B', 2, DeliveryStatut.PENDING, { in_route_at: PARTI }),
      liv('C', 3, DeliveryStatut.PENDING),
    ]);
    const d = reportee(decider(libre, 'B'));
    expect(ordre(d)).toEqual(['A', 'C', 'B']);
    expect(d.reportee.statut_avant).toBe(DeliveryStatut.PENDING);
  });

  it('livraison en attente jamais partie vers son client : 409 « Pas encore en route. » (son code WhatsApp n’est pas parti)', () => {
    // A livrée, B et C en attente, personne en route : B ne serait jamais
    // prévenue (le code n'est pas renvoyé au redémarrage d'une reportée).
    const k = course([liv('A', 1, DeliveryStatut.DELIVERED), liv('B', 2, DeliveryStatut.PENDING), liv('C', 3, DeliveryStatut.PENDING)]);
    expect(decider(k, 'B')).toEqual({ type: 'REFUS', code: 409, message: MESSAGE_PAS_ENCORE_EN_ROUTE });
    // Pas plus pour une livraison plus loin dans la tournée.
    expect(decider(k, 'C')).toEqual({ type: 'REFUS', code: 409, message: MESSAGE_PAS_ENCORE_EN_ROUTE });
    expect(MESSAGE_PAS_ENCORE_EN_ROUTE).toBe('Pas encore en route.');
  });
});

describe('P4 : rejeu', () => {
  it('déjà en attente et reportée : rendue telle quelle', () => {
    const k = course([
      liv('C', 1, DeliveryStatut.IN_ROUTE),
      liv('B', 2, DeliveryStatut.PENDING, { reportee_at: new Date('2026-10-27T12:07:00.000Z') }),
    ]);
    expect(decider(k, 'B')).toEqual({ type: 'REJEU' });
  });
});

describe('P5 : une seule fois par livraison', () => {
  it.each([DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED])('reportée puis redémarrée (%s) : « Déjà reportée une fois. »', (statut) => {
    const k = course([
      liv('A', 1, DeliveryStatut.DELIVERED),
      liv('C', 2, DeliveryStatut.PENDING),
      liv('B', 3, statut, { reportee_at: new Date('2026-10-27T12:00:00.000Z') }),
    ]);
    expect(decider(k, 'B')).toEqual({ type: 'REFUS', code: 409, message: MESSAGE_DEJA_REPORTEE });
    expect(MESSAGE_DEJA_REPORTEE).toBe('Déjà reportée une fois.');
  });
});

describe('P6 : « Plus d’autre client. »', () => {
  const refus = { type: 'REFUS', code: 409, message: MESSAGE_PLUS_D_AUTRE_CLIENT };

  it('dernière restante', () => {
    expect(MESSAGE_PLUS_D_AUTRE_CLIENT).toBe("Plus d'autre client.");
    const k = course([liv('A', 1, DeliveryStatut.DELIVERED), liv('X', 2, DeliveryStatut.FAILED), liv('B', 3, DeliveryStatut.IN_ROUTE)]);
    expect(decider(k, 'B')).toEqual(refus);
  });

  it('les autres sont un sac resté au restaurant ou une commande ajoutée pas remise', () => {
    const sac = liv('C', 2, DeliveryStatut.PENDING, { order: { status: OrderStatus.READY, reference: 'CMD-C' } });
    const ajout = liv('D', 3, DeliveryStatut.PENDING, {
      ajoutee_apres_retrait: true,
      order: { status: OrderStatus.READY, reference: 'CMD-D' },
    });
    const annulee = liv('E', 4, DeliveryStatut.CANCELLED);
    expect(decider(course([liv('B', 1, DeliveryStatut.IN_ROUTE), sac, ajout, annulee]), 'B')).toEqual(refus);
  });

  it('un sac au restaurant ne devient jamais la suivante : il reste à sa place, devant la reportée', () => {
    const sac = liv('C', 2, DeliveryStatut.PENDING, { order: { status: OrderStatus.READY, reference: 'CMD-C' } });
    const d = reportee(decider(course([liv('B', 1, DeliveryStatut.IN_ROUTE), sac, liv('D', 3, DeliveryStatut.PENDING)]), 'B'));
    expect(d.suivante.id).toBe('D');
    expect(ordre(d)).toEqual(['D', 'C', 'B']);
  });
});

describe('P7 : A reportée puis B reportée', () => {
  it('C, A, B', () => {
    const premiere = reportee(
      decider(course([liv('A', 1, DeliveryStatut.IN_ROUTE), liv('B', 2, DeliveryStatut.PENDING), liv('C', 3, DeliveryStatut.PENDING)]), 'A'),
    );
    expect(ordre(premiere)).toEqual(['B', 'C', 'A']);
    expect(premiere.suivante.id).toBe('B');

    const seconde = reportee(decider(course(premiere.livraisons), 'B'));
    expect(ordre(seconde)).toEqual(['C', 'A', 'B']);
    expect(seconde.suivante).toEqual({ id: 'C', a_demarrer: true });
    expect(seconde.livraisons.map((l) => [l.id, l.statut, l.sequence_order])).toEqual([
      ['C', DeliveryStatut.IN_ROUTE, 1],
      ['A', DeliveryStatut.PENDING, 2],
      ['B', DeliveryStatut.PENDING, 3],
    ]);
  });

  it('les annulées restent à la fin, la numérotation repart de 1 sans trou', () => {
    const d = reportee(
      decider(
        course([
          liv('X', 1, DeliveryStatut.CANCELLED),
          liv('A', 3, DeliveryStatut.DELIVERED),
          liv('B', 5, DeliveryStatut.IN_ROUTE),
          liv('C', 7, DeliveryStatut.PENDING),
        ]),
        'B',
      ),
    );
    expect(Object.fromEntries(d.rangs)).toEqual({ A: 1, C: 2, B: 3, X: 4 });
  });
});
