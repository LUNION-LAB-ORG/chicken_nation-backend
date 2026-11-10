/**
 * Kanban « En direct » de l'écran Courses (demande du 10/11) : colonnes,
 * contenu des cartes, ordre.
 */
import { CourseStatut, DeliveryStatut, EntityStatus, OrderStatus } from '@prisma/client';

import {
  CourseEnDirectLue,
  carteEnDirect,
  colonneDe,
  construireCoursesEnDirect,
} from './courses-en-direct.rules';

const M = new Date('2026-11-10T20:30:00.000Z');
const ilYA = (min: number) => new Date(M.getTime() - min * 60_000);
let n = 0;

function lue(p: Partial<CourseEnDirectLue> = {}): CourseEnDirectLue {
  n += 1;
  return {
    id: `c${n}`,
    reference: `CRS-261110-${String(n).padStart(5, '0')}`,
    pickup_code: '305',
    statut: CourseStatut.PENDING_ASSIGNMENT,
    restaurant: { id: 'r-zone4', name: 'CHICKEN NATION ZONE 4' },
    deliverer: null,
    turbo_escalated_at: null,
    created_at: ilYA(10),
    assigned_at: null,
    at_restaurant_at: null,
    completed_at: null,
    picked_up_at: null,
    parti_at: null,
    motif_depart: null,
    estimated_duration_min: null,
    delay_alerted_at: null,
    retenue_jusqua: null,
    total_delivery_fee: 500,
    deliveries: [
      { statut: DeliveryStatut.PENDING, order: { reference: `ORD-${n}`, status: OrderStatus.READY, entity_status: EntityStatus.ACTIVE } },
    ],
    offer_attempts: [],
    ...p,
  };
}

const KOFFI = { id: 'l-koffi', first_name: 'Koffi', last_name: 'K.', phone: '+2250700000000' };

describe('colonnes', () => {
  it.each([
    [CourseStatut.PENDING_ASSIGNMENT, 'A_AFFECTER'],
    [CourseStatut.EXPIRED, 'A_AFFECTER'],
    [CourseStatut.ACCEPTED, 'VERS_RESTAURANT'],
    [CourseStatut.AT_RESTAURANT, 'AU_RESTAURANT'],
    [CourseStatut.IN_DELIVERY, 'EN_LIVRAISON'],
    [CourseStatut.COMPLETED, 'TERMINEE'],
    [CourseStatut.CANCELLED, null],
  ])('%s → %s', (statut, colonne) => {
    expect(colonneDe(statut)).toBe(colonne);
  });
});

describe('carte', () => {
  it('en recherche : code, restaurant, commandes, depuis la création, proposée à, livreur modifiable', () => {
    const c = lue({ offer_attempts: [{ deliverer: { first_name: 'Awa' } }] });
    expect(carteEnDirect(c, M, 1.5)).toMatchObject({
      code: '305',
      colonne: 'A_AFFECTER',
      restaurant: { id: 'r-zone4', nom: 'CHICKEN NATION ZONE 4' },
      livreur: null,
      proposee_a: 'Awa',
      commandes: { total: 1, livrees: 0, references: [c.deliveries[0].order.reference] },
      depuis: ilYA(10).toISOString(),
      livreur_modifiable: true,
      turbo: false,
      frais: 500,
    });
  });

  it('en livraison en retard : fin prévue, retard ; le livreur ne se change plus', () => {
    const c = lue({
      statut: CourseStatut.IN_DELIVERY,
      deliverer: KOFFI,
      picked_up_at: ilYA(60),
      parti_at: ilYA(60),
      motif_depart: 'POSITION',
      estimated_duration_min: 30,
    });
    expect(carteEnDirect(c, M, 1.5)).toMatchObject({
      colonne: 'EN_LIVRAISON',
      livreur: { id: 'l-koffi', prenom: 'Koffi', telephone: '+2250700000000' },
      depuis: ilYA(60).toISOString(),
      fin_prevue: ilYA(30).toISOString(),
      retard_min: 30,
      livreur_modifiable: false,
    });
  });

  it('confiée à Turbo : livreur pas modifiable ici', () => {
    expect(carteEnDirect(lue({ turbo_escalated_at: ilYA(5) }), M, 1.5)).toMatchObject({ turbo: true, livreur_modifiable: false });
  });
});

describe('tableau', () => {
  it('aucun livreur trouvé sans commande qui attend : retiré ; annulée : jamais', () => {
    const vide = lue({
      statut: CourseStatut.EXPIRED,
      deliveries: [{ statut: DeliveryStatut.PENDING, order: { reference: 'X', status: OrderStatus.CANCELLED, entity_status: EntityStatus.ACTIVE } }],
    });
    const attend = lue({ statut: CourseStatut.EXPIRED });
    const r = construireCoursesEnDirect({
      maintenant: M,
      facteurRetard: 1.5,
      courses: [vide, attend, lue({ statut: CourseStatut.CANCELLED })],
      termineesTotal: 0,
    });
    expect(r.courses.map((c) => c.id)).toEqual([attend.id]);
    expect(r.courses[0].expiree).toBe(true);
  });

  it('ordre : par colonne ; la plus ancienne d’abord, en livraison la plus en retard, terminées la plus récente', () => {
    const recente = lue({ created_at: ilYA(2) });
    const ancienne = lue({ created_at: ilYA(40) });
    const enRetard = lue({
      statut: CourseStatut.IN_DELIVERY, deliverer: KOFFI, picked_up_at: ilYA(90), parti_at: ilYA(90), estimated_duration_min: 30,
    });
    const aLHeure = lue({ statut: CourseStatut.IN_DELIVERY, deliverer: KOFFI, picked_up_at: ilYA(5), parti_at: ilYA(5), estimated_duration_min: 30 });
    const finieTot = lue({ statut: CourseStatut.COMPLETED, completed_at: ilYA(50) });
    const finieTard = lue({ statut: CourseStatut.COMPLETED, completed_at: ilYA(1) });
    const r = construireCoursesEnDirect({
      maintenant: M,
      facteurRetard: 1.5,
      courses: [finieTot, aLHeure, recente, enRetard, finieTard, ancienne],
      termineesTotal: 33,
    });
    expect(r.courses.map((c) => c.id)).toEqual([ancienne.id, recente.id, enRetard.id, aLHeure.id, finieTard.id, finieTot.id]);
    expect(r.terminees_total).toBe(33);
  });
});

describe('lecture (CoursesEnDirectService)', () => {
  it('journée de service seulement : en cours depuis 5 h, terminées du jour (30 au plus), comptées', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CoursesEnDirectService } = require('../services/courses-en-direct.service');
    const lectures: any[] = [];
    const prisma = {
      course: {
        findMany: jest.fn(async (a: any) => (lectures.push(a), [])),
        count: jest.fn(async () => 33),
      },
    };
    const service = new CoursesEnDirectService(prisma as never, { load: jest.fn(async () => ({ delayAlertFactor: 1.5 })) } as never);
    const r = await service.lire('r-zone4', M);
    const debut = new Date('2026-11-10T05:00:00.000Z');
    expect(lectures[0].where).toMatchObject({ restaurant_id: 'r-zone4', created_at: { gte: debut } });
    expect(lectures[0].where.statut.in).toEqual(
      expect.arrayContaining([CourseStatut.PENDING_ASSIGNMENT, CourseStatut.IN_DELIVERY, CourseStatut.EXPIRED]),
    );
    expect(lectures[1]).toMatchObject({
      where: { statut: CourseStatut.COMPLETED, completed_at: { gte: debut } },
      orderBy: { completed_at: 'desc' },
      take: 30,
    });
    expect(r).toMatchObject({ courses: [], terminees_total: 33 });
  });
});
