/**
 * « Les fermer » (demande du 10/11) : courses restées ouvertes d'une journée
 * passée, fermées par l'administrateur. Une course dont une commande vit
 * encore est gardée ; aucune commande n'est écrite.
 */
import { CourseOfferStatus, CourseStatut, DeliveryStatut, EntityStatus, OrderStatus } from '@prisma/client';

import { USER_ROLES_KEY } from 'src/modules/auth/decorators/user-roles.decorator';

import { CourseAdminController } from '../controllers/course-admin.controller';
import {
  MOTIF_COURSE_ANCIENNE,
  fermetureDeCourseAncienne,
  messageFermetureAnciennes,
} from '../helpers/courses-anciennes.rules';
import { CoursesAnciennesService } from './courses-anciennes.service';

const M = new Date('2026-11-10T12:00:00.000Z');
const ACTIVE = EntityStatus.ACTIVE;

const livraison = (id: string, status: OrderStatus, statut: DeliveryStatut = DeliveryStatut.IN_ROUTE, entity_status: EntityStatus = ACTIVE) => ({
  id,
  statut,
  order: { status, entity_status },
});

describe('fermetureDeCourseAncienne', () => {
  it('commandes servies : livraisons fermées comme livrées, course terminée', () => {
    expect(
      fermetureDeCourseAncienne({
        id: 'c1',
        deliveries: [livraison('d1', OrderStatus.COMPLETED), livraison('d2', OrderStatus.COLLECTED)],
      }),
    ).toEqual({ course_id: 'c1', statut: CourseStatut.COMPLETED, livrees: ['d1', 'd2'], annulees: [] });
  });

  it('commandes annulées ou supprimées : livraisons annulées, course annulée', () => {
    expect(
      fermetureDeCourseAncienne({
        id: 'c2',
        deliveries: [
          livraison('d1', OrderStatus.CANCELLED),
          livraison('d2', OrderStatus.READY, DeliveryStatut.PENDING, EntityStatus.DELETED),
        ],
      }),
    ).toEqual({ course_id: 'c2', statut: CourseStatut.CANCELLED, livrees: [], annulees: ['d1', 'd2'] });
  });

  it('un client déjà livré et l’autre annulé : course terminée ; livraisons terminées intouchées', () => {
    expect(
      fermetureDeCourseAncienne({
        id: 'c3',
        deliveries: [livraison('d1', OrderStatus.COMPLETED, DeliveryStatut.DELIVERED), livraison('d2', OrderStatus.CANCELLED)],
      }),
    ).toEqual({ course_id: 'c3', statut: CourseStatut.COMPLETED, livrees: [], annulees: ['d2'] });
  });

  it.each([OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.IN_PROGRESS, OrderStatus.ACCEPTED])(
    'une commande encore %s : course gardée',
    (status) => {
      expect(
        fermetureDeCourseAncienne({ id: 'c4', deliveries: [livraison('d1', OrderStatus.COMPLETED), livraison('d2', status)] }),
      ).toBeNull();
    },
  );

  it('message : fermées, gardées, accords', () => {
    expect(messageFermetureAnciennes(0, 0)).toBe('Aucune course des jours passés à fermer.');
    expect(messageFermetureAnciennes(1, 0)).toBe('1 course fermée.');
    expect(messageFermetureAnciennes(38, 2)).toBe("38 courses fermées. 2 gardées : une de leurs commandes n'est pas terminée.");
    expect(messageFermetureAnciennes(0, 1)).toBe("Aucune course fermée. 1 gardée : une de ses commandes n'est pas terminée.");
  });
});

describe('CoursesAnciennesService.fermer', () => {
  function monter(courses: Array<Record<string, unknown>>) {
    const ecrit: Array<{ table: string; where: any; data: any }> = [];
    const tx = {
      delivery: { updateMany: jest.fn(async (a: any) => (ecrit.push({ table: 'delivery', ...a }), { count: 1 })) },
      course: { updateMany: jest.fn(async (a: any) => (ecrit.push({ table: 'course', ...a }), { count: 1 })) },
      courseOfferAttempt: { updateMany: jest.fn(async (a: any) => (ecrit.push({ table: 'offre', ...a }), { count: 0 })) },
      dispatchEvenement: { createMany: jest.fn(async (a: any) => (ecrit.push({ table: 'journal', where: null, ...a }), { count: 0 })) },
    };
    const lectures: any[] = [];
    const prisma = {
      course: {
        findMany: jest.fn(async (a: any) => {
          lectures.push(a);
          if (a.include) return courses.filter((c) => a.where.id.in.includes(c.id)).map((c) => ({ ...c, statut: CourseStatut.COMPLETED, deliveries: [] }));
          return courses;
        }),
      },
      $transaction: jest.fn(async (f: (t: typeof tx) => Promise<void>) => f(tx)),
    };
    const evenements = { courseCompleted: jest.fn(async () => undefined), courseCancelled: jest.fn(async () => undefined) };
    const tableau = { oublier: jest.fn() };
    const service = new CoursesAnciennesService(prisma as never, evenements as never, tableau as never);
    return { service, ecrit, lectures, evenements, prisma, tableau };
  }

  const servie = {
    id: 'c-servie',
    reference: 'CRS-261027-90745',
    restaurant_id: 'r-angre',
    deliverer_id: 'l-yann',
    deliveries: [livraison('d1', OrderStatus.COMPLETED)],
  };
  const vivante = {
    id: 'c-vivante',
    reference: 'CRS-261029-40778',
    restaurant_id: 'r-sococe',
    deliverer_id: null,
    deliveries: [livraison('d2', OrderStatus.READY, DeliveryStatut.PENDING)],
  };
  const annulee = {
    id: 'c-annulee',
    reference: 'CRS-261030-30983',
    restaurant_id: 'r-sococe',
    deliverer_id: null,
    deliveries: [livraison('d3', OrderStatus.CANCELLED, DeliveryStatut.PENDING)],
  };

  it('lit les courses pas terminées créées avant 5 h ce matin, du restaurant demandé', async () => {
    const t = monter([]);
    await t.service.fermer('r-angre', { id: 'u1', role: 'ADMIN' } as never, M);
    expect(t.lectures[0].where).toMatchObject({
      restaurant_id: 'r-angre',
      statut: { in: [CourseStatut.PENDING_ASSIGNMENT, CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY] },
      created_at: { lt: new Date('2026-11-10T05:00:00.000Z') },
    });
  });

  it('ferme les courses réglées, garde celle dont une commande vit, n’écrit aucune commande', async () => {
    const t = monter([servie, vivante, annulee]);
    const r = await t.service.fermer(undefined, { id: 'u1', role: 'ADMIN' } as never, M);

    expect(r).toEqual({ fermees: 2, gardees: 1, message: "2 courses fermées. 1 gardée : une de ses commandes n'est pas terminée." });
    const parTable = (table: string) => t.ecrit.filter((e) => e.table === table);
    expect(parTable('delivery').map((e) => [e.where.id.in, e.data.statut])).toEqual([
      [['d1'], DeliveryStatut.DELIVERED],
      [['d3'], DeliveryStatut.CANCELLED],
    ]);
    // Sans heure de livraison : personne ne l'a validée.
    expect(parTable('delivery').every((e) => !('delivered_at' in e.data))).toBe(true);
    expect(parTable('course').map((e) => [e.where.id.in, e.data.statut])).toEqual([
      [['c-servie'], CourseStatut.COMPLETED],
      [['c-annulee'], CourseStatut.CANCELLED],
    ]);
    expect(parTable('course')[1].data).toMatchObject({ cancelled_by: 'admin', cancelled_reason: MOTIF_COURSE_ANCIENNE });
    // Garde : une course terminée entre la lecture et l'écriture n'est pas réécrite.
    expect(parTable('course')[0].where.statut).toEqual({ in: expect.arrayContaining([CourseStatut.IN_DELIVERY]) });
    expect(parTable('offre')[0]).toMatchObject({
      where: { course_id: { in: ['c-servie', 'c-annulee'] }, status: CourseOfferStatus.PENDING },
      data: { status: CourseOfferStatus.CANCELLED },
    });
    expect(parTable('journal')[0].data.map((j: any) => [j.type, j.course_id, j.details.par])).toEqual([
      ['COURSE_ANCIENNE_FERMEE', 'c-servie', { id: 'u1', role: 'ADMIN' }],
      ['COURSE_ANCIENNE_FERMEE', 'c-annulee', { id: 'u1', role: 'ADMIN' }],
    ]);
    expect(t.ecrit.some((e) => e.table === 'order')).toBe(false);
    // Le tableau gardé est oublié : la ligne disparaît à la relecture.
    expect(t.tableau.oublier).toHaveBeenCalled();
    // Seul le livreur encore rattaché est prévenu, par le temps réel.
    expect(t.evenements.courseCompleted).toHaveBeenCalledTimes(1);
    expect(t.evenements.courseCancelled).not.toHaveBeenCalled();
  });

  it('rien à fermer : aucune écriture', async () => {
    const t = monter([vivante]);
    expect(await t.service.fermer(undefined, undefined, M)).toEqual({
      fermees: 0,
      gardees: 1,
      message: "Aucune course fermée. 1 gardée : une de ses commandes n'est pas terminée.",
    });
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('route réservée à l’administrateur', () => {
    expect(Reflect.getMetadata(USER_ROLES_KEY, CourseAdminController.prototype.fermerAnciennes)).toEqual(['ADMIN']);
  });
});
