/**
 * Rééquilibrage (fusion et transfert de livraisons) et livreur qui perd sa
 * course, avec la VRAIE clôture des offres et la VRAIE remise en file :
 *  - l'offre de la course absorbée est close sans pénalité ;
 *  - le livreur de la course absorbée revient dans la file à sa place ;
 *  - jamais d'ajout à la course d'un livreur en pause ;
 *  - frais de livraison recalculés, offre à jour renvoyée au livreur sollicité ;
 *  - course annulée : offres closes, livreur remis dans la file (sauf en pause).
 */
import { CourseOfferStatus, CourseStatut, DeliveryService, OrderStatus } from '@prisma/client';

import { FIN_PAUSE_INDEFINIE } from 'src/modules/deliverers/helpers/disponibilite.rules';
import { busSimule } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';
import { DelivererQueueService } from 'src/modules/deliverers/services/deliverer-queue.service';

import { CourseChannels } from '../enums/course-channels';
import { DispatchListener } from '../listeners/dispatch.listener';
import {
  DonneesDispatch,
  course,
  courseAvecCommandes,
  livreur,
  monterBaseDispatch,
  offre,
} from './base-dispatch.simulee-spec';
import { CourseGroupingService } from './course-grouping.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { OffresClotureService } from './offres-cloture.service';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);
const apres = (s: number) => new Date(MAINTENANT.getTime() + s * 1000);

/** Deux clients voisins (Biétry), compatibles pour l'ancien critère (1 500 m). */
const ADRESSE_A = { latitude: 5.2705, longitude: -3.9663 };
const ADRESSE_B = { latitude: 5.2712, longitude: -3.9671 };

function monter(donnees: DonneesDispatch) {
  const base = monterBaseDispatch(donnees);
  const { bus, emis } = busSimule();
  const journal = new DispatchJournalService(base.prisma);
  const cloture = new OffresClotureService(base.prisma, bus as never, journal);
  const queue = new DelivererQueueService(base.prisma, {} as never, {} as never, {} as never);
  const courseEvent = {
    courseStatutChanged: jest.fn(async () => undefined),
    offerNew: jest.fn(async () => undefined),
  };
  const offres = { offerNextDeliverer: jest.fn(async () => undefined) };
  const settings = {
    load: jest.fn(async () => ({ rebalanceEnabled: true, maxOrdersPerCourse: 3, maxDetourMeters: 1500 })),
  };
  const regroupement = new CourseGroupingService(
    base.prisma,
    settings as never,
    offres as never,
    courseEvent as never,
    cloture,
    queue,
    journal,
  );
  const ecouteur = new DispatchListener(
    base.prisma,
    offres as never,
    {} as never,
    journal,
    {} as never,
    {} as never,
    cloture,
    queue,
  );
  const fermetures = () => emis.filter((e) => e.canal === CourseChannels.COURSE_OFFER_EXPIRED).map((e) => e.charge);
  return { ...base, regroupement, ecouteur, courseEvent, offresService: offres, fermetures };
}

/** Course d'une commande à l'adresse donnée. */
function courseA(adresse: Record<string, number>, surcharge: Record<string, any>) {
  const r = courseAvecCommandes(surcharge, [OrderStatus.READY]);
  r.commandes[0].address = adresse;
  return r;
}

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('rééquilibrage : fusion de courses', () => {
  it('offre de la course absorbée close sans pénalité ; frais recalculés ; offre à jour renvoyée au livreur de la cible', async () => {
    const d1 = livreur();
    const d2 = livreur();
    const cible = courseA(ADRESSE_A, { created_at: avant(3), total_delivery_fee: 1000, offer_expires_at: apres(60) });
    const absorbee = courseA(ADRESSE_B, { created_at: avant(1), total_delivery_fee: 1000, offer_expires_at: apres(90) });
    const offreCible = offre({ course_id: cible.course.id, deliverer_id: d1.id, expires_at: apres(60) });
    const offreAbsorbee = offre({ course_id: absorbee.course.id, deliverer_id: d2.id, expires_at: apres(90) });
    const t = monter({
      livreurs: [d1, d2],
      courses: [cible.course, absorbee.course],
      commandes: [...cible.commandes, ...absorbee.commandes],
      livraisons: [...cible.livraisons, ...absorbee.livraisons],
      offres: [offreCible, offreAbsorbee],
    });

    expect(await t.regroupement.rebalanceActiveCourses()).toEqual({ merged: 1, transferred: 1 });

    expect(absorbee.course).toMatchObject({ statut: CourseStatut.CANCELLED, cancelled_by: 'system', total_delivery_fee: 0 });
    expect(absorbee.livraisons[0].course_id).toBe(cible.course.id);
    expect(cible.course.total_delivery_fee).toBe(2000);
    // Offre de la course absorbée : close, sans pénalité ni refus compté.
    expect(offreAbsorbee.status).toBe(CourseOfferStatus.CANCELLED);
    expect(absorbee.course.refusal_count).toBe(0);
    expect(t.fermetures()).toEqual([
      { course_id: absorbee.course.id, deliverer_id: d2.id, motif: 'COURSE_FUSIONNEE' },
    ]);
    // Le livreur sollicité pour la cible voit l'offre à jour, même échéance.
    expect(offreCible.status).toBe(CourseOfferStatus.PENDING);
    expect(t.courseEvent.offerNew).toHaveBeenCalledWith(
      expect.objectContaining({ deliverer_id: d1.id, offer_id: cible.course.id, expires_at: apres(60), renvoi: true }),
    );
  });

  it('livreur de la course absorbée (acceptée) : remis dans la file à la place de son acceptation', async () => {
    const accepteA = avant(6);
    const d2 = livreur({ last_available_at: null });
    const cible = courseA(ADRESSE_A, { created_at: avant(8) });
    const absorbee = courseA(ADRESSE_B, {
      created_at: avant(7),
      statut: CourseStatut.ACCEPTED,
      deliverer_id: d2.id,
      assigned_at: accepteA,
    });
    const t = monter({
      livreurs: [d2],
      courses: [cible.course, absorbee.course],
      commandes: [...cible.commandes, ...absorbee.commandes],
      livraisons: [...cible.livraisons, ...absorbee.livraisons],
    });

    await t.regroupement.rebalanceActiveCourses();

    expect(absorbee.course.statut).toBe(CourseStatut.CANCELLED);
    expect(d2.last_available_at).toEqual(accepteA);
    expect(t.journal.find((l) => l.type === 'REMIS_EN_FILE')).toMatchObject({
      motif: 'COURSE_FUSIONNEE',
      deliverer_id: d2.id,
      course_id: absorbee.course.id,
    });
    // La cible, encore sans livreur, est reproposée tout de suite.
    expect(t.offresService.offerNextDeliverer).toHaveBeenCalledWith(cible.course.id);
  });

  it('courses Turbo d’origine (envoi à retenter) fusionnées : aucune offre à un livreur interne', async () => {
    // Relecture adverse : la relance ajoutée au rééquilibrage proposait aux
    // livreurs internes une course Turbo dont l'envoi avait échoué
    // (`turbo_escalated_at` remis à nul en attendant le nouvel essai).
    const cible = courseA(ADRESSE_A, { created_at: avant(3) });
    const absorbee = courseA(ADRESSE_B, { created_at: avant(1) });
    for (const o of [...cible.commandes, ...absorbee.commandes]) o.delivery_service = DeliveryService.TURBO;
    const t = monter({
      livreurs: [livreur()],
      courses: [cible.course, absorbee.course],
      commandes: [...cible.commandes, ...absorbee.commandes],
      livraisons: [...cible.livraisons, ...absorbee.livraisons],
    });

    expect(await t.regroupement.rebalanceActiveCourses()).toEqual({ merged: 1, transferred: 1 });
    expect(t.offresService.offerNextDeliverer).not.toHaveBeenCalled();
  });

  it('livreur de la cible en pause : aucune commande ajoutée à sa course', async () => {
    const enPause = livreur({ pause_until: FIN_PAUSE_INDEFINIE, last_available_at: null });
    const cible = courseA(ADRESSE_A, {
      created_at: avant(8),
      statut: CourseStatut.ACCEPTED,
      deliverer_id: enPause.id,
      assigned_at: avant(7),
    });
    const autre = courseA(ADRESSE_B, { created_at: avant(1) });
    const t = monter({
      livreurs: [enPause],
      courses: [cible.course, autre.course],
      commandes: [...cible.commandes, ...autre.commandes],
      livraisons: [...cible.livraisons, ...autre.livraisons],
    });

    expect(await t.regroupement.rebalanceActiveCourses()).toEqual({ merged: 0, transferred: 0 });
    expect(autre.livraisons[0].course_id).toBe(autre.course.id);
    expect(autre.course.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
  });
});

describe('course annulée : offres closes, livreur remis dans la file', () => {
  const annulee = (c: Record<string, any>, cancelled_by: string) =>
    ({ course: { ...c, statut: CourseStatut.CANCELLED }, cancelled_by }) as never;

  it('par l’administration : offre en attente close, livreur remis à la place de son acceptation', async () => {
    const d = livreur({ last_available_at: null });
    const sollicite = livreur();
    const accepteA = avant(12);
    const c = course({ statut: CourseStatut.CANCELLED, deliverer_id: d.id, assigned_at: accepteA });
    const enRecherche = course({ statut: CourseStatut.CANCELLED });
    const o = offre({ course_id: enRecherche.id, deliverer_id: sollicite.id, expires_at: apres(60) });
    const t = monter({ livreurs: [d, sollicite], courses: [c, enRecherche], offres: [o] });

    await t.ecouteur.onCourseAnnulee(annulee(c, 'admin'));
    await t.ecouteur.onCourseAnnulee(annulee(enRecherche, 'admin'));

    expect(d.last_available_at).toEqual(accepteA);
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.fermetures()).toEqual([{ course_id: enRecherche.id, deliverer_id: sollicite.id, motif: 'COURSE_ANNULEE' }]);
    expect(t.journal.map((l) => [l.type, l.motif, l.source])).toEqual([
      ['REMIS_EN_FILE', 'COURSE_ANNULEE', 'admin'],
      ['OFFRE_CLOSE', 'COURSE_ANNULEE', 'admin'],
    ]);
  });

  it('par le livreur ou par la tâche automatique : fin de file', async () => {
    const d1 = livreur({ last_available_at: null });
    const d2 = livreur({ last_available_at: null });
    const c1 = course({ statut: CourseStatut.CANCELLED, deliverer_id: d1.id, assigned_at: avant(20) });
    const c2 = course({ statut: CourseStatut.CANCELLED, deliverer_id: d2.id, assigned_at: avant(40) });
    const t = monter({ livreurs: [d1, d2], courses: [c1, c2] });

    await t.ecouteur.onCourseAnnulee(annulee(c1, 'deliverer'));
    await t.ecouteur.onCourseAnnulee(annulee(c2, 'system'));

    expect(d1.last_available_at).toEqual(MAINTENANT);
    expect(d2.last_available_at).toEqual(MAINTENANT);
  });

  it('livreur en pause, en pause automatique, déjà dans la file ou avec une autre course : rien ne change', async () => {
    const enPause = livreur({ pause_until: FIN_PAUSE_INDEFINIE, last_available_at: null });
    const pauseAuto = livreur({ auto_pause_until: apres(600), last_available_at: null });
    const dansLaFile = livreur({ last_available_at: avant(90) });
    const occupe = livreur({ last_available_at: null });
    const courses = [enPause, pauseAuto, dansLaFile, occupe].map((d) =>
      course({ statut: CourseStatut.CANCELLED, deliverer_id: d.id, assigned_at: avant(10) }),
    );
    const autreCourse = course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: occupe.id });
    const t = monter({ livreurs: [enPause, pauseAuto, dansLaFile, occupe], courses: [...courses, autreCourse] });

    for (const c of courses) await t.ecouteur.onCourseAnnulee(annulee(c, 'admin'));

    expect([enPause, pauseAuto, occupe].map((d) => d.last_available_at)).toEqual([null, null, null]);
    expect(dansLaFile.last_available_at).toEqual(avant(90));
    expect(t.journal.filter((l) => l.type === 'REMIS_EN_FILE')).toEqual([]);
  });
});
