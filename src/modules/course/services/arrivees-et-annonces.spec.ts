/**
 * ARRIVÉES DÉDUITES DES POSITIONS ET ANNONCES AU LIVREUR ET À L'ÉCRAN
 * OPÉRATIONS (demandes du 23/10 : appli livreur simple et écran Opérations).
 *
 *  - arrivée au restaurant (200 m) et chez le client (100 m) déclarées par le
 *    serveur d'après les positions reçues, appli en arrière-plan comprise ;
 *  - routes du livreur sans erreur quand l'arrivée est déjà enregistrée ;
 *  - `course:statut:changed` au livreur quand une de ses livraisons change ;
 *  - validation du retrait qui ferme la fenêtre (ancienne appli, v1) : le
 *    départ est annoncé APRÈS la fermeture (raison DEPART) ;
 *  - fusion : les courses absorbées nommées dans l'événement.
 *
 * Les VRAIS services sur la base simulée (banc-planificateur.simulee-spec.ts).
 */
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { CourseChannels } from '../enums/course-channels';
import { estArrive, positionAssezPrecise, RAYON_ARRIVEE_CLIENT_M } from '../helpers/arrivee-auto.rules';
import { sortiDuRestaurant } from '../helpers/depart.rules';
import { LivraisonVersLivreurListener } from '../listeners/livraison-vers-livreur.listener';
import { ArriveeAutoService } from './arrivee-auto.service';
import { course, livraison, livreur, offre, RESTO } from './base-dispatch.simulee-spec';
import { A, apres, AU_COMPTOIR, avant, B, KM_LNG, LOIN, MAINTENANT, monter, prete, RESTAURANT } from './banc-planificateur.simulee-spec';
import { DispatchJournalService } from './dispatch-journal.service';

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Point à `metres` à l'est du restaurant (axe des clients A et B). */
const aLEst = (metres: number) => ({ lat: RESTAURANT.lat, lng: RESTAURANT.lng + (metres / 1000) * KM_LNG });

function arrivees(t: ReturnType<typeof monter>) {
  return new ArriveeAutoService(t.base.prisma, t.courseEvent, new DispatchJournalService(t.base.prisma), t.settings);
}

describe('règles pures', () => {
  it('arrivée : coordonnées valides, assez précise, dans le rayon', () => {
    const client = aLEst(2000);
    expect(estArrive({ position: aLEst(1950), cible: client, rayonM: RAYON_ARRIVEE_CLIENT_M })).toBe(true);
    expect(estArrive({ position: aLEst(1850), cible: client, rayonM: RAYON_ARRIVEE_CLIENT_M })).toBe(false);
    // Adresse vide (0,0), position absente, précision trop faible : jamais.
    expect(estArrive({ position: { lat: 0, lng: 0 }, cible: { lat: 0, lng: 0 }, rayonM: 100 })).toBe(false);
    expect(estArrive({ position: null, cible: client, rayonM: 100 })).toBe(false);
    expect(estArrive({ position: aLEst(1990), precisionM: 120, cible: client, rayonM: 100 })).toBe(false);
    expect(estArrive({ position: aLEst(1990), precisionM: 25, cible: client, rayonM: 100 })).toBe(true);
    expect(positionAssezPrecise(null)).toBe(true);
    expect(positionAssezPrecise(80)).toBe(true);
    expect(positionAssezPrecise(81)).toBe(false);
  });

  it('départ : une position imprécise (plus de 80 m) ne décide rien', () => {
    const base = {
      position: aLEst(400),
      position_at: MAINTENANT,
      restaurant: RESTAURANT,
      picked_up_at: avant(30),
      departRayonM: 250,
    };
    expect(sortiDuRestaurant(base)).toBe(true);
    expect(sortiDuRestaurant({ ...base, precision_m: 150 })).toBe(false);
    expect(sortiDuRestaurant({ ...base, precision_m: 20 })).toBe(true);
  });
});

describe('arrivée au restaurant déduite de la position', () => {
  function enRoute() {
    const d1 = livreur({ ...LOIN, last_available_at: null, protocole_appli: 3 });
    const a = prete();
    const k = course({ statut: CourseStatut.ACCEPTED, deliverer_id: d1.id, assigned_at: avant(300), created_at: avant(400) });
    const t = monter({ commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [d1] });
    return { d1, a, k, t };
  }

  it('à 150 m du restaurant : course au restaurant, annoncée (livreur, caisse, siège), journalisée', async () => {
    const { d1, k, t } = enRoute();
    const service = arrivees(t);

    expect(await service.surPosition({ delivererId: d1.id, ...aLEst(600) })).toBeNull();
    expect(k.statut).toBe(CourseStatut.ACCEPTED);

    expect(await service.surPosition({ delivererId: d1.id, ...aLEst(150), accuracyM: 15 })).toBe('RESTAURANT');
    expect(k.statut).toBe(CourseStatut.AT_RESTAURANT);
    expect(k.at_restaurant_at).toEqual(MAINTENANT);
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED)).toContainEqual(
      expect.objectContaining({ previous_statut: CourseStatut.ACCEPTED, new_statut: CourseStatut.AT_RESTAURANT }),
    );
    expect(t.journalDe('ARRIVEE_RESTAURANT_AUTO')).toHaveLength(1);

    // La route de l'appli, appelée juste après : réponse normale, rien ne change.
    const reponse = await t.actions.markAtRestaurant(k.id, d1.id);
    expect(reponse).toMatchObject({ id: k.id, statut: CourseStatut.AT_RESTAURANT });
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED)).toHaveLength(1);
  });

  it('position imprécise ou restaurant sans coordonnées : rien', async () => {
    const { d1, k, t } = enRoute();
    expect(await arrivees(t).surPosition({ delivererId: d1.id, ...aLEst(50), accuracyM: 300 })).toBeNull();
    expect(k.statut).toBe(CourseStatut.ACCEPTED);
  });

  it('restaurant repassé en v1 : aucune arrivée déduite des positions, comme avant (relecture)', async () => {
    const d1 = livreur({ ...LOIN, last_available_at: null, protocole_appli: 3 });
    const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(600) });
    const k = course({ statut: CourseStatut.ACCEPTED, deliverer_id: d1.id, assigned_at: avant(300), created_at: avant(400) });
    const la = livraison({ course_id: k.id, order_id: a.id });
    const t = monter({ commandes: [a], courses: [k], livraisons: [la], livreurs: [d1] }, { reglages: { 'course.planificateur': 'v1' } });

    expect(await arrivees(t).surPosition({ delivererId: d1.id, ...aLEst(50), accuracyM: 10 })).toBeNull();
    expect(k.statut).toBe(CourseStatut.ACCEPTED);

    // En livraison, à 50 m du client : rien non plus.
    k.statut = CourseStatut.IN_DELIVERY;
    la.statut = DeliveryStatut.IN_ROUTE;
    expect(await arrivees(t).surPosition({ delivererId: d1.id, ...aLEst(1950), accuracyM: 10 })).toBeNull();
    expect(la.statut).toBe(DeliveryStatut.IN_ROUTE);
    expect(t.journalDe('ARRIVEE_RESTAURANT_AUTO')).toHaveLength(0);
    expect(t.journalDe('ARRIVEE_CLIENT_AUTO')).toHaveLength(0);
  });

  it('l’appli déclare l’arrivée au même instant : un seul passage, pas d’erreur', async () => {
    const { d1, k, t } = enRoute();
    await t.actions.markAtRestaurant(k.id, d1.id);
    expect(await arrivees(t).surPosition({ delivererId: d1.id, ...aLEst(20) })).toBeNull();
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED)).toHaveLength(1);
  });
});

describe('arrivée chez le client déduite de la position', () => {
  function enLivraison() {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 2 });
    const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(600) });
    const b = prete({ address: B, status: OrderStatus.PICKED_UP, picked_up_at: avant(600) });
    const k = course({
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: d1.id,
      assigned_at: avant(1200),
      picked_up_at: avant(600),
      parti_at: avant(590),
    });
    const la = livraison({ course_id: k.id, order_id: a.id, sequence_order: 1, statut: DeliveryStatut.IN_ROUTE, in_route_at: avant(590) });
    const lb = livraison({ course_id: k.id, order_id: b.id, sequence_order: 2 });
    const t = monter({ commandes: [a, b], courses: [k], livraisons: [la, lb], livreurs: [d1] });
    return { d1, a, b, k, la, lb, t };
  }

  it('à 60 m du client EN ROUTE : livraison arrivée, événement, livreur prévenu par course:statut:changed', async () => {
    const { d1, k, la, lb, t } = enLivraison();
    const emisLivreur: { salle: string; canal: string; charge: any }[] = [];
    const gateway = { emitToDeliverer: (id: string, canal: string, charge: unknown) => emisLivreur.push({ salle: id, canal, charge }) };
    const ecouteur = new LivraisonVersLivreurListener(t.base.prisma, gateway as never);

    // Près de B (pas encore en route) : rien.
    expect(await arrivees(t).surPosition({ delivererId: d1.id, ...aLEst(3990) })).toBeNull();
    expect(lb.statut).toBe(DeliveryStatut.PENDING);

    expect(await arrivees(t).surPosition({ delivererId: d1.id, ...aLEst(1940), accuracyM: 10 })).toBe('CLIENT');
    expect(la.statut).toBe(DeliveryStatut.ARRIVED);
    expect(la.arrived_at).toEqual(MAINTENANT);
    const [evenement] = t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED);
    expect(evenement).toMatchObject({ course_id: k.id, previous_statut: DeliveryStatut.IN_ROUTE, new_statut: DeliveryStatut.ARRIVED });
    expect(t.journalDe('ARRIVEE_CLIENT_AUTO')).toHaveLength(1);

    await ecouteur.onLivraison(evenement);
    expect(emisLivreur).toEqual([
      expect.objectContaining({
        salle: d1.id,
        canal: CourseChannels.COURSE_STATUT_CHANGED,
        charge: expect.objectContaining({ reason: 'LIVRAISON_ARRIVED', course: expect.objectContaining({ id: k.id }) }),
      }),
    ]);

    // La route « Arrivé » de l'appli, juste après : réponse normale, pas d'erreur.
    const reponse = await t.actionsLivraison.markArrived(la.id, d1.id);
    expect(reponse).toMatchObject({ id: la.id, statut: DeliveryStatut.ARRIVED });
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(1);

    // Deuxième position au même endroit : rien de plus.
    expect(await arrivees(t).surPosition({ delivererId: d1.id, ...aLEst(1950) })).toBeNull();
  });

  it('position imprécise près du client : rien', async () => {
    const { d1, la, t } = enLivraison();
    expect(await arrivees(t).surPosition({ delivererId: d1.id, ...aLEst(1990), accuracyM: 200 })).toBeNull();
    expect(la.statut).toBe(DeliveryStatut.IN_ROUTE);
  });
});

describe('validation du retrait qui ferme la fenêtre : le livreur reçoit la course partie', () => {
  it('code saisi, ancienne appli (protocole 2) : un seul événement, course relue déjà partie', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 2 });
    const a = prete();
    const k = course({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: d1.id, assigned_at: avant(400), at_restaurant_at: avant(100) });
    const t = monter({ commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [d1] });
    jest.spyOn(t.actions, 'estimerDureeTournee').mockResolvedValue(undefined);

    await t.actions.validatePickupByCashier({ pickup_code: k.pickup_code, restaurant_id: RESTO } as never, undefined);

    const evenements = t.emisSur(CourseChannels.COURSE_STATUT_CHANGED);
    expect(evenements).toHaveLength(1);
    expect(evenements[0]).toMatchObject({
      new_statut: CourseStatut.IN_DELIVERY,
      course: expect.objectContaining({ id: k.id, parti_at: MAINTENANT }),
    });
    expect(k.parti_at).toEqual(MAINTENANT);
  });

  it('bouton de la caisse en v1, nouvelle appli : DEPART annoncé après la validation, première livraison démarrée', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 3 });
    const a = prete();
    const k = course({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: d1.id, assigned_at: avant(400), at_restaurant_at: avant(100) });
    const la = livraison({ course_id: k.id, order_id: a.id });
    const t = monter({ commandes: [a], courses: [k], livraisons: [la], livreurs: [d1] }, { reglages: { 'course.planificateur': 'v1' } });
    jest.spyOn(t.actions, 'estimerDureeTournee').mockResolvedValue(undefined);

    a.status = OrderStatus.PICKED_UP;
    a.picked_up_at = new Date();
    await t.remiseCaisse.onStatutCommande({ order: { ...a, type: 'DELIVERY' } } as never);

    expect(k.parti_at).toEqual(MAINTENANT);
    expect(la.statut).toBe(DeliveryStatut.IN_ROUTE);
    const depart = t.emisSur(CourseChannels.COURSE_STATUT_CHANGED).find((e) => e.reason === 'DEPART');
    expect(depart?.course.deliveries[0]).toMatchObject({ statut: DeliveryStatut.IN_ROUTE });
  });
});

describe('fusion : les courses absorbées nommées dans l’événement', () => {
  it('course:statut:changed COURSES_FUSIONNEES porte fusion.absorbees', async () => {
    const a = prete({ ready_at: avant(120) });
    const b = prete({ address: B, ready_at: avant(60) });
    const k1 = course({ created_at: avant(110) });
    const k2 = course({ created_at: avant(50) });
    const enRoute = livreur({ ...LOIN, last_available_at: avant(3000) });
    const comptoir = livreur({ ...AU_COMPTOIR, last_available_at: avant(600) });
    const t = monter({
      commandes: [a, b],
      courses: [k1, k2],
      livraisons: [
        livraison({ course_id: k1.id, order_id: a.id, sequence_order: 1 }),
        livraison({ course_id: k2.id, order_id: b.id, sequence_order: 1 }),
      ],
      livreurs: [enRoute, comptoir],
      offres: [offre({ course_id: k1.id, deliverer_id: enRoute.id, offered_at: avant(100), expires_at: apres(20) })],
    });

    await t.passer();

    expect(k1.statut).toBe(CourseStatut.CANCELLED);
    const fusion = t.emisSur(CourseChannels.COURSE_STATUT_CHANGED).find((e) => e.reason === 'COURSES_FUSIONNEES');
    expect(fusion).toMatchObject({ course: expect.objectContaining({ id: k2.id }), fusion: { absorbees: [k1.reference] } });
    // Les autres raisons ne portent pas de fusion.
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED).filter((e) => e.fusion)).toHaveLength(1);
    expect(A).toBeTruthy();
  });
});
