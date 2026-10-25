/**
 * Annulation d'une course par le livreur (`PATCH /courses/deliverer/:id/cancel`).
 *
 * Faille du 25/10 : la route ne passait pas le livreur connecté au service ;
 * n'importe quel livreur annulait la course d'un autre (et les commandes des
 * clients avec). Règle : seul le livreur de la course, celui qui l'a acceptée,
 * l'annule, dans les états où c'était déjà permis (course pas terminée). Un
 * autre livreur reçoit 403, comme sur les routes voisines (« Je pars »).
 * L'identité vient du jeton, jamais du corps de la requête.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { appliLivreurSimulee, busSimule } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { CourseDelivererController } from '../controllers/course-deliverer.controller';
import { MESSAGE_COURSE_PAS_A_TOI } from '../helpers/depart.rules';
import {
  DonneesDispatch,
  course,
  courseAvecCommandes,
  livreur,
  monterBaseDispatch,
  offre,
} from './base-dispatch.simulee-spec';
import { CourseActionService, MESSAGE_OFFRE_PLUS_EN_ATTENTE } from './course-action.service';
import { DeliveryActionService } from './delivery-action.service';
import { DepartCourseService } from './depart-course.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { GardeOffresService } from './garde-offres.service';
import { OffresClotureService } from './offres-cloture.service';

function monter(donnees: DonneesDispatch) {
  const base = monterBaseDispatch(donnees);
  const { bus } = busSimule();
  const journal = new DispatchJournalService(base.prisma);
  const cloture = new OffresClotureService(base.prisma, bus as never, journal);
  const garde = new GardeOffresService(base.prisma, cloture, journal, appliLivreurSimulee(base.prisma).service);
  const courseEvent = { courseCancelled: jest.fn(async () => undefined) };
  const push = { notifyCourseCancelled: jest.fn() };
  const actions = new CourseActionService(
    base.prisma,
    courseEvent as never,
    {} as never,
    {} as never,
    push as never,
    {} as never,
    {} as never,
    {} as never,
    garde,
  );
  const actionsLivraison = new DeliveryActionService(base.prisma, {} as never, {} as never, {} as never, {} as never);
  const depart = new DepartCourseService(base.prisma, {} as never, {} as never, {} as never, {} as never);
  const controleur = new CourseDelivererController(actions, actionsLivraison, {} as never, {} as never, depart);
  /** Ce que fait la route : livreur lu du jeton, identifiant de l'URL, corps tel quel. */
  const annuler = (livreurConnecte: Record<string, any>, courseId: string, corps: Record<string, unknown> = {}) =>
    controleur.cancel(livreurConnecte as never, courseId, corps as never);
  return { ...base, courseEvent, push, actions, controleur, annuler };
}

describe('annulation par le livreur (PATCH /courses/deliverer/:id/cancel)', () => {
  it('un livreur B annule la course du livreur A : 403, rien n’est écrit', async () => {
    const a = livreur();
    const b = livreur();
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.ACCEPTED, deliverer_id: a.id },
      [OrderStatus.READY, OrderStatus.READY],
    );
    const t = monter({ livreurs: [a, b], courses: [c], commandes, livraisons });

    const refus = t.annuler(b, c.id, { reason: 'Je ne peux pas' });
    await expect(refus).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refus).rejects.toThrow(MESSAGE_COURSE_PAS_A_TOI);

    expect(c.statut).toBe(CourseStatut.ACCEPTED);
    expect(c.deliverer_id).toBe(a.id);
    expect(c.cancelled_at).toBeNull();
    expect(livraisons.map((l) => l.statut)).toEqual([DeliveryStatut.PENDING, DeliveryStatut.PENDING]);
    expect(commandes.map((o) => o.status)).toEqual([OrderStatus.READY, OrderStatus.READY]);
    expect(t.courseEvent.courseCancelled).not.toHaveBeenCalled();
  });

  it('l’identité vient du jeton : B qui met l’identifiant de A dans le corps est refusé', async () => {
    const a = livreur();
    const b = livreur();
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.IN_DELIVERY, deliverer_id: a.id },
      [OrderStatus.PICKED_UP],
    );
    const t = monter({ livreurs: [a, b], courses: [c], commandes, livraisons });

    await expect(t.annuler(b, c.id, { reason: 'x', deliverer_id: a.id, delivererId: a.id })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(c.statut).toBe(CourseStatut.IN_DELIVERY);
  });

  it('course qui cherche encore un livreur : personne ne l’a acceptée, 403 pour tout livreur', async () => {
    const b = livreur();
    const c = course({ statut: CourseStatut.PENDING_ASSIGNMENT, deliverer_id: null });
    const t = monter({ livreurs: [b], courses: [c] });

    await expect(t.annuler(b, c.id)).rejects.toThrow(MESSAGE_COURSE_PAS_A_TOI);
    expect(c.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
  });

  it.each([CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY])(
    'le livreur A annule SA course (%s) : annulée comme avant, par « deliverer », sans push à lui-même',
    async (statut) => {
      const a = livreur();
      const { course: c, commandes, livraisons } = courseAvecCommandes({ statut, deliverer_id: a.id }, [OrderStatus.READY]);
      const t = monter({ livreurs: [a], courses: [c], commandes, livraisons });

      const rendue = await t.annuler(a, c.id, { reason: 'Panne de moto' });

      expect(rendue).toMatchObject({ id: c.id, statut: CourseStatut.CANCELLED });
      expect(c).toMatchObject({ statut: CourseStatut.CANCELLED, cancelled_by: 'deliverer', cancelled_reason: 'Panne de moto' });
      expect(livraisons[0].statut).toBe(DeliveryStatut.CANCELLED);
      expect(t.courseEvent.courseCancelled).toHaveBeenCalledWith(
        expect.objectContaining({ cancelled_by: 'deliverer', reason: 'Panne de moto' }),
      );
      expect(t.push.notifyCourseCancelled).not.toHaveBeenCalled();
    },
  );

  it.each([CourseStatut.COMPLETED, CourseStatut.CANCELLED, CourseStatut.EXPIRED])(
    'sa course déjà terminée (%s) : 400 « Course déjà terminée », comme avant',
    async (statut) => {
      const a = livreur();
      const c = course({ statut, deliverer_id: a.id });
      const t = monter({ livreurs: [a], courses: [c] });

      const refus = t.annuler(a, c.id);
      await expect(refus).rejects.toBeInstanceOf(BadRequestException);
      await expect(refus).rejects.toThrow('Course déjà terminée');
      expect(c.statut).toBe(statut);
    },
  );

  it('la course d’un autre, même terminée : 403 d’abord (son état n’est pas révélé)', async () => {
    const a = livreur();
    const b = livreur();
    const c = course({ statut: CourseStatut.COMPLETED, deliverer_id: a.id });
    const t = monter({ livreurs: [a, b], courses: [c] });

    await expect(t.annuler(b, c.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('course inconnue : 404 « Course non trouvée », comme les routes voisines', async () => {
    const b = livreur();
    const t = monter({ livreurs: [b] });

    const refus = t.annuler(b, '00000000-0000-4000-8000-000000000000');
    await expect(refus).rejects.toBeInstanceOf(NotFoundException);
    await expect(refus).rejects.toThrow('Course non trouvée');
  });

  it('sa course terminée au même instant (dernière livraison confirmée) : 400, rien d’autre n’est écrit', async () => {
    const a = livreur();
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.IN_DELIVERY, deliverer_id: a.id },
      [OrderStatus.PICKED_UP],
    );
    livraisons[0].statut = DeliveryStatut.ARRIVED;
    const t = monter({ livreurs: [a], courses: [c], commandes, livraisons });
    // La course se termine juste avant l'écriture de l'annulation (le livreur
    // d'une course ne change jamais après l'acceptation : la course qui bouge
    // au même instant, c'est une course qui se termine).
    const transaction = t.prisma.$transaction.getMockImplementation();
    t.prisma.$transaction.mockImplementationOnce(async (arg: unknown) => {
      livraisons[0].statut = DeliveryStatut.DELIVERED;
      commandes[0].status = OrderStatus.COMPLETED;
      c.statut = CourseStatut.COMPLETED;
      return transaction(arg);
    });

    await expect(t.annuler(a, c.id)).rejects.toThrow('Course déjà terminée');
    expect(c).toMatchObject({ statut: CourseStatut.COMPLETED, cancelled_at: null });
    expect(livraisons[0].statut).toBe(DeliveryStatut.DELIVERED);
    expect(commandes[0].status).toBe(OrderStatus.COMPLETED);
    expect(t.courseEvent.courseCancelled).not.toHaveBeenCalled();
  });

  it('l’écriture porte le livreur du jeton et l’état attendu (un seul tenant)', async () => {
    const a = livreur();
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: a.id },
      [OrderStatus.READY],
    );
    const t = monter({ livreurs: [a], courses: [c], commandes, livraisons });
    const ecritures: Record<string, any>[] = [];
    const transaction = t.prisma.$transaction.getMockImplementation();
    t.prisma.$transaction.mockImplementation(async (arg: unknown) =>
      typeof arg === 'function'
        ? transaction(async (tx: any) => {
            const updateMany = tx.course.updateMany;
            tx.course.updateMany = jest.fn(async (args: Record<string, any>) => {
              ecritures.push(args);
              return updateMany(args);
            });
            return (arg as (tx: unknown) => Promise<unknown>)(tx);
          })
        : transaction(arg),
    );

    await t.annuler(a, c.id);

    expect(ecritures[0].where).toEqual({
      id: c.id,
      deliverer_id: a.id,
      statut: { notIn: [CourseStatut.COMPLETED, CourseStatut.CANCELLED, CourseStatut.EXPIRED] },
    });
  });
});

describe('les autres routes d’action du livreur : la course, la livraison ou l’offre d’un autre est refusée', () => {
  type Ids = { course: string; livraison: string };
  const routes: [string, (ctl: CourseDelivererController, b: never, ids: Ids) => Promise<unknown>, string][] = [
    ['POST :id/accept', (ctl, b, ids) => ctl.accept(b, ids.course), "Cette course n'est plus disponible."],
    ['POST :id/refuse', (ctl, b, ids) => ctl.refuse(b, ids.course, {} as never), MESSAGE_OFFRE_PLUS_EN_ATTENTE],
    ['PATCH :id/at-restaurant', (ctl, b, ids) => ctl.atRestaurant(b, ids.course), 'Cette course ne vous est pas affectée'],
    ['PATCH :id/picked-up', (ctl, b, ids) => ctl.pickedUp(b, ids.course), 'Cette course ne vous est pas affectée'],
    ['POST :id/depart', (ctl, b, ids) => ctl.jePars(b, ids.course), MESSAGE_COURSE_PAS_A_TOI],
    ['PATCH :id/cancel', (ctl, b, ids) => ctl.cancel(b, ids.course, {} as never), MESSAGE_COURSE_PAS_A_TOI],
    [
      'PATCH deliveries/:deliveryId/start',
      (ctl, b, ids) => ctl.startDelivery(b, ids.livraison),
      'Cette livraison ne vous est pas affectée',
    ],
    [
      'PATCH deliveries/:deliveryId/arrived',
      (ctl, b, ids) => ctl.arrivedDelivery(b, ids.livraison),
      'Cette livraison ne vous est pas affectée',
    ],
    [
      'PATCH deliveries/:deliveryId/confirm',
      (ctl, b, ids) => ctl.confirmDelivery(b, ids.livraison, { pin: '1234' } as never),
      'Cette livraison ne vous est pas affectée',
    ],
    [
      'PATCH deliveries/:deliveryId/fail',
      (ctl, b, ids) => ctl.failDelivery(b, ids.livraison, { reason: 'CLIENT_ABSENT' } as never),
      'Cette livraison ne vous est pas affectée',
    ],
    [
      'POST deliveries/:deliveryId/rate-customer',
      (ctl, b, ids) => ctl.rateCustomer(b, ids.livraison, { rating: 1 } as never),
      'Cette livraison ne vous est pas affectée',
    ],
  ];

  it.each(routes)('%s : refusée à B, rien n’est écrit', async (_route, appeler, message) => {
    const a = livreur();
    const b = livreur();
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.IN_DELIVERY, deliverer_id: a.id },
      [OrderStatus.PICKED_UP],
    );
    // L'offre en attente est celle de A : B n'en a aucune sur cette course.
    const o = offre({ course_id: c.id, deliverer_id: a.id, expires_at: new Date(Date.now() + 120_000) });
    const t = monter({ livreurs: [a, b], courses: [c], commandes, livraisons, offres: [o] });
    const avant = JSON.stringify({ courses: t.courses, livraisons: t.livraisons, commandes: t.commandes, offres: t.offres });

    await expect(appeler(t.controleur, b as never, { course: c.id, livraison: livraisons[0].id })).rejects.toThrow(message);

    expect(JSON.stringify({ courses: t.courses, livraisons: t.livraisons, commandes: t.commandes, offres: t.offres })).toBe(
      avant,
    );
  });
});
