/**
 * BANC DU PLANIFICATEUR v2 côté service, partagé par les tests : les VRAIS
 * services (instantané, règle, application, offres, gardes, clôture,
 * journal, départ, retrait par code, démarrage des livraisons, bouton de la
 * caisse, écouteur des positions) sur la base simulée de
 * `base-dispatch.simulee-spec.ts`. Google coupé (`course.direction_google`
 * = 0) : la règle de direction passe par son repli sans carte, comme sur le
 * banc local. Aucun appel sortant (Turbo, notifications, cartes : simulés).
 *
 * Restaurant Zone 4 (5.286, -3.9737). Clients sur l'axe est : A à 2 km,
 * B à 4 km (même direction) ; O à 2 km à l'ouest (sens opposé).
 *
 * Fichier de test seulement (nom en « -spec.ts » : exclu de la construction,
 * pas lancé comme une suite).
 */
import { CourseStatut, OrderStatus } from '@prisma/client';

import { appliLivreurSimulee, busSimule } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { CourseEvent } from '../events/course.event';
import { CourseHelper } from '../helpers/course.helper';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { PlanificateurListener } from '../listeners/planificateur.listener';
import { RemiseCaisseListener } from '../listeners/remise-caisse.listener';
import { AnnulationAutoService } from './annulation-auto.service';
import { ApplicationPlanService } from './application-plan.service';
import { commande, DonneesDispatch, monterBaseDispatch, RESTO } from './base-dispatch.simulee-spec';
import { CourseActionService } from './course-action.service';
import { CourseEnLivraisonService } from './course-en-livraison.service';
import { CourseOfferService } from './course-offer.service';
import { CoursePlanificateurService } from './course-planificateur.service';
import { CourseQueryService } from './course-query.service';
import { DeliveryActionService } from './delivery-action.service';
import { DepartCourseService } from './depart-course.service';
import { DirectionService } from './direction.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { EstimationPreparationService } from './estimation-preparation.service';
import { GardeOffresService } from './garde-offres.service';
import { InstantanePlanificationService } from './instantane-planification.service';
import { OffresClotureService } from './offres-cloture.service';

export const MAINTENANT = new Date('2026-10-22T15:30:00.000Z'); // hors pointe
export const avant = (s: number) => new Date(MAINTENANT.getTime() - s * 1000);
export const apres = (s: number) => new Date(MAINTENANT.getTime() + s * 1000);

export const RESTAURANT = { lat: 5.286, lng: -3.9737 };
export const KM_LNG = 1 / 110.8;
export const adresse = (lat: number, lng: number) => JSON.stringify({ title: 'Client', latitude: lat, longitude: lng });
export const A = adresse(5.286, RESTAURANT.lng + 2 * KM_LNG);
export const B = adresse(5.286, RESTAURANT.lng + 4 * KM_LNG);
export const O = adresse(5.286, RESTAURANT.lng - 2 * KM_LNG);
export const AU_COMPTOIR = { last_location: { lat: RESTAURANT.lat, lng: RESTAURANT.lng }, last_location_at: avant(60) };
export const LOIN = { last_location: { lat: 5.31, lng: -3.95 }, last_location_at: avant(60) };

/** Commande à livrer prête, flotte interne, promise dans 20 min. */
export const prete = (surcharge: Record<string, unknown> = {}) =>
  commande({ status: OrderStatus.READY, ready_at: avant(30), created_at: avant(15 * 60), updated_at: avant(30), address: A, ...surcharge });

export interface Options {
  reglages?: Record<string, string>;
  turbo?: { sentOrderIds: string[] };
  /** Appli des livreurs (24/10) : défaut, toutes actives (socket ouvert). */
  appli?: Parameters<typeof appliLivreurSimulee>[1];
}

export function monter(donnees: DonneesDispatch, options: Options = {}) {
  const base = monterBaseDispatch(donnees);
  const { bus, emis } = busSimule();
  const valeurs: Record<string, string> = { 'course.direction_google': '0', ...options.reglages };
  const settingsService = {
    getMany: jest.fn(async (cles: string[]) =>
      Object.fromEntries(cles.filter((c) => valeurs[c] !== undefined).map((c) => [c, valeurs[c]])),
    ),
  };
  const settings = new CourseSettingsHelper(settingsService as never);
  const journal = new DispatchJournalService(base.prisma);
  const cloture = new OffresClotureService(base.prisma, bus as never, journal);
  const appli = appliLivreurSimulee(base.prisma, options.appli);
  const garde = new GardeOffresService(base.prisma, cloture, journal, appli.service);
  const courseEvent = new CourseEvent(bus as never);
  const push = {
    notifyNewCourseOffer: jest.fn(),
    notifyCourseOfferReminder: jest.fn(),
    notifyCourseAssigned: jest.fn(),
    notifyCommandeAjoutee: jest.fn(),
    notifyCommandeRetiree: jest.fn(),
    notifyCourseAttente: jest.fn(),
    notifyCourseToutPret: jest.fn(),
    notifyCommandeRemise: jest.fn(),
    notifyPickupValidated: jest.fn(),
    notifySacOublie: jest.fn(),
    notifyCourseCompleted: jest.fn(),
  };
  const queue = {
    onOfferExpired: jest.fn(async () => ({ autoPaused: false })),
    onAccept: jest.fn(async () => undefined),
    onRefuse: jest.fn(async () => ({ autoPaused: false })),
  };
  const scoring = { pickBestCandidate: jest.fn(async () => null) };
  const cloche = {
    sendCourseTurboFallbackBell: jest.fn(async () => undefined),
    sendTurboPickupSyncFailedBell: jest.fn(async () => undefined),
    sendCourseNoDelivererBell: jest.fn(async () => undefined),
    sendCommandePasRemiseBell: jest.fn(async () => undefined),
  };
  const turbo = {
    creerCourseGroupe: jest.fn(async () => options.turbo ?? { sentOrderIds: base.commandes.map((o) => o.id) }),
  };
  const helper = new CourseHelper();
  const offres = new CourseOfferService(
    base.prisma,
    courseEvent,
    helper,
    settings,
    scoring as never,
    queue as never,
    { load: jest.fn(async () => ({ scoringShadowMode: false })) } as never,
    push as never,
    cloche as never,
    turbo as never,
    garde,
    appli.service,
  );
  const cache = new Map<string, unknown>();
  const preparation = new EstimationPreparationService(
    base.prisma,
    { get: jest.fn(async (k: string) => cache.get(k)), set: jest.fn(async (k: string, v: unknown) => void cache.set(k, v)) } as never,
    journal,
  );
  const direction = new DirectionService({} as never, settingsService as never);
  const instantanes = new InstantanePlanificationService(
    base.prisma,
    direction,
    preparation,
    {} as never,
    { load: jest.fn(async () => ({ travelTimeRanking: false })) } as never,
    appli.service,
  );
  const regroupement = { tryGroupOrder: jest.fn(async () => ({ batchId: 'lot', flushed: false })) };
  const depart = new DepartCourseService(
    base.prisma,
    settings,
    courseEvent,
    push as never,
    journal,
    regroupement as never,
    cloche as never,
  );
  const application = new ApplicationPlanService(
    base.prisma,
    offres,
    helper,
    courseEvent,
    push as never,
    journal,
    cloture,
    regroupement as never,
    depart,
  );
  const nouveauPlanificateur = () => new CoursePlanificateurService(base.prisma, settings, instantanes, application, journal);
  const planificateur = nouveauPlanificateur();
  const requetes = new CourseQueryService(base.prisma, settings);
  const cartes = { getDirections: jest.fn(async () => null) };
  const actions = new CourseActionService(
    base.prisma,
    courseEvent,
    offres,
    queue as never,
    push as never,
    turbo as never,
    cartes as never,
    requetes,
    garde,
    depart,
  );
  // Démarrage des livraisons par le livreur (route PATCH .../deliveries/:id/start).
  const actionsLivraison = new DeliveryActionService(
    base.prisma,
    courseEvent,
    { onComplete: jest.fn(async () => undefined) } as never,
    push as never,
    {} as never,
    depart,
  );
  // Bouton de la caisse « Livreur a récupéré » et annulation automatique.
  const enLivraison = new CourseEnLivraisonService(base.prisma, courseEvent, push as never, actions, journal, depart);
  const remiseCaisse = new RemiseCaisseListener(enLivraison);
  const annulationAuto = new AnnulationAutoService(base.prisma, courseEvent, push as never, enLivraison, offres, journal);
  // Écouteur des événements (positions des livreurs comprises).
  const ecouteur = new PlanificateurListener(base.prisma, planificateur, settings, preparation, depart);
  const horloge = () => new Date();

  const emisSur = (canal: string) => emis.filter((e) => e.canal === canal).map((e) => e.charge);
  const journalDe = (type: string) => base.journal.filter((l) => l.type === type);
  const coursesOuvertes = () => base.courses.filter((c) => c.statut !== CourseStatut.CANCELLED);
  const livraisonsDe = (courseId: string) =>
    base.livraisons.filter((l) => l.course_id === courseId).sort((a, b) => a.sequence_order - b.sequence_order);

  return {
    base,
    bus,
    emis,
    emisSur,
    journalDe,
    coursesOuvertes,
    livraisonsDe,
    settings,
    valeurs,
    push,
    queue,
    scoring,
    turbo,
    cloche,
    offres,
    garde,
    cloture,
    instantanes,
    application,
    regroupement,
    planificateur,
    nouveauPlanificateur,
    depart,
    actions,
    cartes,
    actionsLivraison,
    enLivraison,
    remiseCaisse,
    annulationAuto,
    ecouteur,
    requetes,
    courseEvent,
    appli,
    passer: (p = planificateur) => p.planifierRestaurant(RESTO, 'TEST', horloge),
  };
}
