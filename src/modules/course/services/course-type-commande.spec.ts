/**
 * Commande passée à emporter ou sur place (demande du 27/10) : aucun chemin
 * de la course ne la remet dans une course. Avant, la relance d'une course
 * annulée, la fin de fenêtre d'un lot et l'ajout du planificateur ne
 * regardaient pas le type ; chacun de ces tests échouait.
 */
import { CourseStatut, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

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

  it('lot vidé à la fin de sa fenêtre : seules les commandes à livrer sont lues', async () => {
    const findUnique = jest.fn(async () => null);
    const service = new CourseGroupingService(
      { courseBatch: { findUnique } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.flushBatch('lot-1');

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          orders: expect.objectContaining({ where: expect.objectContaining({ type: OrderType.DELIVERY }) }),
        }),
      }),
    );
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
