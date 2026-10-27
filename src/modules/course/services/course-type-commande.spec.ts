/**
 * Commande passée à emporter ou sur place (demande du 27/10) : aucun chemin
 * de la course ne la remet dans une course. Avant, la relance d'une course
 * annulée, la fin de fenêtre d'un lot et l'ajout du planificateur ne
 * regardaient pas le type ; chacun de ces tests échouait.
 */
import { CourseBatchStatus, CourseStatut, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import { CourseGroupingService } from './course-grouping.service';
import { monter, prete } from './banc-planificateur.simulee-spec';
import { course, livraison, RESTO } from './base-dispatch.simulee-spec';

describe('Commande passée à emporter : plus jamais remise dans une course', () => {
  it('relance d’une course annulée : la commande à emporter reste au comptoir, l’autre repart', async () => {
    const c = course({ statut: CourseStatut.CANCELLED, cancelled_by: 'turbo' });
    const A = prete({ type: OrderType.PICKUP });
    const B = prete();
    const h = monter({
      courses: [c],
      commandes: [A, B],
      livraisons: [
        livraison({ course_id: c.id, order_id: A.id, sequence_order: 1, statut: DeliveryStatut.CANCELLED }),
        livraison({ course_id: c.id, order_id: B.id, sequence_order: 2, statut: DeliveryStatut.CANCELLED }),
      ],
    });

    const relance = await h.offres.relancerCourseAnnulee(c.id);

    expect(relance.ok).toBe(true);
    const parCommande = (id: string) => h.base.livraisons.find((l) => l.order_id === id)!;
    expect(parCommande(A.id).course_id).toBe(c.id);
    expect(parCommande(B.id).course_id).toBe(relance.newCourseId);
  });

  it('fin de fenêtre d’un lot : une commande à emporter ne crée pas de course', async () => {
    const A = prete({ type: OrderType.PICKUP });
    const h = monter({ commandes: [A] });

    await expect(h.offres.createFromReadyOrders({ restaurantId: RESTO, orderIds: [A.id] })).rejects.toThrow(
      'Aucune order éligible trouvée',
    );
    expect(h.base.courses).toHaveLength(0);
  });

  /** Un lot (v1) et ses commandes sur la base simulée, vidé par le vrai service. */
  function lot(commandes: Record<string, unknown>[]) {
    const h = monter({ commandes: commandes.map((c) => ({ ...c, batch_id: 'lot-1' })) });
    const ligne: Record<string, unknown> = { id: 'lot-1', status: CourseBatchStatus.PENDING, restaurant_id: RESTO };
    const prisma = {
      ...h.base.prisma,
      courseBatch: {
        // Les commandes du lot, filtrées par le `where` du service (relations comprises).
        findUnique: jest.fn(async (args: { include: { orders: { where: Record<string, unknown> } } }) => ({
          ...ligne,
          orders: await h.base.prisma.order.findMany({
            where: { batch_id: 'lot-1', ...args.include.orders.where },
            select: { id: true, address: true, created_at: true },
          }),
          restaurant: { id: RESTO, latitude: 5.286, longitude: -3.9737 },
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(ligne, data)),
      },
    };
    const service = new CourseGroupingService(
      prisma as never,
      {} as never,
      h.offres,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { h, ligne, vider: () => service.flushBatch('lot-1') };
  }

  it('lot vidé à la fin de sa fenêtre : la commande passée à emporter reste au comptoir', async () => {
    const A = prete({ type: OrderType.PICKUP });
    const B = prete();
    const { h, ligne, vider } = lot([A, B]);

    await vider();

    expect(ligne.status).toBe(CourseBatchStatus.FLUSHED);
    expect(h.base.livraisons.map((l) => l.order_id)).toEqual([B.id]);
  });

  it('lot dont la seule commande est passée à emporter : expiré, aucune course', async () => {
    const { h, ligne, vider } = lot([prete({ type: OrderType.PICKUP })]);

    await vider();

    expect(ligne.status).toBe(CourseBatchStatus.EXPIRED);
    expect(h.base.courses).toEqual([]);
    expect(h.base.livraisons).toEqual([]);
  });

  it('fin de fenêtre d’un lot, commande passée à emporter juste après la lecture : elle n’entre pas dans la course', async () => {
    const A = prete();
    const B = prete();
    const h = monter({ commandes: [A, B] });
    // « Modifier la commande » passe juste après la lecture du lot.
    const lire = h.base.prisma.order.findMany.getMockImplementation()!;
    h.base.prisma.order.findMany.mockImplementationOnce(async (args: unknown) => {
      const lues = await lire(args);
      A.type = OrderType.PICKUP;
      return lues;
    });

    const creee = await h.offres.createFromReadyOrders({ restaurantId: RESTO, orderIds: [A.id, B.id] });

    expect(h.base.livraisons.map((l) => l.order_id)).toEqual([B.id]);
    expect(h.base.livraisons[0].course_id).toBe(creee.id);
    expect(creee.total_delivery_fee).toBe(1000);
  });

  it('relance d’une course annulée, commande passée à emporter juste après la lecture : elle reste au comptoir', async () => {
    const c = course({ statut: CourseStatut.CANCELLED, cancelled_by: 'turbo' });
    const A = prete();
    const B = prete();
    const h = monter({
      courses: [c],
      commandes: [A, B],
      livraisons: [
        livraison({ course_id: c.id, order_id: A.id, sequence_order: 1, statut: DeliveryStatut.CANCELLED }),
        livraison({ course_id: c.id, order_id: B.id, sequence_order: 2, statut: DeliveryStatut.CANCELLED }),
      ],
    });
    const lire = h.base.prisma.course.findUnique.getMockImplementation()!;
    h.base.prisma.course.findUnique.mockImplementationOnce(async (args: unknown) => {
      const lue = await lire(args);
      A.type = OrderType.PICKUP;
      return lue;
    });

    const relance = await h.offres.relancerCourseAnnulee(c.id);

    expect(relance.ok).toBe(true);
    const parCommande = (id: string) => h.base.livraisons.find((l) => l.order_id === id)!;
    expect(parCommande(A.id)).toEqual(expect.objectContaining({ course_id: c.id, statut: DeliveryStatut.CANCELLED }));
    expect(parCommande(B.id)).toEqual(expect.objectContaining({ course_id: relance.newCourseId, sequence_order: 1 }));
    const nouvelle = h.base.courses.find((x) => x.id === relance.newCourseId)!;
    expect(nouvelle.total_delivery_fee).toBe(1000);
  });

  it('relance d’une course annulée dont la seule commande vient de passer à emporter : rien n’est créé', async () => {
    const c = course({ statut: CourseStatut.CANCELLED, cancelled_by: 'turbo' });
    const A = prete();
    const h = monter({
      courses: [c],
      commandes: [A],
      livraisons: [livraison({ course_id: c.id, order_id: A.id, sequence_order: 1, statut: DeliveryStatut.CANCELLED })],
    });
    const lire = h.base.prisma.course.findUnique.getMockImplementation()!;
    h.base.prisma.course.findUnique.mockImplementationOnce(async (args: unknown) => {
      const lue = await lire(args);
      A.type = OrderType.PICKUP;
      return lue;
    });

    const relance = await h.offres.relancerCourseAnnulee(c.id);

    expect(relance.ok).toBe(false);
    expect(h.base.courses).toHaveLength(1);
    expect(h.base.livraisons[0]).toEqual(expect.objectContaining({ course_id: c.id, statut: DeliveryStatut.CANCELLED }));
  });

  it('ajout du planificateur décidé avant le changement de type : abandonné', async () => {
    const c = course({ statut: CourseStatut.PENDING_ASSIGNMENT });
    const A = prete();
    const h = monter({ courses: [c], commandes: [A] });
    // Lue à livrer par le passage, passée à emporter avant l'écriture.
    A.type = OrderType.PICKUP;

    const resultat = await h.application.appliquer(
      {
        restaurant_id: RESTO,
        maintenant: new Date(),
        refus: [],
        actions: [
          {
            type: 'AJOUTER',
            course_id: c.id,
            order_id: A.id,
            reference: A.reference,
            statut_course: CourseStatut.PENDING_ASSIGNMENT,
            deliverer_id: null,
            apres_retrait: false,
            attendue: false,
            offre: null,
            motif: null,
            libelle: 'essai',
            detour_s: 0,
          },
        ],
      },
      {} as never,
      { maxRefus: 3 },
    );

    expect(resultat.abandonnees).toEqual([{ type: 'AJOUTER', motif: 'COMMANDE_CHANGEE' }]);
    expect(h.base.livraisons).toHaveLength(0);
    expect(A.status).toBe(OrderStatus.READY);
  });
});
