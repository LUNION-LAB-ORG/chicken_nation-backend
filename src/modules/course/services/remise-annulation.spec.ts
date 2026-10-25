/**
 * Bouton de la caisse « Livreur a récupéré » raccordé à la course, et
 * annulation automatique qui n'annule JAMAIS une commande de client.
 *
 * Avant : le bouton passait la commande PICKED_UP sans toucher la course,
 * restée acceptée ou au restaurant ; au bout de 30 min, la tâche
 * `autoCancelStuckCourses` l'annulait, commandes des clients comprises.
 * Principe du projet : « une commande ne s'annule que manuellement ».
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CourseStatut, DeliveryService, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import { appliLivreurSimulee, busSimule } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { CourseHelper } from '../helpers/course.helper';
import { RemiseCaisseListener } from '../listeners/remise-caisse.listener';
import { CourseTask } from '../tasks/course.task';
import { AnnulationAutoService } from './annulation-auto.service';
import {
  DonneesDispatch,
  RESTO,
  courseAvecCommandes,
  livreur,
  monterBaseDispatch,
} from './base-dispatch.simulee-spec';
import { CourseActionService } from './course-action.service';
import { CourseEnLivraisonService } from './course-en-livraison.service';
import { CourseOfferService } from './course-offer.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { GardeOffresService } from './garde-offres.service';
import { OffresClotureService } from './offres-cloture.service';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);

function monter(donnees: DonneesDispatch) {
  const base = monterBaseDispatch(donnees);
  const { bus } = busSimule();
  const journal = new DispatchJournalService(base.prisma);
  const cloture = new OffresClotureService(base.prisma, bus as never, journal);
  const appli = appliLivreurSimulee(base.prisma);
  const garde = new GardeOffresService(base.prisma, cloture, journal, appli.service);
  const courseEvent = {
    offerNew: jest.fn(async () => undefined),
    courseStatutChanged: jest.fn(async () => undefined),
    courseCancelled: jest.fn(async () => undefined),
  };
  const push = {
    notifyPickupValidated: jest.fn(),
    notifyCourseCancelled: jest.fn(),
    notifyNewCourseOffer: jest.fn(),
  };
  const offres = new CourseOfferService(
    base.prisma,
    courseEvent as never,
    new CourseHelper(),
    {
      load: jest.fn(async () => ({ offerDurationSeconds: 120, maxRefusalCount: 5 })),
      // Ancienne méthode (v1) : la recherche choisit elle-même le livreur.
      versionPour: jest.fn(async () => 'v1'),
    } as never,
    { pickBestCandidate: jest.fn(async () => null) } as never,
    {} as never,
    { load: jest.fn(async () => ({ scoringShadowMode: false })) } as never,
    push as never,
    {} as never,
    {} as never,
    garde,
    appli.service,
  );
  const offerNext = jest.spyOn(offres, 'offerNextDeliverer');
  const queryService = { findByActivePickupCode: jest.fn() };
  const actions = new CourseActionService(
    base.prisma,
    courseEvent as never,
    offres,
    {} as never,
    push as never,
    { confirmerRetrait: jest.fn(async () => undefined) } as never,
    {} as never,
    queryService as never,
    garde,
  );
  const estimation = jest.spyOn(actions, 'estimerDureeTournee').mockResolvedValue(undefined);
  const enLivraison = new CourseEnLivraisonService(base.prisma, courseEvent as never, push as never, actions, journal);
  const annulationAuto = new AnnulationAutoService(
    base.prisma,
    courseEvent as never,
    push as never,
    enLivraison,
    offres,
    journal,
  );
  const ecouteur = new RemiseCaisseListener(enLivraison);
  return { ...base, courseEvent, push, offres, offerNext, actions, queryService, estimation, enLivraison, annulationAuto, ecouteur };
}

/** Ce que `PATCH /orders/:id/status` émet après avoir passé la commande PICKED_UP. */
const commandeRemise = (o: Record<string, any>) =>
  ({ order: { ...o, status: OrderStatus.PICKED_UP, type: OrderType.DELIVERY } }) as never;

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ============================================================
// BOUTON « LIVREUR A RÉCUPÉRÉ »
// ============================================================

describe('bouton de la caisse « Livreur a récupéré » (PATCH /orders/:id/status → PICKED_UP)', () => {
  it('course au restaurant : elle part en livraison comme par le code ; l’autre commande reste à remettre', async () => {
    const d = livreur({ last_available_at: null });
    const arrivee = avant(6);
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: d.id, assigned_at: avant(15), at_restaurant_at: arrivee },
      [OrderStatus.READY, OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });
    commandes[0].status = OrderStatus.PICKED_UP; // écrit par updateStatus avant l'événement

    await t.ecouteur.onStatutCommande(commandeRemise(commandes[0]));

    expect(c).toMatchObject({
      statut: CourseStatut.IN_DELIVERY,
      picked_up_at: MAINTENANT,
      at_restaurant_at: arrivee,
    });
    expect(commandes[1].status).toBe(OrderStatus.READY);
    expect(livraisons.map((l) => l.statut)).toEqual([DeliveryStatut.PENDING, DeliveryStatut.PENDING]);
    expect(t.courseEvent.courseStatutChanged).toHaveBeenCalledWith(
      expect.objectContaining({ previous_statut: CourseStatut.AT_RESTAURANT, new_statut: CourseStatut.IN_DELIVERY }),
    );
    expect(t.push.notifyPickupValidated).toHaveBeenCalledWith({
      delivererId: d.id,
      courseReference: c.reference,
      courseId: c.id,
    });
    expect(t.estimation).toHaveBeenCalledWith(c.id);
    expect(t.journal).toEqual([
      expect.objectContaining({
        type: 'COURSE_EN_LIVRAISON_PAR_CAISSE',
        source: 'caisse',
        course_id: c.id,
        order_id: commandes[0].id,
        deliverer_id: d.id,
        restaurant_id: RESTO,
      }),
    ]);

    // Seconde commande remise par le même bouton : la course est déjà partie, rien de plus.
    commandes[1].status = OrderStatus.PICKED_UP;
    await t.ecouteur.onStatutCommande(commandeRemise(commandes[1]));
    expect(t.courseEvent.courseStatutChanged).toHaveBeenCalledTimes(1);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
  });

  it('course acceptée, livreur pas vu au restaurant par le GPS : arrivée tracée au retrait', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.ACCEPTED, deliverer_id: d.id, assigned_at: avant(10) },
      [OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });

    await t.ecouteur.onStatutCommande(commandeRemise(commandes[0]));

    expect(c).toMatchObject({ statut: CourseStatut.IN_DELIVERY, at_restaurant_at: MAINTENANT, picked_up_at: MAINTENANT });
  });

  it('course confiée à Turbo, course sans livreur, commande à emporter : la course ne bouge pas', async () => {
    const turbo = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, turbo_escalated_at: avant(20) },
      [OrderStatus.READY],
    );
    const sansLivreur = courseAvecCommandes({}, [OrderStatus.READY]);
    const t = monter({
      courses: [turbo.course, sansLivreur.course],
      commandes: [...turbo.commandes, ...sansLivreur.commandes],
      livraisons: [...turbo.livraisons, ...sansLivreur.livraisons],
    });

    await t.ecouteur.onStatutCommande(commandeRemise(turbo.commandes[0]));
    await t.ecouteur.onStatutCommande(commandeRemise(sansLivreur.commandes[0]));
    await t.ecouteur.onStatutCommande({
      order: { ...sansLivreur.commandes[0], status: OrderStatus.PICKED_UP, type: OrderType.PICKUP },
    } as never);

    expect(turbo.course.statut).toBe(CourseStatut.AT_RESTAURANT);
    expect(sansLivreur.course.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
    expect(t.courseEvent.courseStatutChanged).not.toHaveBeenCalled();
    // Course encore sans livreur : anomalie journalisée, une seule fois (la commande à emporter est ignorée).
    expect(t.journal.map((l) => l.type)).toEqual(['REMISE_CAISSE_SANS_LIVREUR']);
  });

  it('code validé en même temps que le bouton : la course ne part qu’une fois, la caisse reçoit 409', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: d.id },
      [OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });
    // La caisse a lu la course « au restaurant »…
    const lueParLaCaisse = { ...c, deliveries: [{ order: { ...commandes[0] } }] };
    t.queryService.findByActivePickupCode.mockResolvedValue(lueParLaCaisse);
    // … pendant que le bouton la faisait partir.
    await t.ecouteur.onStatutCommande(commandeRemise(commandes[0]));

    expect(await t.actions.validatePickupByCashier({ pickup_code: '421' } as never, undefined).catch((e) => e)).toEqual(
      new ConflictException("Cette course vient d'être remise au livreur."),
    );
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
    expect(t.courseEvent.courseStatutChanged).toHaveBeenCalledTimes(1);
  });

  it('code validé entre la lecture et l’écriture du bouton : la course ne repart pas une seconde fois', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: d.id },
      [OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });
    const lire = t.prisma.course.findUnique.getMockImplementation();
    t.prisma.course.findUnique.mockImplementationOnce(async (args: any) => {
      const lue = await lire(args);
      // La caisse valide le code juste après la lecture du bouton.
      Object.assign(c, { statut: CourseStatut.IN_DELIVERY, picked_up_at: new Date('2026-10-22T13:59:00.000Z') });
      return lue;
    });

    expect(await t.enLivraison.passerEnLivraison(c.id)).toEqual({ passee: false, detachees: [] });
    expect(c.picked_up_at).toEqual(new Date('2026-10-22T13:59:00.000Z'));
    expect(t.courseEvent.courseStatutChanged).not.toHaveBeenCalled();
    expect(t.push.notifyPickupValidated).not.toHaveBeenCalled();
  });

  it('le GPS fait passer la course « au restaurant » pendant la validation par code : le retrait passe', async () => {
    // Relecture adverse : l'écriture exigeait le statut EXACT lu juste avant.
    // La caisse recevait « Cette course vient d'être remise au livreur. »,
    // remettait les plats, et la course bloquée partait 30 min plus tard vers
    // un second livreur.
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.ACCEPTED, deliverer_id: d.id },
      [OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });
    t.queryService.findByActivePickupCode.mockResolvedValue({ ...c, deliveries: [{ order: { ...commandes[0] } }] });
    // Arrivée vue par le GPS entre la lecture de la caisse et son écriture.
    Object.assign(c, { statut: CourseStatut.AT_RESTAURANT, at_restaurant_at: avant(1) });

    await t.actions.validatePickupByCashier({ pickup_code: '421' } as never, undefined);

    expect(c.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(commandes[0].status).toBe(OrderStatus.PICKED_UP);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
  });

  it('course Turbo : le webhook « livreur trouvé » arrive pendant la validation par code : le retrait passe', async () => {
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: avant(10) },
      [OrderStatus.READY],
    );
    const t = monter({ courses: [c], commandes, livraisons });
    t.queryService.findByActivePickupCode.mockResolvedValue({ ...c, deliveries: [{ order: { ...commandes[0] } }] });
    c.statut = CourseStatut.ACCEPTED;

    await t.actions.validatePickupByCashier({ pickup_code: '421' } as never, undefined);

    expect(c.statut).toBe(CourseStatut.IN_DELIVERY);
  });

  it('course annulée pendant la validation par code : 409 qui dit que rien n’est enregistré', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: d.id },
      [OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });
    t.queryService.findByActivePickupCode.mockResolvedValue({ ...c, deliveries: [{ order: { ...commandes[0] } }] });
    c.statut = CourseStatut.CANCELLED;

    expect(await t.actions.validatePickupByCashier({ pickup_code: '421' } as never, undefined).catch((e) => e)).toEqual(
      new ConflictException("Cette course vient d'être annulée : la remise n'est pas enregistrée."),
    );
    // (La commande reste prête en vrai : `$transaction([...])` de Prisma est
    // atomique ; la base simulée n'annule que la forme fonction.)
    expect(c.statut).toBe(CourseStatut.CANCELLED);
    expect(t.push.notifyPickupValidated).not.toHaveBeenCalled();
  });

  it('code validé d’abord : le bouton ne fait rien de plus', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: d.id },
      [OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });
    t.queryService.findByActivePickupCode.mockResolvedValue({ ...c, deliveries: [{ order: { ...commandes[0] } }] });

    await t.actions.validatePickupByCashier({ pickup_code: '421' } as never, undefined);
    await t.ecouteur.onStatutCommande(commandeRemise(commandes[0]));

    expect(c.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
    expect(t.journal).toEqual([]);
  });
});

// ============================================================
// ANNULATION AUTOMATIQUE
// ============================================================

describe('annulation automatique d’une course bloquée (tâche de 5 min)', () => {
  it('rien de remis : course annulée, commandes INTACTES et relancées dans une nouvelle course', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: d.id, total_delivery_fee: 2000 },
      [OrderStatus.READY, OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });

    const resultat = await t.annulationAuto.annulerAutomatiquement(c.id, 'Annulation automatique : test');

    expect(c).toMatchObject({
      statut: CourseStatut.CANCELLED,
      cancelled_by: 'system',
      cancelled_reason: 'Annulation automatique : test',
    });
    // Jamais une commande de client.
    expect(commandes.map((o) => o.status)).toEqual([OrderStatus.READY, OrderStatus.READY]);
    expect(commandes.every((o) => o.cancelled_at === null)).toBe(true);
    // Relancées dans une NOUVELLE course, référence neuve, livraisons déplacées.
    const nouvelle = t.courses.find((x) => x.id !== c.id)!;
    expect(nouvelle).toMatchObject({ statut: CourseStatut.PENDING_ASSIGNMENT, total_delivery_fee: 2000 });
    expect(nouvelle.reference).not.toBe(c.reference);
    expect(livraisons.map((l) => [l.course_id, l.statut])).toEqual([
      [nouvelle.id, DeliveryStatut.PENDING],
      [nouvelle.id, DeliveryStatut.PENDING],
    ]);
    expect(t.offerNext).toHaveBeenCalledWith(nouvelle.id);
    expect(c.total_delivery_fee).toBe(0);
    // Livreur et écrans prévenus ; DispatchListener remettra le livreur dans la file.
    expect(t.courseEvent.courseCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled_by: 'system', reason: 'Annulation automatique : test' }),
    );
    expect(t.push.notifyCourseCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: d.id, cancelledBy: 'le système' }),
    );
    expect(resultat).toEqual({
      issue: 'ANNULEE',
      commandes_remises: [],
      commandes_relancees: commandes.map((o) => o.reference),
      nouvelle_course_id: nouvelle.id,
    });
    expect(t.journal).toEqual([
      expect.objectContaining({ type: 'ANNULATION_AUTO_COMMANDES_GARDEES', motif: 'ANNULEE', course_id: c.id }),
    ]);
  });

  it('une commande déjà remise : la course part en livraison avec elle, l’autre est relancée', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: d.id, total_delivery_fee: 2000 },
      [OrderStatus.PICKED_UP, OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });

    const resultat = await t.annulationAuto.annulerAutomatiquement(c.id, 'Annulation automatique : test');

    expect(resultat?.issue).toBe('EN_LIVRAISON');
    expect(c).toMatchObject({ statut: CourseStatut.IN_DELIVERY, cancelled_at: null, picked_up_at: MAINTENANT });
    expect(commandes.map((o) => o.status)).toEqual([OrderStatus.PICKED_UP, OrderStatus.READY]);
    expect(livraisons[0]).toMatchObject({ course_id: c.id, statut: DeliveryStatut.PENDING });
    const nouvelle = t.courses.find((x) => x.id !== c.id)!;
    expect(livraisons[1]).toMatchObject({ course_id: nouvelle.id, statut: DeliveryStatut.PENDING });
    expect(nouvelle.total_delivery_fee).toBe(1000);
    expect(c.total_delivery_fee).toBe(1000);
    expect(t.courseEvent.courseCancelled).not.toHaveBeenCalled();
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
    expect(t.journal.map((l) => [l.type, l.motif])).toEqual([['ANNULATION_AUTO_COMMANDES_GARDEES', 'EN_LIVRAISON']]);
  });

  it('tout est remis : la course part en livraison, rien à relancer', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.ACCEPTED, deliverer_id: d.id },
      [OrderStatus.PICKED_UP, OrderStatus.PICKED_UP],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });

    await t.annulationAuto.annulerAutomatiquement(c.id, 'test');

    expect(c.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(t.courses).toHaveLength(1);
    expect(commandes.every((o) => o.status === OrderStatus.PICKED_UP)).toBe(true);
  });

  it('course remise par le code entre la lecture et l’écriture : rien n’est fait', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: d.id },
      [OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });
    const lire = t.prisma.course.findUnique.getMockImplementation();
    t.prisma.course.findUnique.mockImplementationOnce(async (args: any) => {
      const lue = await lire(args);
      c.statut = CourseStatut.IN_DELIVERY; // la caisse valide le code juste après la lecture
      return lue;
    });

    expect(await t.annulationAuto.annulerAutomatiquement(c.id, 'test')).toBeNull();
    expect(c.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(t.courses).toHaveLength(1);
    expect(t.journal).toEqual([]);
  });

  it('la tâche passe par l’annulation sans commandes (plus jamais cancelCourse « system »)', async () => {
    const annulationAuto = { annulerAutomatiquement: jest.fn(async () => null) };
    const prisma = {
      course: {
        findMany: jest.fn(async () => [{ id: 'c1', reference: 'CRS-1', statut: CourseStatut.AT_RESTAURANT }]),
      },
    };
    const tache = new CourseTask(
      prisma as never,
      {} as never,
      annulationAuto as never,
      { load: jest.fn(async () => ({ autoCancelAcceptedAfterMin: 30, autoCancelAtRestaurantAfterMin: 30 })) } as never,
      {} as never,
    );

    await tache.autoCancelStuckCourses();

    expect(annulationAuto.annulerAutomatiquement).toHaveBeenCalledWith(
      'c1',
      "Annulation automatique : Caissière n'a pas validé la récupération depuis 30 min",
    );
  });
});

// ============================================================
// ANNULATION MANUELLE (backoffice, livreur)
// ============================================================

/**
 * Défaut relevé le 22/10 : l'écriture sur les commandes suivait, dans la même
 * transaction, l'annulation des livraisons, et filtrait sur une livraison PAS
 * annulée : elle ne trouvait jamais rien (code mort depuis c7ed9de). Les
 * commandes restaient accrochées à la course annulée : une commande remise au
 * livreur ne pouvait plus repartir.
 *
 * Règle du client : annuler une course n'annule JAMAIS une commande. Chaque
 * commande pas livrée repart dans une nouvelle course, les livrées ne bougent
 * pas, aucun paiement ni encaissement n'est touché (la base simulée n'a pas de
 * table des paiements : un accès lèverait).
 */
describe('cancelCourse : annulation manuelle, aucune commande annulée ni laissée sur la course', () => {
  it('course au restaurant annulée par l’administration : commandes intactes et relancées, livreur et écrans prévenus', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.AT_RESTAURANT, deliverer_id: d.id, assigned_at: avant(15), total_delivery_fee: 2000 },
      [OrderStatus.READY, OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });

    const rendue = await t.actions.cancelCourse(c.id, 'admin', { reason: 'Livreur en panne' } as never);

    expect(c).toMatchObject({
      statut: CourseStatut.CANCELLED,
      cancelled_by: 'admin',
      cancelled_reason: 'Livreur en panne',
      cancelled_at: MAINTENANT,
    });
    expect(rendue).toMatchObject({ id: c.id, statut: CourseStatut.CANCELLED });
    // Jamais une commande de client.
    expect(commandes.map((o) => o.status)).toEqual([OrderStatus.READY, OrderStatus.READY]);
    expect(commandes.every((o) => o.cancelled_at === null)).toBe(true);
    // Plus rien sur la course annulée : nouvelle course, référence neuve.
    const nouvelle = t.courses.find((x) => x.id !== c.id)!;
    expect(nouvelle).toMatchObject({ statut: CourseStatut.PENDING_ASSIGNMENT, total_delivery_fee: 2000 });
    expect(nouvelle.reference).not.toBe(c.reference);
    expect(livraisons.map((l) => [l.course_id, l.statut])).toEqual([
      [nouvelle.id, DeliveryStatut.PENDING],
      [nouvelle.id, DeliveryStatut.PENDING],
    ]);
    expect(t.offerNext).toHaveBeenCalledWith(nouvelle.id);
    expect(c.total_delivery_fee).toBe(0);
    // Livreur et écrans prévenus une fois ; DispatchListener le remet dans la file.
    expect(t.courseEvent.courseCancelled).toHaveBeenCalledTimes(1);
    expect(t.courseEvent.courseCancelled).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelled_by: 'admin',
        reason: 'Livreur en panne',
        course: expect.objectContaining({ id: c.id, statut: CourseStatut.CANCELLED, deliverer_id: d.id }),
      }),
    );
    expect(t.push.notifyCourseCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: d.id, cancelledBy: "l'administration", courseId: c.id }),
    );
  });

  it('course en livraison annulée par le livreur : la livrée ne bouge pas, la remise pas livrée revient prête et repart', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.IN_DELIVERY, deliverer_id: d.id, assigned_at: avant(30), picked_up_at: avant(10) },
      [OrderStatus.COLLECTED, OrderStatus.PICKED_UP],
    );
    // Livrée, encaissement en attente de confirmation au backoffice.
    Object.assign(livraisons[0], { statut: DeliveryStatut.DELIVERED, delivered_at: avant(3) });
    Object.assign(commandes[0], { paied: false, picked_up_at: avant(10) });
    // Remise au livreur, en route, déjà payée en ligne.
    Object.assign(livraisons[1], { statut: DeliveryStatut.IN_ROUTE, in_route_at: avant(2) });
    Object.assign(commandes[1], { paied: true, picked_up_at: avant(10) });
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });

    await t.actions.cancelCourse(c.id, 'deliverer', { reason: 'Moto en panne' } as never, d.id);

    expect(c.statut).toBe(CourseStatut.CANCELLED);
    // Déjà livrée : rien ne bouge.
    expect(commandes[0]).toMatchObject({ status: OrderStatus.COLLECTED, paied: false, cancelled_at: null });
    expect(livraisons[0]).toMatchObject({ course_id: c.id, statut: DeliveryStatut.DELIVERED });
    // Remise, pas livrée : revient prête au comptoir, repart dans une nouvelle course, toujours payée.
    expect(commandes[1]).toMatchObject({ status: OrderStatus.READY, picked_up_at: null, paied: true, cancelled_at: null });
    const nouvelle = t.courses.find((x) => x.id !== c.id)!;
    expect(nouvelle.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
    expect(livraisons[1]).toMatchObject({ course_id: nouvelle.id, statut: DeliveryStatut.PENDING, in_route_at: null });
    // Le livreur a annulé lui-même : pas de notification, les écrans sont prévenus.
    expect(t.push.notifyCourseCancelled).not.toHaveBeenCalled();
    expect(t.courseEvent.courseCancelled).toHaveBeenCalledWith(expect.objectContaining({ cancelled_by: 'deliverer' }));
  });

  it('deux annulations en même temps : une seule passe, l’autre reçoit 400, une seule relance', async () => {
    const d = livreur({ last_available_at: null });
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.ACCEPTED, deliverer_id: d.id, assigned_at: avant(10) },
      [OrderStatus.READY],
    );
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons });

    const issues = await Promise.allSettled([
      t.actions.cancelCourse(c.id, 'admin', { reason: 'un' } as never),
      t.actions.cancelCourse(c.id, 'deliverer', { reason: 'deux' } as never, d.id),
    ]);

    expect(issues.map((i) => i.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refus = issues.find((i): i is PromiseRejectedResult => i.status === 'rejected')!;
    expect(refus.reason).toEqual(new BadRequestException('Course déjà terminée'));
    expect(t.courseEvent.courseCancelled).toHaveBeenCalledTimes(1);
    expect(t.courses).toHaveLength(2);
    expect(livraisons[0].course_id).not.toBe(c.id);
  });

  it('course confiée à Turbo : rien n’est relancé d’office (jamais deux livreurs), la commande reste à relancer', async () => {
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: avant(5) },
      [OrderStatus.READY, OrderStatus.PICKED_UP],
    );
    commandes.forEach((o) => (o.delivery_service = DeliveryService.TURBO));
    const t = monter({ courses: [c], commandes, livraisons });

    await t.actions.cancelCourse(c.id, 'admin', {} as never);

    expect(c.statut).toBe(CourseStatut.CANCELLED);
    // Même état qu'après une annulation venue de Turbo : « Relancer la livraison » au backoffice.
    expect(livraisons.map((l) => [l.course_id, l.statut])).toEqual([
      [c.id, DeliveryStatut.CANCELLED],
      [c.id, DeliveryStatut.CANCELLED],
    ]);
    // La commande remise reste chez leur livreur : ses webhooks la livrent et l'encaissent.
    expect(commandes.map((o) => o.status)).toEqual([OrderStatus.READY, OrderStatus.PICKED_UP]);
    expect(t.courses).toHaveLength(1);
    expect(t.courseEvent.courseCancelled).toHaveBeenCalledTimes(1);
  });

  it('course déjà terminée : 400, rien n’est écrit', async () => {
    const { course: c, commandes, livraisons } = courseAvecCommandes({ statut: CourseStatut.COMPLETED }, [
      OrderStatus.COMPLETED,
    ]);
    livraisons[0].statut = DeliveryStatut.DELIVERED;
    const t = monter({ courses: [c], commandes, livraisons });

    expect(await t.actions.cancelCourse(c.id, 'admin', {} as never).catch((e) => e)).toEqual(
      new BadRequestException('Course déjà terminée'),
    );
    expect(c.statut).toBe(CourseStatut.COMPLETED);
    expect(t.courseEvent.courseCancelled).not.toHaveBeenCalled();
  });
});
