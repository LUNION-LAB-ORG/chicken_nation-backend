/**
 * Lot 1, seconde moitié : la règle unique garde les offres qui ne passent pas
 * par la sélection automatique. Testé avec les VRAIS services (offres,
 * actions, gardes, clôture, journal) sur une base simulée qui évalue les
 * `where` et annule les transactions.
 *
 *  - acceptation conditionnelle : 409 « Cette course n'est plus disponible. »
 *    et offre close ;
 *  - affectation forcée : 409 avec la raison (« Ce livreur est en pause
 *    jusqu'à 14 h 32. ») ;
 *  - jamais deux offres en attente pour un livreur ;
 *  - relances : offre close si le livreur ou la course ne s'y prêtent plus ;
 *  - expiration : réservation atomique, pas de pénalité dans les cas prévus ;
 *  - bascule manuelle vers Turbo : offre close avant l'envoi.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CourseOfferStatus, CourseStatut, OrderStatus } from '@prisma/client';

import { busSimule } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';
import {
  FIN_PAUSE_INDEFINIE,
  filtreLivreursPouvantRecevoirOffre,
} from 'src/modules/deliverers/helpers/disponibilite.rules';

import { CourseAdminController } from '../controllers/course-admin.controller';
import { CourseChannels } from '../enums/course-channels';
import { DispatchEvenements } from '../enums/dispatch-evenements';
import { CourseHelper } from '../helpers/course.helper';
import { CLASSE_VERROU_OFFRE_LIVREUR } from '../helpers/offres.rules';
import {
  DonneesDispatch,
  course,
  courseAvecCommandes,
  livreur,
  monterBaseDispatch,
  offre,
} from './base-dispatch.simulee-spec';
import { CourseActionService } from './course-action.service';
import { CourseOfferService } from './course-offer.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { GardeOffresService } from './garde-offres.service';
import { OffresClotureService } from './offres-cloture.service';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (s: number) => new Date(MAINTENANT.getTime() - s * 1000);
const apres = (s: number) => new Date(MAINTENANT.getTime() + s * 1000);

function monter(donnees: DonneesDispatch, options: { turbo?: { sentOrderIds: string[]; uncertain?: boolean } } = {}) {
  const base = monterBaseDispatch(donnees);
  const { bus, emis } = busSimule();
  const journal = new DispatchJournalService(base.prisma);
  const cloture = new OffresClotureService(base.prisma, bus as never, journal);
  const garde = new GardeOffresService(base.prisma, cloture, journal);

  const courseEvent = {
    offerNew: jest.fn(async () => undefined),
    offerExpired: jest.fn(async () => undefined),
    offerRefused: jest.fn(async () => undefined),
    courseAssigned: jest.fn(async () => undefined),
    courseStatutChanged: jest.fn(async () => undefined),
    courseCancelled: jest.fn(async () => undefined),
  };
  const settings = {
    load: jest.fn(async () => ({
      offerDurationSeconds: 120,
      maxRefusalCount: 5,
      noDelivererMaxWaitMin: 60,
      noDelivererAlertAfterMin: 5,
      turboFallbackEnabled: false,
      turboFallbackAfterMin: 4,
    })),
  };
  // Sélection : la VRAIE règle (filtre Prisma), dans l'ordre de la file.
  const scoring = {
    pickBestCandidate: jest.fn(async ({ excludeIds }: { excludeIds: string[] }) => {
      const choisi = await base.prisma.deliverer.findFirst({
        where: { ...filtreLivreursPouvantRecevoirOffre(new Date()), id: { notIn: excludeIds } },
        orderBy: { last_available_at: 'asc' },
        select: { id: true },
      });
      return choisi ? { delivererId: choisi.id, components: { chain: 0 } } : null;
    }),
  };
  const queue = {
    onOfferExpired: jest.fn(async () => ({ autoPaused: false })),
    onAccept: jest.fn(async () => undefined),
    onRefuse: jest.fn(async () => ({ autoPaused: false })),
  };
  const push = {
    notifyNewCourseOffer: jest.fn(),
    notifyCourseOfferReminder: jest.fn(),
    notifyCourseAssigned: jest.fn(),
  };
  const cloche = {
    sendCourseTurboFallbackBell: jest.fn(async () => undefined),
    sendTurboPickupSyncFailedBell: jest.fn(async () => undefined),
    sendCourseNoDelivererBell: jest.fn(async () => undefined),
  };
  const statutsAuMomentDeLEnvoi: string[] = [];
  const turbo = {
    creerCourseGroupe: jest.fn(async () => {
      statutsAuMomentDeLEnvoi.push(...base.offres.map((o) => o.status));
      return options.turbo ?? { sentOrderIds: base.commandes.map((o) => o.id) };
    }),
  };

  const nouveauServiceOffres = () =>
    new CourseOfferService(
      base.prisma,
      courseEvent as never,
      new CourseHelper(),
      settings as never,
      scoring as never,
      queue as never,
      { load: jest.fn(async () => ({ scoringShadowMode: false })) } as never,
      push as never,
      cloche as never,
      turbo as never,
      garde,
    );
  const serviceOffres = nouveauServiceOffres();
  const actions = new CourseActionService(
    base.prisma,
    courseEvent as never,
    serviceOffres,
    queue as never,
    push as never,
    {} as never,
    {} as never,
    {} as never,
    garde,
  );
  // Présence de l'appli du livreur (socket ouvert), lue par l'affectation forcée.
  const presence = { livreurConnecte: jest.fn(async (): Promise<boolean | null> => true) };
  const admin = new CourseAdminController({} as never, actions, serviceOffres, garde, presence as never);
  const types = () => base.journal.map((l) => l.type);
  const relances = () =>
    emis.filter((e) => e.canal === DispatchEvenements.RECHERCHE_A_RELANCER).map((e) => e.charge.course_id);
  const fermetures = () =>
    emis.filter((e) => e.canal === CourseChannels.COURSE_OFFER_EXPIRED).map((e) => e.charge);
  return {
    ...base,
    emis,
    garde,
    serviceOffres,
    actions,
    admin,
    presence,
    courseEvent,
    queue,
    push,
    turbo,
    scoring,
    statutsAuMomentDeLEnvoi,
    nouveauServiceOffres,
    types,
    relances,
    fermetures,
  };
}

/** Le rejet d'une promesse : classe et message. */
async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return { classe: (e as Error).constructor, message: (e as Error).message };
  }
  throw new Error('La promesse devait être rejetée');
}

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ============================================================
// ACCEPTATION CONDITIONNELLE
// ============================================================

describe('acceptation conditionnelle (POST /courses/deliverer/:id/accept)', () => {
  it('course en recherche, offre en attente : acceptée ; l’offre d’un autre livreur sur la course est close', async () => {
    const d1 = livreur();
    const d2 = livreur();
    const c = course({ offer_expires_at: apres(60) });
    const o1 = offre({ course_id: c.id, deliverer_id: d1.id, expires_at: apres(60) });
    const o2 = offre({ course_id: c.id, deliverer_id: d2.id, expires_at: apres(90) });
    const t = monter({ livreurs: [d1, d2], courses: [c], offres: [o1, o2] });

    const acceptee = await t.actions.acceptOffer(c.id, d1.id);

    expect(acceptee.id).toBe(c.id);
    expect(c).toMatchObject({
      statut: CourseStatut.ACCEPTED,
      deliverer_id: d1.id,
      assigned_at: MAINTENANT,
      offer_expires_at: null,
    });
    expect(o1.status).toBe(CourseOfferStatus.ACCEPTED);
    expect(o2.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.fermetures()).toEqual([
      { course_id: c.id, deliverer_id: d2.id, motif: 'COURSE_PLUS_EN_RECHERCHE' },
    ]);
    expect(t.relances()).toEqual([]);
    expect(t.queue.onAccept).toHaveBeenCalledWith(d1.id);
    expect(t.courseEvent.courseAssigned).toHaveBeenCalledTimes(1);
    expect(t.push.notifyCourseAssigned).toHaveBeenCalledWith(expect.objectContaining({ delivererId: d1.id }));
  });

  it('course fusionnée (annulée) : 409, rien n’est écrit sur la course, offre close sans pénalité', async () => {
    const d = livreur();
    const c = course({ statut: CourseStatut.CANCELLED, cancelled_by: 'system' });
    const o = offre({ course_id: c.id, deliverer_id: d.id, expires_at: apres(60) });
    const t = monter({ livreurs: [d], courses: [c], offres: [o] });

    expect(await refus(t.actions.acceptOffer(c.id, d.id))).toEqual({
      classe: ConflictException,
      message: "Cette course n'est plus disponible.",
    });
    // La transaction a été annulée : ni livreur ni statut accepté sur la course.
    expect(c).toMatchObject({ statut: CourseStatut.CANCELLED, deliverer_id: null, refusal_count: 0 });
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.queue.onAccept).not.toHaveBeenCalled();
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
    expect(t.courseEvent.courseAssigned).not.toHaveBeenCalled();
    expect(t.fermetures()).toEqual([{ course_id: c.id, deliverer_id: d.id, motif: 'COURSE_PLUS_EN_RECHERCHE' }]);
    expect(t.relances()).toEqual([]);
    expect(t.journal.map((l) => [l.type, l.motif])).toEqual([
      ['OFFRE_CLOSE', 'COURSE_PLUS_EN_RECHERCHE'],
      ['ACCEPTATION_REFUSEE', 'COURSE_PLUS_EN_RECHERCHE'],
    ]);
  });

  it('course confiée à Turbo : 409 « Cette course n’est plus disponible. », offre close', async () => {
    const d = livreur();
    const c = course({ turbo_escalated_at: avant(10) });
    const o = offre({ course_id: c.id, deliverer_id: d.id, expires_at: apres(60) });
    const t = monter({ livreurs: [d], courses: [c], offres: [o] });

    expect((await refus(t.actions.acceptOffer(c.id, d.id))).message).toBe("Cette course n'est plus disponible.");
    expect(c.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
    expect(c.deliverer_id).toBeNull();
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
  });

  it('offre déjà close : 409 ; offre échue : 409 et laissée à la tâche d’expiration', async () => {
    const d1 = livreur();
    const d2 = livreur();
    const c1 = course();
    const c2 = course();
    const close = offre({ course_id: c1.id, deliverer_id: d1.id, status: CourseOfferStatus.CANCELLED, expires_at: apres(60) });
    const echue = offre({ course_id: c2.id, deliverer_id: d2.id, expires_at: avant(1) });
    const t = monter({ livreurs: [d1, d2], courses: [c1, c2], offres: [close, echue] });

    expect((await refus(t.actions.acceptOffer(c1.id, d1.id))).classe).toBe(ConflictException);
    expect((await refus(t.actions.acceptOffer(c2.id, d2.id))).classe).toBe(ConflictException);
    expect(echue.status).toBe(CourseOfferStatus.PENDING);
    expect(c1.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
    expect(c2.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
    expect(t.types()).toEqual(['ACCEPTATION_REFUSEE', 'ACCEPTATION_REFUSEE']);
  });

  it('livreur déjà en course : 409 « Tu as déjà une course en cours. », offre close, recherche relancée', async () => {
    const d = livreur({ last_available_at: null });
    const enCours = course({ statut: CourseStatut.ACCEPTED, deliverer_id: d.id });
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: d.id, expires_at: apres(60) });
    const t = monter({ livreurs: [d], courses: [enCours, c], offres: [o] });

    expect((await refus(t.actions.acceptOffer(c.id, d.id))).message).toBe('Tu as déjà une course en cours.');
    expect(c.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.relances()).toEqual([c.id]);
    expect(t.journal.find((l) => l.type === 'ACCEPTATION_REFUSEE')?.motif).toBe('EN_COURSE');
  });

  it('deux livreurs acceptent la même course au même instant : un seul l’obtient, l’autre reçoit 409', async () => {
    const d1 = livreur();
    const d2 = livreur();
    const c = course();
    const t = monter({
      livreurs: [d1, d2],
      courses: [c],
      offres: [
        offre({ course_id: c.id, deliverer_id: d1.id, expires_at: apres(60) }),
        offre({ course_id: c.id, deliverer_id: d2.id, expires_at: apres(60) }),
      ],
    });

    const resultats = await Promise.allSettled([t.actions.acceptOffer(c.id, d1.id), t.actions.acceptOffer(c.id, d2.id)]);

    expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejet = resultats.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejet.reason).toBeInstanceOf(ConflictException);
    expect([d1.id, d2.id]).toContain(c.deliverer_id);
    expect(t.offres.filter((o) => o.status === CourseOfferStatus.ACCEPTED)).toHaveLength(1);
    expect(t.queue.onAccept).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// AFFECTATION FORCÉE
// ============================================================

describe('affectation forcée (PATCH /courses/:id/force-assign)', () => {
  const forcer = (t: ReturnType<typeof monter>, courseId: string, delivererId: string) =>
    t.admin.forceAssign(courseId, { deliverer_id: delivererId } as never);

  it('livreur en pause : 409 « Ce livreur est en pause jusqu’à 14 h 32. », journal, aucune offre', async () => {
    const d = livreur({ pause_until: new Date('2026-10-22T14:32:00.000Z'), last_available_at: null });
    const c = course();
    const t = monter({ livreurs: [d], courses: [c] });

    expect(await refus(forcer(t, c.id, d.id))).toEqual({
      classe: ConflictException,
      message: "Ce livreur est en pause jusqu'à 14 h 32.",
    });
    expect(t.offres).toHaveLength(0);
    expect(t.courseEvent.offerNew).not.toHaveBeenCalled();
    expect(t.journal).toEqual([
      expect.objectContaining({
        type: 'AFFECTATION_FORCEE_REFUSEE',
        motif: 'EN_PAUSE',
        source: 'admin',
        course_id: c.id,
        deliverer_id: d.id,
      }),
    ]);
  });

  it('pause automatique, pause sans fin, hors service, en course, offre ailleurs : 409 avec la raison', async () => {
    const autre = course();
    const cas: [Record<string, any>, string][] = [
      [{ auto_pause_until: new Date('2026-10-22T14:45:00.000Z') }, "Ce livreur est en pause automatique jusqu'à 14 h 45."],
      [{ pause_until: FIN_PAUSE_INDEFINIE }, 'Ce livreur est en pause.'],
      [{ last_available_at: null }, "Ce livreur est hors service : il n'a pas repris le travail dans l'appli."],
    ];
    for (const [surcharge, message] of cas) {
      const d = livreur(surcharge);
      const c = course();
      const t = monter({ livreurs: [d], courses: [c] });
      expect((await refus(forcer(t, c.id, d.id))).message).toBe(message);
    }

    const enCourse = livreur();
    const c1 = course();
    const t1 = monter({
      livreurs: [enCourse],
      courses: [c1, course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: enCourse.id })],
    });
    expect((await refus(forcer(t1, c1.id, enCourse.id))).message).toBe('Ce livreur a déjà une course en cours.');

    const sollicite = livreur();
    const c2 = course();
    const t2 = monter({
      livreurs: [sollicite],
      courses: [c2, autre],
      offres: [offre({ course_id: autre.id, deliverer_id: sollicite.id, expires_at: apres(60) })],
    });
    expect((await refus(forcer(t2, c2.id, sollicite.id))).message).toBe(
      'Ce livreur a déjà une offre en attente de réponse.',
    );
  });

  it('course qui ne cherche plus de livreur (acceptée, confiée à Turbo) : 409', async () => {
    const d = livreur();
    for (const c of [course({ statut: CourseStatut.ACCEPTED }), course({ turbo_escalated_at: avant(60) })]) {
      const t = monter({ livreurs: [d], courses: [c] });
      expect(await refus(forcer(t, c.id, d.id))).toEqual({
        classe: ConflictException,
        message: 'Cette course ne cherche plus de livreur.',
      });
      expect(t.journal[0]).toMatchObject({ type: 'AFFECTATION_FORCEE_REFUSEE', motif: 'COURSE_PLUS_EN_RECHERCHE' });
    }
  });

  it('livreur disponible : offre créée sous le verrou du livreur ; l’offre d’un autre livreur sur la course est close', async () => {
    const choisi = livreur();
    const autre = livreur();
    const c = course({ offer_expires_at: apres(30) });
    const offreAutre = offre({ course_id: c.id, deliverer_id: autre.id, expires_at: apres(30) });
    const t = monter({ livreurs: [choisi, autre], courses: [c], offres: [offreAutre] });

    expect(await forcer(t, c.id, choisi.id)).toEqual({
      success: true,
      message: 'Offre envoyée au livreur.',
      appli_connectee: true,
    });

    expect(offreAutre.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.fermetures()).toEqual([{ course_id: c.id, deliverer_id: autre.id, motif: 'AFFECTATION_FORCEE' }]);
    expect(t.relances()).toEqual([]);
    const nouvelle = t.offres.find((o) => o.deliverer_id === choisi.id);
    expect(nouvelle).toMatchObject({ status: CourseOfferStatus.PENDING, expires_at: apres(120) });
    expect(t.verrous).toEqual([[CLASSE_VERROU_OFFRE_LIVREUR, choisi.id]]);
    expect(t.courseEvent.offerNew).toHaveBeenCalledWith(
      expect.objectContaining({ deliverer_id: choisi.id, renvoi: false }),
    );
  });

  it('offre déjà en attente pour CETTE course : la notification est renvoyée, pas de seconde offre', async () => {
    const d = livreur();
    const c = course({ offer_expires_at: apres(40) });
    const t = monter({
      livreurs: [d],
      courses: [c],
      offres: [offre({ course_id: c.id, deliverer_id: d.id, expires_at: apres(40) })],
    });

    expect(await forcer(t, c.id, d.id)).toEqual({
      success: true,
      message: 'Offre renvoyée au livreur.',
      appli_connectee: true,
    });
    expect(t.offres).toHaveLength(1);
    expect(t.courseEvent.offerNew).toHaveBeenCalledWith(
      expect.objectContaining({ deliverer_id: d.id, renvoi: true, expires_at: apres(40) }),
    );
  });

  it('appli du livreur sans socket : l’offre part quand même, l’admin sait qu’elle n’arrivera que par notification', async () => {
    const d = livreur();
    const c = course();
    const t = monter({ livreurs: [d], courses: [c] });
    t.presence.livreurConnecte.mockResolvedValue(false);

    expect(await forcer(t, c.id, d.id)).toEqual({
      success: true,
      message:
        "Offre envoyée par notification seulement : l'appli du livreur n'est pas connectée en temps réel. " +
        "Demandez-lui de rouvrir l'appli.",
      appli_connectee: false,
    });
    expect(t.presence.livreurConnecte).toHaveBeenCalledWith(d.id);
    expect(t.offres.filter((o) => o.deliverer_id === d.id)).toHaveLength(1);
    expect(t.push.notifyNewCourseOffer).toHaveBeenCalledWith(expect.objectContaining({ delivererId: d.id }));
  });

  it('présence inconnue (Redis trop lent) : message habituel, `appli_connectee` à null', async () => {
    const d = livreur();
    const c = course();
    const t = monter({ livreurs: [d], courses: [c] });
    t.presence.livreurConnecte.mockResolvedValue(null);

    expect(await forcer(t, c.id, d.id)).toEqual({
      success: true,
      message: 'Offre envoyée au livreur.',
      appli_connectee: null,
    });
  });
});

// ============================================================
// UNE SEULE OFFRE EN ATTENTE PAR LIVREUR
// ============================================================

describe('jamais deux offres en attente pour un livreur (offerToDeliverer)', () => {
  it('le livreur a déjà une offre ailleurs : pas de seconde offre, contrôle fait sous le verrou du livreur', async () => {
    const d = livreur();
    const c1 = course();
    const c2 = course();
    const t = monter({
      livreurs: [d],
      courses: [c1, c2],
      offres: [offre({ course_id: c1.id, deliverer_id: d.id, expires_at: apres(60) })],
    });

    expect(await t.serviceOffres.offerToDeliverer(c2.id, d.id)).toBe(false);
    expect(t.offres).toHaveLength(1);
    expect(t.verrous).toEqual([[CLASSE_VERROU_OFFRE_LIVREUR, d.id]]);
    expect(t.courseEvent.offerNew).not.toHaveBeenCalled();
    expect(t.push.notifyNewCourseOffer).not.toHaveBeenCalled();
  });

  it('livreur passé en pause, en pause automatique, hors service ou en course entre la sélection et l’offre : rien', async () => {
    const cas = [
      livreur({ pause_until: apres(600) }),
      livreur({ auto_pause_until: apres(300) }),
      livreur({ last_available_at: null }),
    ];
    for (const d of cas) {
      const c = course();
      const t = monter({ livreurs: [d], courses: [c] });
      expect(await t.serviceOffres.offerToDeliverer(c.id, d.id)).toBe(false);
      expect(t.offres).toHaveLength(0);
      expect(t.push.notifyNewCourseOffer).not.toHaveBeenCalled();
    }
    const d = livreur();
    const enCours = course({ statut: CourseStatut.ACCEPTED, deliverer_id: d.id });
    const c = course();
    const t = monter({ livreurs: [d], courses: [enCours, c] });
    expect(await t.serviceOffres.offerToDeliverer(c.id, d.id)).toBe(false);
    expect(t.offres).toHaveLength(0);
  });

  it('la clôture des offres d’un livreur lit sous le même verrou que la création d’une offre', async () => {
    const d = livreur();
    const c = course();
    const t = monter({
      livreurs: [d],
      courses: [c],
      offres: [offre({ course_id: c.id, deliverer_id: d.id, expires_at: apres(60) })],
    });
    const cloture = new OffresClotureService(t.prisma, { emit: jest.fn() } as never, new DispatchJournalService(t.prisma));

    await cloture.clorePourLivreur(d.id, 'LIVREUR_EN_PAUSE', { relancerRecherche: false });

    expect(t.verrous).toEqual([[CLASSE_VERROU_OFFRE_LIVREUR, d.id]]);
    expect(t.offres[0].status).toBe(CourseOfferStatus.CANCELLED);
  });

  it('course acceptée, annulée ou confiée à Turbo entre la sélection et l’offre : rien', async () => {
    const d = livreur();
    for (const c of [course({ statut: CourseStatut.ACCEPTED }), course({ turbo_escalated_at: avant(5) })]) {
      const t = monter({ livreurs: [d], courses: [c] });
      expect(await t.serviceOffres.offerToDeliverer(c.id, d.id)).toBe(false);
      expect(t.offres).toHaveLength(0);
    }
  });

  it('course confiée à Turbo : offerNextDeliverer ne cherche plus de livreur interne', async () => {
    const d = livreur();
    const c = course({ turbo_escalated_at: avant(5) });
    const t = monter({ livreurs: [d], courses: [c] });

    await t.serviceOffres.offerNextDeliverer(c.id);

    expect(t.scoring.pickBestCandidate).not.toHaveBeenCalled();
    expect(t.offres).toHaveLength(0);
  });
});

// ============================================================
// RELANCES À 30 ET 60 S
// ============================================================

describe('relances de l’offre (30 et 60 s)', () => {
  it('livreur disponible : relance envoyée une fois par palier', async () => {
    const d = livreur();
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: d.id, offered_at: avant(35), expires_at: apres(85) });
    const t = monter({ livreurs: [d], courses: [c], offres: [o] });

    expect(await t.serviceOffres.remindPendingOffers()).toBe(1);
    expect(await t.serviceOffres.remindPendingOffers()).toBe(0);
    expect(o.reminders_sent).toBe(1);
    expect(t.push.notifyCourseOfferReminder).toHaveBeenCalledTimes(1);
  });

  it('livreur passé en pause sans que son offre soit close : offre close, pas de relance, recherche relancée', async () => {
    const d = livreur({ pause_until: FIN_PAUSE_INDEFINIE, last_available_at: null });
    const c = course({ offer_expires_at: apres(85) });
    const o = offre({ course_id: c.id, deliverer_id: d.id, offered_at: avant(35), expires_at: apres(85) });
    const t = monter({ livreurs: [d], courses: [c], offres: [o] });

    expect(await t.serviceOffres.remindPendingOffers()).toBe(0);
    expect(t.push.notifyCourseOfferReminder).not.toHaveBeenCalled();
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(c.offer_expires_at).toBeNull();
    expect(t.fermetures()).toEqual([{ course_id: c.id, deliverer_id: d.id, motif: 'LIVREUR_INDISPONIBLE' }]);
    expect(t.relances()).toEqual([c.id]);
    expect(t.journal[0]).toMatchObject({
      type: 'OFFRE_CLOSE',
      motif: 'LIVREUR_INDISPONIBLE',
      details: expect.objectContaining({ motif_livreur: 'EN_PAUSE' }),
    });
    // Aucune pénalité : ni refus compté, ni sanction.
    expect(c.refusal_count).toBe(0);
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
  });

  it('course confiée à Turbo : offre close, la recherche interne n’est pas relancée', async () => {
    const d = livreur();
    const c = course({ turbo_escalated_at: avant(5) });
    const o = offre({ course_id: c.id, deliverer_id: d.id, offered_at: avant(65), expires_at: apres(55), reminders_sent: 1 });
    const t = monter({ livreurs: [d], courses: [c], offres: [o] });

    await t.serviceOffres.remindPendingOffers();

    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.push.notifyCourseOfferReminder).not.toHaveBeenCalled();
    expect(t.relances()).toEqual([]);
  });
});

// ============================================================
// EXPIRATION
// ============================================================

describe('expiration des offres', () => {
  it('offre ignorée, course en recherche : pénalité, refus compté, livreur suivant', async () => {
    const absent = livreur({ last_available_at: avant(3600) });
    const suivant = livreur({ last_available_at: avant(60) });
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: absent.id, expires_at: avant(1) });
    const t = monter({ livreurs: [absent, suivant], courses: [c], offres: [o] });

    expect(await t.serviceOffres.expirePendingOffers()).toBe(1);

    expect(o.status).toBe(CourseOfferStatus.EXPIRED);
    expect(t.queue.onOfferExpired).toHaveBeenCalledWith(absent.id);
    expect(c.refusal_count).toBe(1);
    expect(t.courseEvent.offerExpired).toHaveBeenCalledWith({
      course_id: c.id,
      deliverer_id: absent.id,
      motif: 'EXPIREE',
      penalite: true,
    });
    // Le livreur suivant reçoit l'offre ; l'absent est exclu de cette course.
    expect(t.offres.find((x) => x.status === CourseOfferStatus.PENDING)?.deliverer_id).toBe(suivant.id);
  });

  it('course plus en recherche (acceptée par un autre, fusionnée) : aucune pénalité, rien à relancer', async () => {
    const d = livreur();
    const c = course({ statut: CourseStatut.CANCELLED });
    const o = offre({ course_id: c.id, deliverer_id: d.id, expires_at: avant(1) });
    const t = monter({ livreurs: [d], courses: [c], offres: [o] });

    await t.serviceOffres.expirePendingOffers();

    expect(o.status).toBe(CourseOfferStatus.EXPIRED);
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
    expect(c.refusal_count).toBe(0);
    expect(t.scoring.pickBestCandidate).not.toHaveBeenCalled();
    expect(t.courseEvent.offerExpired).toHaveBeenCalledWith({
      course_id: c.id,
      deliverer_id: d.id,
      motif: 'EXPIREE',
      penalite: false,
      sans_penalite: 'COURSE_PLUS_EN_RECHERCHE',
    });
  });

  it('livreur passé en pause entre-temps : aucune pénalité, la course part au livreur suivant', async () => {
    const enPause = livreur({ pause_until: FIN_PAUSE_INDEFINIE, last_available_at: null });
    const suivant = livreur();
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: enPause.id, expires_at: avant(1) });
    const t = monter({ livreurs: [enPause, suivant], courses: [c], offres: [o] });

    await t.serviceOffres.expirePendingOffers();

    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
    expect(c.refusal_count).toBe(0);
    expect(t.offres.find((x) => x.status === CourseOfferStatus.PENDING)?.deliverer_id).toBe(suivant.id);
  });

  it('deux serveurs traitent la même expiration : une seule pénalité, un seul refus', async () => {
    const d = livreur();
    const c = course();
    const t = monter({
      livreurs: [d],
      courses: [c],
      offres: [offre({ course_id: c.id, deliverer_id: d.id, expires_at: avant(1) })],
    });
    const second = t.nouveauServiceOffres();

    const [a, b] = await Promise.all([t.serviceOffres.expirePendingOffers(), second.expirePendingOffers()]);

    expect(a + b).toBe(1);
    expect(t.queue.onOfferExpired).toHaveBeenCalledTimes(1);
    expect(c.refusal_count).toBe(1);
    expect(t.courseEvent.offerExpired).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// REFUS
// ============================================================

describe('refus d’une offre (POST /courses/deliverer/:id/refuse)', () => {
  it('offre en attente : refusée, une pénalité, un refus compté, livreur suivant', async () => {
    const d = livreur({ last_available_at: avant(3600) });
    const suivant = livreur({ last_available_at: avant(60) });
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: d.id, expires_at: apres(60) });
    const t = monter({ livreurs: [d, suivant], courses: [c], offres: [o] });

    await t.actions.refuseOffer(c.id, d.id, { reason: 'trop loin' } as never);

    expect(o.status).toBe(CourseOfferStatus.REFUSED);
    expect(t.queue.onRefuse).toHaveBeenCalledTimes(1);
    expect(c.refusal_count).toBe(1);
    expect(t.offres.find((x) => x.status === CourseOfferStatus.PENDING)?.deliverer_id).toBe(suivant.id);
  });

  it('l’offre expire entre la lecture et l’écriture du refus : une seule pénalité, pas deux', async () => {
    // Relecture adverse : le refus écrasait sans condition l'offre déjà
    // expirée par la tâche de 10 s ; le livreur payait l'expiration ET le refus.
    const d = livreur();
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: d.id, expires_at: avant(1) });
    const t = monter({ livreurs: [d], courses: [c], offres: [o] });
    const lire = t.prisma.courseOfferAttempt.findFirst.getMockImplementation();
    t.prisma.courseOfferAttempt.findFirst.mockImplementationOnce(async (args: any) => {
      const lue = await lire(args);
      await t.serviceOffres.expirePendingOffers(); // la tâche passe à cet instant
      return lue;
    });

    expect(await refus(t.actions.refuseOffer(c.id, d.id, { reason: 'trop loin' } as never))).toEqual({
      classe: BadRequestException,
      message: "Cette offre n'est plus en attente.",
    });
    expect(o.status).toBe(CourseOfferStatus.EXPIRED);
    expect(t.queue.onOfferExpired).toHaveBeenCalledTimes(1);
    expect(t.queue.onRefuse).not.toHaveBeenCalled();
    expect(c.refusal_count).toBe(1);
  });

  it('offre close par le serveur (livreur en pause ailleurs) : le refus ne la transforme pas en pénalité', async () => {
    const d = livreur();
    const c = course();
    const o = offre({ course_id: c.id, deliverer_id: d.id, expires_at: apres(60) });
    const t = monter({ livreurs: [d], courses: [c], offres: [o] });
    const lire = t.prisma.courseOfferAttempt.findFirst.getMockImplementation();
    t.prisma.courseOfferAttempt.findFirst.mockImplementationOnce(async (args: any) => {
      const lue = await lire(args);
      o.status = CourseOfferStatus.CANCELLED; // pause posée depuis un autre téléphone
      return lue;
    });

    await expect(t.actions.refuseOffer(c.id, d.id, {} as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.queue.onRefuse).not.toHaveBeenCalled();
    expect(c.refusal_count).toBe(0);
  });
});

// ============================================================
// BASCULE MANUELLE VERS TURBO
// ============================================================

describe('bascule manuelle vers Turbo (PATCH /courses/:id/turbo)', () => {
  it('l’offre en attente est close AVANT l’envoi à Turbo, sans relancer la recherche interne', async () => {
    const d = livreur();
    const { course: c, commandes, livraisons } = courseAvecCommandes({ offer_expires_at: apres(60) }, [OrderStatus.READY]);
    const o = offre({ course_id: c.id, deliverer_id: d.id, expires_at: apres(60) });
    const t = monter({ livreurs: [d], courses: [c], commandes, livraisons, offres: [o] });

    expect(await t.serviceOffres.basculerVersTurbo(c.id)).toEqual({ ok: true, message: `Course ${c.reference} confiée à Turbo.` });

    expect(t.statutsAuMomentDeLEnvoi).toEqual([CourseOfferStatus.CANCELLED]);
    expect(t.fermetures()).toEqual([{ course_id: c.id, deliverer_id: d.id, motif: 'COURSE_CONFIEE_A_TURBO' }]);
    expect(t.relances()).toEqual([]);
    expect(c.turbo_escalated_at).toEqual(MAINTENANT);
  });

  it('Turbo refuse : la recherche interne reprend, et le livreur dont l’offre a été close reste candidat', async () => {
    const d = livreur();
    const { course: c, commandes, livraisons } = courseAvecCommandes({}, [OrderStatus.READY]);
    const o = offre({ course_id: c.id, deliverer_id: d.id, expires_at: apres(60) });
    const t = monter(
      { livreurs: [d], courses: [c], commandes, livraisons, offres: [o] },
      { turbo: { sentOrderIds: [] } },
    );

    expect((await t.serviceOffres.basculerVersTurbo(c.id)).ok).toBe(false);

    expect(c.turbo_escalated_at).toBeNull();
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    const nouvelle = t.offres.find((x) => x.status === CourseOfferStatus.PENDING);
    expect(nouvelle?.deliverer_id).toBe(d.id);
  });
});
