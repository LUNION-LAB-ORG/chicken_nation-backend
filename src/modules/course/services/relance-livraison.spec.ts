/**
 * « RELANCER LA LIVRAISON » d'une livraison annulée par le livreur (demande
 * du 28/10) : POST /courses/commandes/:orderId/relancer-livraison.
 *
 * Après « Annuler » du livreur (27/10), la livraison est en échec, la
 * commande toujours en livraison, le sac chez lui. Le siège a trouvé une
 * solution avec le client : la MÊME livraison (même code) revient au MÊME
 * livreur, sans passage au restaurant ni offre. En tournée : en fin de
 * tournée. Sans course : une course neuve, directement en livraison,
 * livraison démarrée. La commande n'est jamais touchée.
 *
 * Banc : les VRAIS services (« Annuler », « Sac rapporté », planificateur,
 * offres, clôture, journal, départ, suivi du client) sur la base simulée du
 * planificateur ; les sockets passent par les VRAIS services de diffusion sur
 * une passerelle notée.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CourseOfferStatus,
  CourseStatut,
  DelivererStatus,
  DeliveryFailureReason,
  DeliveryStatut,
  EntityStatus,
  OrderStatus,
  UserRole,
  UserType,
} from '@prisma/client';

import { OrderDepartureNotifierService } from 'src/common/services/order-departure-notifier.service';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { enrichirCommandesOperations } from 'src/modules/order/helpers/suivi-operations.rules';
import { OrderWebSocketService } from 'src/modules/order/websockets/order-websocket.service';

import { CourseAdminController } from '../controllers/course-admin.controller';
import { CourseDelivererController } from '../controllers/course-deliverer.controller';
import { CourseOperationsController } from '../controllers/course-operations.controller';
import { CourseChannels } from '../enums/course-channels';
import { DispatchEvenements } from '../enums/dispatch-evenements';
import { CourseHelper } from '../helpers/course.helper';
import {
  aDemarrerApresRelance,
  rangsApresRelance,
  refusLivreurRelance,
  relanceeEnDernier,
} from '../helpers/relance-livraison.rules';
import { MESSAGE_COMMANDE_CHANGEE } from '../helpers/sac-rapporte.rules';
import { CourseLue, construireTableau } from '../helpers/tableau-livraison.rules';
import { LivraisonVersLivreurListener } from '../listeners/livraison-vers-livreur.listener';
import { CourseWebSocketService } from '../websockets/course-websocket.service';
import { commande, course, livraison, livreur, offre, RESTO } from './base-dispatch.simulee-spec';
import { apres, AU_COMPTOIR, avant, B, MAINTENANT, monter as monterBanc, Options, prete } from './banc-planificateur.simulee-spec';
import { DeliveryActionService } from './delivery-action.service';
import { DeliveryTrackingService } from './delivery-tracking.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { RelanceLivraisonService } from './relance-livraison.service';
import { SacRapporteService } from './sac-rapporte.service';

const CLIENT_ABSENT = { reason: DeliveryFailureReason.CLIENT_ABSENT, note: 'Client absent' };

const CALL_CENTER = { id: 'u-cc', type: UserType.BACKOFFICE, role: UserRole.CALL_CENTER, restaurant_id: null };
const ADMIN = { id: 'u-admin', type: UserType.BACKOFFICE, role: UserRole.ADMIN, restaurant_id: null };
const CAISSIERE = { id: 'u-caisse', type: UserType.RESTAURANT, role: UserRole.CAISSIER, restaurant_id: RESTO };

/**
 * Course partie de deux arrêts, livreur Koffi : A en route (payée en ligne,
 * code 4821), B en attente (espèces, code 7733). `seulementA` : un seul client.
 */
function enTournee(o: { seulementA?: boolean; options?: Options; surchargeA?: Record<string, unknown>; surchargeB?: Record<string, unknown> } = {}) {
  const d1 = livreur({ ...AU_COMPTOIR, first_name: 'Koffi', last_name: 'Yao', last_available_at: null, protocole_appli: 4 });
  const d2 = livreur({ ...AU_COMPTOIR, first_name: 'Awa', last_available_at: avant(300), protocole_appli: 4 });
  const a = prete({
    status: OrderStatus.PICKED_UP,
    picked_up_at: avant(600),
    ready_at: avant(1200),
    paied: true,
    amount: 6000,
    recovery_code: '4821',
    customer_id: 'client-a',
    phone: '+2250700000001',
    fullname: 'Client A',
    batch_id: 'lot-ancien',
    ...o.surchargeA,
  });
  const b = prete({
    address: B,
    status: OrderStatus.PICKED_UP,
    picked_up_at: avant(600),
    paied: false,
    amount: 4000,
    recovery_code: '7733',
    customer_id: 'client-b',
    ...o.surchargeB,
  });
  const k = course({
    statut: CourseStatut.IN_DELIVERY,
    deliverer_id: d1.id,
    assigned_at: avant(1200),
    picked_up_at: avant(600),
    parti_at: avant(590),
    motif_depart: 'POSITION',
    total_delivery_fee: o.seulementA ? 1000 : 2000,
  });
  const la = livraison({
    course_id: k.id,
    order_id: a.id,
    sequence_order: 1,
    statut: DeliveryStatut.IN_ROUTE,
    in_route_at: avant(590),
    delivery_pin: '4821',
    reportee_at: null,
    customer_rating: null,
    customer_rating_note: null,
    customer_rated_at: null,
  });
  const lb = livraison({ course_id: k.id, order_id: b.id, sequence_order: 2, delivery_pin: '7733', reportee_at: null });
  const t = monterBanc(
    { commandes: o.seulementA ? [a] : [a, b], courses: [k], livraisons: o.seulementA ? [la] : [la, lb], livreurs: [d1, d2] },
    o.options,
  );

  // Fin de course : le livreur revient dans la file (DelivererQueueService.onComplete).
  const file = {
    onComplete: jest.fn(async (id: string) => {
      const d = t.base.livreurs.find((l) => l.id === id);
      if (d) d.last_available_at = new Date();
    }),
  };
  const cloche = { sendTurboPaymentPendingBell: jest.fn(async () => undefined) };
  const livraisons = new DeliveryActionService(
    t.base.prisma,
    t.courseEvent,
    file as never,
    t.push as never,
    cloche as never,
    t.depart,
    new DispatchJournalService(t.base.prisma),
  );
  // Passerelle des sockets : les VRAIS services de diffusion s'en servent.
  const passerelle = {
    emitToUser: jest.fn(),
    emitToBackoffice: jest.fn(),
    emitToRestaurant: jest.fn(),
    emitToDeliverer: jest.fn(),
    livreurConnecte: jest.fn(async (id: string) => {
      const ouverts = await t.appli.gateway.livreursConnectes([id]);
      return ouverts ? ouverts.has(id) : null;
    }),
  };
  const pushLivreur = { notifyLivraisonRelancee: jest.fn(), notifySacRendu: jest.fn() };
  const duree = { estimerDureeTournee: jest.fn(async () => undefined) };
  const ws = new CourseWebSocketService(passerelle as never);
  const service = new RelanceLivraisonService(
    t.base.prisma,
    new CourseHelper(),
    t.courseEvent,
    ws,
    pushLivreur as never,
    t.appli.service,
    t.cloture,
    passerelle as never,
    duree as never,
  );
  const admin = new CourseAdminController(
    t.requetes,
    t.actions,
    t.offres,
    t.garde,
    passerelle as never,
    t.settings,
    t.appli.service,
    service,
  );
  const sacs = new SacRapporteService(t.base.prisma, t.courseEvent, ws, new OrderWebSocketService(passerelle as never), pushLivreur as never);
  const operations = new CourseOperationsController(t.requetes, t.actions, sacs);
  const appliLivreur = new CourseDelivererController(t.actions, livraisons, t.requetes, {} as never, t.depart, sacs);

  /** Ce que fait la route : compte lu du jeton, identifiant de l'URL, corps vide. */
  const relancer = (orderId: string, user: Record<string, unknown> = CALL_CENTER) =>
    admin.relancerLivraisonCommande({ user } as never, orderId);
  /** « Annuler » du livreur (feuille « Problème »), route du 27/10. */
  const annuler = (deliveryId: string, corps: Record<string, unknown> = CLIENT_ABSENT) =>
    appliLivreur.annulerLivraison(d1 as never, deliveryId, corps as never);
  /** « Sac rapporté » de la caisse. */
  const sacRapporte = (orderId: string) => operations.sacRapporte({ user: CAISSIERE } as never, orderId);
  const socketsVers = (methode: 'emitToUser' | 'emitToBackoffice' | 'emitToRestaurant' | 'emitToDeliverer', canal: string) =>
    passerelle[methode].mock.calls.filter((c: unknown[]) => c.includes(canal));
  /** Courses actives du livreur (acceptée, au restaurant, en livraison). */
  const coursesActives = (delivererId = d1.id) =>
    t.base.courses.filter(
      (c) =>
        c.deliverer_id === delivererId &&
        [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY].includes(c.statut),
    );
  const neuve = () => t.base.courses.find((c) => c.id !== k.id && c.deliverer_id === d1.id && c.statut === CourseStatut.IN_DELIVERY)!;
  const rien = () => ({
    journal: t.journalDe('LIVRAISON_RELANCEE').length,
    courses: t.base.courses.length,
    pushs: pushLivreur.notifyLivraisonRelancee.mock.calls.length,
    relancees: socketsVers('emitToDeliverer', CourseChannels.LIVRAISON_RELANCEE).length,
  });
  return {
    d1,
    d2,
    a,
    b,
    k,
    la,
    lb,
    t,
    file,
    livraisons,
    passerelle,
    pushLivreur,
    duree,
    service,
    admin,
    relancer,
    annuler,
    sacRapporte,
    socketsVers,
    coursesActives,
    neuve,
    rien,
    appliLivreur,
  };
}

type Banc = ReturnType<typeof enTournee>;

/** Une autre course du livreur, en livraison (partie ou au comptoir), un client C. */
function autreCourse(b: Banc, o: { partie: boolean; statut?: CourseStatut }) {
  const c = commande({ status: OrderStatus.PICKED_UP, picked_up_at: avant(60), address: B, delivery_fee: 1000, paied: true });
  const k2 = course({
    statut: o.statut ?? CourseStatut.IN_DELIVERY,
    deliverer_id: b.d1.id,
    assigned_at: avant(300),
    picked_up_at: o.statut && o.statut !== CourseStatut.IN_DELIVERY ? null : avant(60),
    parti_at: o.partie ? avant(30) : null,
    motif_depart: o.partie ? 'POSITION' : null,
    total_delivery_fee: 1000,
  });
  const lc = livraison({
    course_id: k2.id,
    order_id: c.id,
    sequence_order: 1,
    delivery_pin: '5555',
    statut: o.partie ? DeliveryStatut.IN_ROUTE : DeliveryStatut.PENDING,
    in_route_at: o.partie ? avant(30) : null,
  });
  b.t.base.commandes.push(c);
  b.t.base.courses.push(k2);
  b.t.base.livraisons.push(lc);
  b.d1.last_available_at = null;
  return { c, k2, lc };
}

/** En base, la ligne verrouillée fait attendre la seconde transaction : le banc les sérialise. */
function serialiser(t: Banc['t']) {
  const transaction = t.base.prisma.$transaction.getMockImplementation()!;
  let file: Promise<unknown> = Promise.resolve();
  t.base.prisma.$transaction.mockImplementation((arg: unknown) => {
    const tour = file.then(() => transaction(arg));
    file = tour.catch(() => undefined);
    return tour;
  });
}

async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return e as Error;
  }
  throw new Error('La promesse devait être rejetée');
}

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('« Relancer la livraison » : la livraison annulée revient au même livreur', () => {
  it('1. sans course (ancienne course terminée) : course neuve en livraison, même livraison démarrée, commande intacte', async () => {
    const b = enTournee({ seulementA: true });
    const { d1, a, k, la, t, relancer, annuler, duree } = b;
    await annuler(la.id);
    expect(k.statut).toBe(CourseStatut.COMPLETED);
    expect(d1.last_available_at).toEqual(MAINTENANT); // remis dans la file
    // Le livreur a noté le client et était chez lui avant d'annuler.
    Object.assign(la, { arrived_at: avant(120), customer_rating: 2, customer_rating_note: 'Injoignable', customer_rated_at: MAINTENANT });
    const commandeAvant = { ...a };
    const idAvant = la.id;

    const reponse = await relancer(a.id);

    const n = b.neuve();
    expect(n).toBeDefined();
    expect(reponse).toEqual({
      order_id: a.id,
      reference: a.reference,
      course_id: n.id,
      course_reference: n.reference,
      nouvelle_course: true,
      rang: 1,
      demarree: true,
      livreur: { id: d1.id, prenom: 'Koffi' },
      appli_connectee: true,
      deja: false,
    });
    // Course neuve : en livraison, partie (motif réel), vrai retrait, frais de la commande, aucune offre.
    expect(n).toMatchObject({
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: d1.id,
      restaurant_id: RESTO,
      assigned_at: MAINTENANT,
      picked_up_at: avant(600),
      parti_at: MAINTENANT,
      motif_depart: 'LIVRAISON_DEMARREE',
      estimated_duration_min: null,
      total_delivery_fee: 1000,
    });
    expect(n.reference).not.toBe(k.reference);
    expect(n.pickup_code).toMatch(/^\d{3}$/);
    expect(t.base.offres.filter((o) => o.course_id === n.id)).toHaveLength(0);
    // Même livraison, même code : en route, échec, arrivée, report et note effacés.
    expect(t.base.livraisons.filter((l) => l.order_id === a.id)).toEqual([la]);
    expect(la).toMatchObject({
      id: idAvant,
      course_id: n.id,
      sequence_order: 1,
      delivery_pin: '4821',
      statut: DeliveryStatut.IN_ROUTE,
      in_route_at: MAINTENANT,
      failed_at: null,
      failure_reason: null,
      failure_note: null,
      arrived_at: null,
      reportee_at: null,
      customer_rating: null,
      customer_rating_note: null,
      customer_rated_at: null,
    });
    // Commande identique (statut, retrait, payée, lot).
    expect({ ...a }).toEqual(commandeAvant);
    // Ancienne course : statut inchangé, un arrêt de moins.
    expect(k).toMatchObject({ statut: CourseStatut.COMPLETED, total_delivery_fee: 0 });
    // Livreur hors de la file.
    expect(d1.last_available_at).toBeNull();
    // Journal : une ligne, la copie de ce que la relance efface, jamais le code.
    const lignes = t.journalDe('LIVRAISON_RELANCEE');
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({
      type: 'LIVRAISON_RELANCEE',
      motif: DeliveryFailureReason.CLIENT_ABSENT,
      source: 'admin',
      restaurant_id: RESTO,
      course_id: k.id,
      deliverer_id: d1.id,
      order_id: a.id,
      details: {
        commande: a.reference,
        course_avant: k.reference,
        course_apres: n.reference,
        nouvelle_course: true,
        rang: 1,
        demarree: true,
        failed_at: MAINTENANT.toISOString(),
        failure_note: 'Client absent',
        in_route_at: avant(590).toISOString(),
        arrived_at: avant(120).toISOString(),
        reportee_at: null,
        customer_rating: 2,
        customer_rating_note: 'Injoignable',
        par: { id: CALL_CENTER.id, role: UserRole.CALL_CENTER },
      },
    });
    expect(JSON.stringify(lignes[0])).not.toContain('4821');
    // L'annulation de la veille reste au journal.
    expect(t.journalDe('LIVRAISON_ANNULEE')).toHaveLength(1);
    // Course neuve : pas d'estimation de tournée (l'heure d'arrivée vient du GPS).
    expect(duree.estimerDureeTournee).not.toHaveBeenCalled();
  });

  it('2. même course encore en livraison (client B en route) : dernière, en attente, rien ne démarre', async () => {
    const b = enTournee();
    const { d1, a, k, la, lb, t, relancer, annuler, duree, pushLivreur } = b;
    await annuler(la.id);
    await t.actionsLivraison.startDelivery(lb.id, d1.id);
    expect(lb.statut).toBe(DeliveryStatut.IN_ROUTE);

    const reponse = await relancer(a.id);

    expect(reponse).toMatchObject({ course_id: k.id, nouvelle_course: false, rang: 2, demarree: false, deja: false });
    expect(t.livraisonsDe(k.id).map((l) => [l.id, l.sequence_order, l.statut])).toEqual([
      [lb.id, 1, DeliveryStatut.IN_ROUTE],
      [la.id, 2, DeliveryStatut.PENDING],
    ]);
    expect(la).toMatchObject({ in_route_at: null, failed_at: null, ajoutee_at: null, delivery_pin: '4821' });
    expect(lb).toMatchObject({ delivery_pin: '7733', in_route_at: MAINTENANT });
    expect(k).toMatchObject({ statut: CourseStatut.IN_DELIVERY, total_delivery_fee: 2000 });
    expect(b.coursesActives()).toEqual([k]);
    expect(duree.estimerDureeTournee).toHaveBeenCalledWith(k.id);
    expect(pushLivreur.notifyLivraisonRelancee).toHaveBeenCalledWith(expect.objectContaining({ enDernier: true }));
  });

  it('3. autre course en livraison, partie : déplacée en dernier, en attente, ajoutée maintenant, frais des deux courses', async () => {
    const b = enTournee({ seulementA: true });
    const { a, k, la, t, relancer, annuler, duree } = b;
    await annuler(la.id);
    const { k2, lc } = autreCourse(b, { partie: true });

    const reponse = await relancer(a.id);

    expect(reponse).toMatchObject({ course_id: k2.id, course_reference: k2.reference, nouvelle_course: false, rang: 2, demarree: false });
    expect(t.livraisonsDe(k2.id).map((l) => [l.id, l.sequence_order, l.statut])).toEqual([
      [lc.id, 1, DeliveryStatut.IN_ROUTE],
      [la.id, 2, DeliveryStatut.PENDING],
    ]);
    expect(la.ajoutee_at).toEqual(MAINTENANT);
    expect(t.livraisonsDe(k.id)).toHaveLength(0);
    expect(k).toMatchObject({ statut: CourseStatut.COMPLETED, total_delivery_fee: 0 });
    expect(k2.total_delivery_fee).toBe(2000);
    expect(b.coursesActives()).toEqual([k2]);
    expect(duree.estimerDureeTournee).toHaveBeenCalledWith(k2.id);
  });

  it('3 bis. autre course au comptoir : en dernier ; au départ, le serveur démarre la première commande, pas la relancée', async () => {
    const b = enTournee({ seulementA: true });
    const { a, la, t, relancer, annuler } = b;
    await annuler(la.id);
    const { k2, lc } = autreCourse(b, { partie: false });

    const reponse = await relancer(a.id);

    expect(reponse).toMatchObject({ course_id: k2.id, rang: 2, demarree: false });
    expect(la).toMatchObject({ course_id: k2.id, statut: DeliveryStatut.PENDING, sequence_order: 2 });
    expect(k2.parti_at).toBeNull();

    const depart = await t.depart.enregistrerDepart(k2.id, { motif: 'POSITION', source: 'serveur' });

    expect(depart.demarree).toBe(lc.id);
    expect(lc.statut).toBe(DeliveryStatut.IN_ROUTE);
    expect(la.statut).toBe(DeliveryStatut.PENDING);
    // Commande déjà remise : jamais retirée au départ.
    expect(t.livraisonsDe(k2.id).map((l) => l.id)).toEqual([lc.id, la.id]);
  });

  it('4. seule livraison livrable d’une course partie (l’autre sac est resté au comptoir) : démarrée tout de suite', async () => {
    const b = enTournee({ surchargeB: { status: OrderStatus.READY, picked_up_at: null } });
    const { a, k, la, lb, relancer, annuler, pushLivreur } = b;
    await annuler(la.id);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);

    const reponse = await relancer(a.id);

    expect(reponse).toMatchObject({ course_id: k.id, nouvelle_course: false, demarree: true });
    expect(la).toMatchObject({ statut: DeliveryStatut.IN_ROUTE, in_route_at: MAINTENANT });
    expect(lb.statut).toBe(DeliveryStatut.PENDING);
    expect(pushLivreur.notifyLivraisonRelancee).toHaveBeenCalledWith(expect.objectContaining({ enDernier: false }));
  });

  describe('5. le livreur', () => {
    it.each([CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT])('course %s (il va au restaurant) : 409, rien n’est écrit', async (statut) => {
      const b = enTournee({ seulementA: true });
      const { a, k, la, relancer, annuler } = b;
      await annuler(la.id);
      autreCourse(b, { partie: false, statut });
      const avant = b.rien();

      const e = await refus(relancer(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Ce livreur va au restaurant pour une autre course : Sac rapporté à son arrivée.');
      expect(la).toMatchObject({ statut: DeliveryStatut.FAILED, course_id: k.id });
      expect(b.rien()).toEqual(avant);
    });

    it.each([
      ['en pause', { pause_until: apres(3600) }, "Ce livreur est en pause jusqu'à 16 h 30."],
      ['en pause automatique', { auto_pause_until: apres(1800) }, "Ce livreur est en pause automatique jusqu'à 16 h 00."],
      ['hors service', { last_available_at: null }, "Ce livreur est hors service : il n'a pas repris le travail dans l'appli."],
      ['inactif', { is_operational: false }, "Ce livreur n'est pas actif ou n'est rattaché à aucun restaurant."],
      ['suspendu', { status: DelivererStatus.SUSPENDED }, "Ce livreur n'est pas actif ou n'est rattaché à aucun restaurant."],
      ['supprimé', { entity_status: EntityStatus.DELETED }, "Ce livreur n'est pas actif ou n'est rattaché à aucun restaurant."],
      ['sans restaurant', { restaurant_id: null }, "Ce livreur n'est pas actif ou n'est rattaché à aucun restaurant."],
    ])('sans course, %s : 409 avec les mots d’avant', async (_cas, etat, message) => {
      const b = enTournee({ seulementA: true });
      const { d1, a, la, relancer, annuler } = b;
      await annuler(la.id);
      Object.assign(d1, etat);
      const avant = b.rien();

      const e = await refus(relancer(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe(message);
      expect(la.statut).toBe(DeliveryStatut.FAILED);
      expect(b.rien()).toEqual(avant);
    });

    it('sans course, injoignable (ni appli connectée, ni jeton) : 409', async () => {
      const b = enTournee({ seulementA: true });
      const { d1, a, la, t, relancer, annuler } = b;
      await annuler(la.id);
      d1.expo_push_token = null;
      t.appli.etat.connectes = [];

      const e = await refus(relancer(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Ce livreur est injoignable : ni appli connectée, ni notifications.');
      expect(la.statut).toBe(DeliveryStatut.FAILED);
    });

    it('en tournée : seul « inactif » refuse (une pause posée pendant la tournée ne bloque pas)', async () => {
      const b = enTournee();
      const { d1, a, la, lb, relancer, annuler } = b;
      await annuler(la.id);
      d1.pause_until = apres(3600);
      expect(await relancer(a.id)).toMatchObject({ deja: false, rang: 2 });
      expect(la.statut).toBe(DeliveryStatut.PENDING);
      expect(lb.statut).toBe(DeliveryStatut.PENDING);

      const c = enTournee();
      await c.annuler(c.la.id);
      c.d1.is_operational = false;
      const e = await refus(c.relancer(c.a.id));
      expect(e.message).toBe("Ce livreur n'est pas actif ou n'est rattaché à aucun restaurant.");
    });

    it.each([
      [
        'appli fermée',
        (b: Banc) => {
          b.t.appli.etat.connectes = [];
          b.d1.dernier_signal_at = avant(900);
          b.t.appli.fins.etat.fins = { [b.d1.id]: { raison: 'client namespace disconnect', a: avant(890) } };
        },
        false,
      ],
      [
        'connexion coupée',
        (b: Banc) => {
          b.t.appli.etat.connectes = [];
          b.d1.dernier_signal_at = avant(900);
        },
        false,
      ],
      [
        'en appel avec le call center',
        (b: Banc) => {
          jest.spyOn(b.t.appli.service, 'livreursEnAppel').mockResolvedValue(new Set([b.d1.id]));
        },
        true,
      ],
    ])('sans course, %s : jamais un refus (la notification part)', async (_cas, preparer, connectee) => {
      const b = enTournee({ seulementA: true });
      await b.annuler(b.la.id);
      preparer(b);

      const reponse = await b.relancer(b.a.id);

      expect(reponse).toMatchObject({ nouvelle_course: true, demarree: true, appli_connectee: connectee, deja: false });
      expect(b.pushLivreur.notifyLivraisonRelancee).toHaveBeenCalledTimes(1);
    });

    it('offre en attente : close sans pénalité (OFFRE_CLOSE, LIVREUR_INDISPONIBLE), la recherche repart, puis 200', async () => {
      const b = enTournee({ seulementA: true });
      const { d1, a, la, t, relancer, annuler } = b;
      await annuler(la.id);
      const k2 = course({ statut: CourseStatut.PENDING_ASSIGNMENT, offer_expires_at: apres(100) });
      const o = offre({ course_id: k2.id, deliverer_id: d1.id, offered_at: avant(20), expires_at: apres(100) });
      t.base.courses.push(k2);
      t.base.offres.push(o);

      const reponse = await relancer(a.id);

      expect(reponse).toMatchObject({ nouvelle_course: true, deja: false });
      expect(o.status).toBe(CourseOfferStatus.CANCELLED);
      expect(t.journalDe('OFFRE_CLOSE')).toEqual([
        expect.objectContaining({
          motif: 'LIVREUR_INDISPONIBLE',
          source: 'admin',
          deliverer_id: d1.id,
          course_id: k2.id,
          details: expect.objectContaining({ raison: 'LIVRAISON_RELANCEE' }),
        }),
      ]);
      expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
      expect(t.emisSur(DispatchEvenements.RECHERCHE_A_RELANCER)).toEqual([{ course_id: k2.id }]);
      expect(t.emisSur(CourseChannels.COURSE_OFFER_EXPIRED)).toEqual([
        expect.objectContaining({ course_id: k2.id, deliverer_id: d1.id, motif: 'LIVREUR_INDISPONIBLE' }),
      ]);
    });

    it('offre née entre la clôture et le verrou : 409, rien n’est écrit', async () => {
      const b = enTournee({ seulementA: true });
      const { d1, a, la, t, relancer, annuler } = b;
      await annuler(la.id);
      const k2 = course({ statut: CourseStatut.PENDING_ASSIGNMENT });
      t.base.courses.push(k2);
      jest.spyOn(t.cloture, 'clorePourLivreur').mockImplementationOnce(async () => {
        t.base.offres.push(offre({ course_id: k2.id, deliverer_id: d1.id, expires_at: apres(100) }));
        return [];
      });
      const avant = b.rien();

      const e = await refus(relancer(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Ce livreur a déjà une offre en attente de réponse.');
      expect(la.statut).toBe(DeliveryStatut.FAILED);
      expect(b.rien()).toEqual(avant);
    });
  });

  describe('6. rejeu (double toucher, réponse perdue)', () => {
    it('200 « deja », une seule ligne, une seule notification, rien n’est réémis', async () => {
      const b = enTournee({ seulementA: true });
      const { a, la, t, relancer, annuler, passerelle, pushLivreur } = b;
      await annuler(la.id);
      const premiere = await relancer(a.id);
      const emissions = t.emis.length;
      // Sockets émis (la présence du livreur, relue pour la réponse, n'en est pas un).
      const sockets = () =>
        passerelle.emitToUser.mock.calls.length +
        passerelle.emitToBackoffice.mock.calls.length +
        passerelle.emitToRestaurant.mock.calls.length +
        passerelle.emitToDeliverer.mock.calls.length;
      const socketsAvant = sockets();

      const rejeu = await relancer(a.id, ADMIN);

      expect(rejeu).toEqual({ ...premiere, deja: true });
      expect(t.journalDe('LIVRAISON_RELANCEE')).toHaveLength(1);
      expect(t.emis.length).toBe(emissions);
      expect(sockets()).toBe(socketsAvant);
      expect(pushLivreur.notifyLivraisonRelancee).toHaveBeenCalledTimes(1);
    });

    it('deux touchers au même instant : une écriture, un « deja »', async () => {
      const b = enTournee({ seulementA: true });
      const { a, la, t, relancer, annuler, pushLivreur, socketsVers } = b;
      await annuler(la.id);
      serialiser(t);

      const [x, y] = await Promise.all([relancer(a.id), relancer(a.id)]);

      expect([x.deja, y.deja].sort()).toEqual([false, true]);
      expect(x.course_id).toBe(y.course_id);
      expect(b.coursesActives()).toHaveLength(1);
      expect(t.journalDe('LIVRAISON_RELANCEE')).toHaveLength(1);
      expect(socketsVers('emitToDeliverer', CourseChannels.LIVRAISON_RELANCEE)).toHaveLength(1);
      expect(pushLivreur.notifyLivraisonRelancee).toHaveBeenCalledTimes(1);
    });
  });

  describe('7. refus', () => {
    it('commande inconnue ou supprimée : 404 « Commande introuvable. »', async () => {
      const { a, la, relancer, annuler } = enTournee({ seulementA: true });
      await annuler(la.id);
      const inconnue = await refus(relancer('00000000-0000-4000-8000-000000000000'));
      expect(inconnue).toBeInstanceOf(NotFoundException);
      expect(inconnue.message).toBe('Commande introuvable.');

      a.entity_status = EntityStatus.DELETED;
      const supprimee = await refus(relancer(a.id));
      expect(supprimee).toBeInstanceOf(NotFoundException);
      expect(supprimee.message).toBe('Commande introuvable.');
    });

    it('commande annulée : 409 « Commande annulée. »', async () => {
      const { a, la, t, relancer, annuler } = enTournee({ seulementA: true });
      await annuler(la.id);
      Object.assign(a, { status: OrderStatus.CANCELLED, cancelled_at: MAINTENANT, cancelled_by: 'admin' });
      const e = await refus(relancer(a.id));
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Commande annulée.');
      expect(t.journalDe('LIVRAISON_RELANCEE')).toHaveLength(0);
    });

    it('sac déjà rapporté (commande de nouveau prête, ou repartie en cuisine) : 409 « Sac déjà rapporté. »', async () => {
      const { a, la, t, relancer, annuler, sacRapporte } = enTournee({ seulementA: true });
      await annuler(la.id);
      await sacRapporte(a.id);
      expect(a.status).toBe(OrderStatus.READY);

      for (const status of [OrderStatus.READY, OrderStatus.IN_PROGRESS]) {
        a.status = status;
        const e = await refus(relancer(a.id));
        expect(e).toBeInstanceOf(ConflictException);
        expect(e.message).toBe('Sac déjà rapporté.');
      }
      expect(t.journalDe('LIVRAISON_RELANCEE')).toHaveLength(0);
    });

    it('livraison en cours, livrée, confiée à Turbo, sans livreur : 409 « Aucune livraison annulée sur cette commande. »', async () => {
      const b = enTournee({ seulementA: true });
      const { d1, a, k, la, t, relancer, livraisons } = b;
      const message = 'Aucune livraison annulée sur cette commande.';
      // En cours (jamais annulée).
      expect((await refus(relancer(a.id))).message).toBe(message);
      // Livrée.
      await livraisons.markArrived(la.id, d1.id);
      await livraisons.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);
      expect(a.status).toBe(OrderStatus.COMPLETED);
      expect((await refus(relancer(a.id))).message).toBe(message);

      // Turbo, sans livreur.
      const c = enTournee({ seulementA: true });
      await c.annuler(c.la.id);
      c.k.turbo_escalated_at = avant(60);
      expect((await refus(c.relancer(c.a.id))).message).toBe(message);
      c.k.turbo_escalated_at = null;
      c.k.deliverer_id = null;
      expect((await refus(c.relancer(c.a.id))).message).toBe(message);
      expect(c.la.statut).toBe(DeliveryStatut.FAILED);
      expect([...t.journalDe('LIVRAISON_RELANCEE'), ...c.t.journalDe('LIVRAISON_RELANCEE')]).toHaveLength(0);
      expect(k.statut).toBe(CourseStatut.COMPLETED);
    });

    it('rôles : ADMIN et CALL_CENTER ; jamais le restaurant, la cuisine, le suivi des livraisons, le marketing', () => {
      const passe = (role: UserRole) =>
        new UserRolesGuard(new Reflector()).canActivate({
          getHandler: () => CourseAdminController.prototype.relancerLivraisonCommande,
          getClass: () => CourseAdminController,
          switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
        } as never);
      expect(Object.values(UserRole).filter(passe).sort()).toEqual([UserRole.ADMIN, UserRole.CALL_CENTER].sort());
      for (const role of [
        UserRole.MANAGER,
        UserRole.ASSISTANT_MANAGER,
        UserRole.CAISSIER,
        UserRole.CUISINE,
        UserRole.LIVRAISON_OPS,
        UserRole.MARKETING,
      ]) {
        expect(passe(role)).toBe(false);
      }
    });
  });

  describe('8. concurrence : un seul gagne', () => {
    it('« Sac rapporté » juste avant l’écriture : la commande reste prête, 409 « Sac déjà rapporté. », rien n’est écrit', async () => {
      const b = enTournee({ seulementA: true });
      const { a, la, t, relancer, annuler, sacRapporte } = b;
      await annuler(la.id);
      jest.spyOn(t.cloture, 'clorePourLivreur').mockImplementationOnce(async () => {
        await sacRapporte(a.id);
        return [];
      });
      const courses = t.base.courses.length;

      const e = await refus(relancer(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Sac déjà rapporté.');
      expect(a.status).toBe(OrderStatus.READY);
      expect(t.base.livraisons.filter((l) => l.order_id === a.id)).toHaveLength(0);
      expect(t.journalDe('LIVRAISON_RELANCEE')).toHaveLength(0);
      expect(t.base.courses.length).toBe(courses);
    });

    it('relance d’abord : « Sac rapporté » répond « Pas de sac à rapporter pour cette commande. »', async () => {
      const { a, la, relancer, annuler, sacRapporte } = enTournee({ seulementA: true });
      await annuler(la.id);
      await relancer(a.id);

      const e = await refus(sacRapporte(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Pas de sac à rapporter pour cette commande.');
      expect(a.status).toBe(OrderStatus.PICKED_UP);
      expect(la.statut).toBe(DeliveryStatut.IN_ROUTE);
    });

    it('« Annuler la commande » de l’admin au même instant : 409 « Commande annulée. », la commande reste annulée', async () => {
      const b = enTournee({ seulementA: true });
      const { a, k, la, t, relancer, annuler } = b;
      await annuler(la.id);
      jest.spyOn(t.cloture, 'clorePourLivreur').mockImplementationOnce(async () => {
        Object.assign(a, { status: OrderStatus.CANCELLED, cancelled_at: MAINTENANT, cancelled_by: 'admin' });
        return [];
      });
      const avant = b.rien();

      const e = await refus(relancer(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Commande annulée.');
      expect(a.status).toBe(OrderStatus.CANCELLED);
      expect(la).toMatchObject({ statut: DeliveryStatut.FAILED, course_id: k.id });
      expect(b.rien()).toEqual(avant);
    });

    it('livraison changée entre la commande tenue et la reprise : tout est annulé, course neuve comprise', async () => {
      const b = enTournee({ seulementA: true });
      const { a, k, la, t, relancer, annuler } = b;
      await annuler(la.id);
      const transaction = t.base.prisma.$transaction.getMockImplementation()!;
      t.base.prisma.$transaction.mockImplementation((arg: unknown) =>
        transaction(async (tx: any) =>
          (arg as (tx: unknown) => Promise<unknown>)({
            ...tx,
            delivery: { ...tx.delivery, updateMany: jest.fn(async () => ({ count: 0 })) },
          }),
        ),
      );
      const courses = t.base.courses.length;

      const e = await refus(relancer(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe(MESSAGE_COMMANDE_CHANGEE);
      expect(t.base.courses.length).toBe(courses);
      expect(la).toMatchObject({ statut: DeliveryStatut.FAILED, course_id: k.id });
      expect(t.journalDe('LIVRAISON_RELANCEE')).toHaveLength(0);
    });

    it('deux relances de deux commandes, livreur sans course : UNE course neuve avec les deux', async () => {
      const b = enTournee();
      const { d1, a, b: cb, k, la, lb, t, relancer, annuler } = b;
      await annuler(la.id);
      await t.actionsLivraison.startDelivery(lb.id, d1.id);
      await annuler(lb.id, { reason: DeliveryFailureReason.CLIENT_REFUSED });
      expect(k.statut).toBe(CourseStatut.COMPLETED);
      serialiser(t);

      const [x, y] = await Promise.all([relancer(a.id), relancer(cb.id)]);

      expect(b.coursesActives()).toHaveLength(1);
      const n = b.coursesActives()[0];
      expect([x, y].map((r) => r.course_id)).toEqual([n.id, n.id]);
      expect([x, y].map((r) => [r.nouvelle_course, r.rang, r.demarree]).sort()).toEqual([
        [false, 2, false],
        [true, 1, true],
      ]);
      expect(t.livraisonsDe(n.id).map((l) => l.statut)).toEqual([DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING]);
      expect(n.total_delivery_fee).toBe(2000);
    });

    it('relance puis acceptation de l’offre : l’offre est close, l’acceptation refusée, une seule course active', async () => {
      const b = enTournee({ seulementA: true });
      const { d1, a, la, t, relancer, annuler } = b;
      await annuler(la.id);
      const k2 = course({ statut: CourseStatut.PENDING_ASSIGNMENT, offer_expires_at: apres(100) });
      t.base.courses.push(k2);
      t.base.offres.push(offre({ course_id: k2.id, deliverer_id: d1.id, offered_at: avant(20), expires_at: apres(100) }));

      await relancer(a.id);
      const e = await refus(t.actions.acceptOffer(k2.id, d1.id));

      expect(e.message).toBe("Cette course n'est plus disponible.");
      expect(k2.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
      expect(b.coursesActives()).toHaveLength(1);
    });

    it('acceptation puis relance : 409 (il va au restaurant), une seule course active', async () => {
      const b = enTournee({ seulementA: true });
      const { d1, a, la, t, relancer, annuler } = b;
      await annuler(la.id);
      const k2 = course({ statut: CourseStatut.PENDING_ASSIGNMENT, offer_expires_at: apres(100) });
      t.base.courses.push(k2);
      t.base.offres.push(offre({ course_id: k2.id, deliverer_id: d1.id, offered_at: avant(20), expires_at: apres(100) }));

      await t.actions.acceptOffer(k2.id, d1.id);
      const e = await refus(relancer(a.id));

      expect(e.message).toBe('Ce livreur va au restaurant pour une autre course : Sac rapporté à son arrivée.');
      expect(b.coursesActives()).toEqual([k2]);
      expect(la.statut).toBe(DeliveryStatut.FAILED);
    });
  });

  describe('9. événements', () => {
    it('sans course : livraison FAILED → IN_ROUTE à tous, courses au siège et au restaurant, socket et notification au livreur', async () => {
      const b = enTournee({ seulementA: true });
      const { d1, a, k, la, t, relancer, annuler, passerelle, pushLivreur, socketsVers } = b;
      await annuler(la.id);
      t.emis.length = 0;
      passerelle.emitToDeliverer.mockClear();
      passerelle.emitToBackoffice.mockClear();
      passerelle.emitToRestaurant.mockClear();

      await relancer(a.id);
      const n = b.neuve();

      // Changement de la livraison, sans le code du client.
      const [changement] = t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED);
      expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(1);
      expect(changement).toMatchObject({
        course_id: n.id,
        course_reference: n.reference,
        restaurant_id: RESTO,
        previous_statut: DeliveryStatut.FAILED,
        new_statut: DeliveryStatut.IN_ROUTE,
        delivery: { id: la.id, order_id: a.id, statut: DeliveryStatut.IN_ROUTE },
      });
      expect(changement.delivery).not.toHaveProperty('delivery_pin');
      // Coupons et points ne lisent que l'échec d'une commande annulée : rien à rendre.
      expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED).some((p) => p.new_statut === DeliveryStatut.FAILED)).toBe(false);
      expect(a.status).toBe(OrderStatus.PICKED_UP);

      // Courses relues au siège et au restaurant, raison LIVRAISON_RELANCEE : la neuve et l'ancienne.
      const siege = socketsVers('emitToBackoffice', CourseChannels.COURSE_STATUT_CHANGED).map((c) => c[1]);
      expect(siege.map((p) => [p.reason, p.course.id])).toEqual([
        ['LIVRAISON_RELANCEE', n.id],
        ['LIVRAISON_RELANCEE', k.id],
      ]);
      expect(socketsVers('emitToRestaurant', CourseChannels.COURSE_STATUT_CHANGED).map((c) => [c[0], c[2].reason])).toEqual([
        [RESTO, 'LIVRAISON_RELANCEE'],
        [RESTO, 'LIVRAISON_RELANCEE'],
      ]);

      // Livreur : socket et notification (sonnerie des offres côté service des notifications).
      expect(socketsVers('emitToDeliverer', CourseChannels.LIVRAISON_RELANCEE)).toEqual([
        [
          d1.id,
          'deliverer:livraison:relancee',
          { order_id: a.id, delivery_id: la.id, reference: a.reference, course_id: n.id, nouvelle_course: true, rang: 1, demarree: true },
        ],
      ]);
      expect(pushLivreur.notifyLivraisonRelancee).toHaveBeenCalledWith({
        delivererId: d1.id,
        courseId: n.id,
        orderId: a.id,
        deliveryId: la.id,
        reference: a.reference,
        enDernier: false,
      });

      // L'appli déjà installée relit sa course (LivraisonVersLivreurListener).
      passerelle.emitToDeliverer.mockClear();
      await new LivraisonVersLivreurListener(t.base.prisma, passerelle as never).onLivraison(changement);
      expect(passerelle.emitToDeliverer).toHaveBeenCalledWith(
        d1.id,
        CourseChannels.COURSE_STATUT_CHANGED,
        expect.objectContaining({
          reason: 'LIVRAISON_IN_ROUTE',
          course: expect.objectContaining({ id: n.id, statut: CourseStatut.IN_DELIVERY }),
          livraison: { id: la.id, order_id: a.id, previous_statut: DeliveryStatut.FAILED, new_statut: DeliveryStatut.IN_ROUTE },
        }),
      );
    });

    it('en tournée : FAILED → PENDING, raison LIVRAISON_PENDING au livreur, notification « en dernier »', async () => {
      const b = enTournee();
      const { d1, a, k, la, lb, t, relancer, annuler, passerelle, pushLivreur, socketsVers } = b;
      await annuler(la.id);
      await t.actionsLivraison.startDelivery(lb.id, d1.id);
      t.emis.length = 0;
      passerelle.emitToBackoffice.mockClear();

      await relancer(a.id);

      const [changement] = t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED);
      expect(changement).toMatchObject({ course_id: k.id, previous_statut: DeliveryStatut.FAILED, new_statut: DeliveryStatut.PENDING });
      // Même course : relue une fois.
      expect(socketsVers('emitToBackoffice', CourseChannels.COURSE_STATUT_CHANGED).map((c) => c[1].course.id)).toEqual([k.id]);
      expect(pushLivreur.notifyLivraisonRelancee).toHaveBeenCalledWith(expect.objectContaining({ courseId: k.id, enDernier: true }));
      passerelle.emitToDeliverer.mockClear();
      await new LivraisonVersLivreurListener(t.base.prisma, passerelle as never).onLivraison(changement);
      expect(passerelle.emitToDeliverer.mock.calls[0][2]).toMatchObject({ reason: 'LIVRAISON_PENDING' });
      expect(lb.statut).toBe(DeliveryStatut.IN_ROUTE);
    });

    it('notification : « Livraison relancée », « ORD » ou « ORD · en dernier », sonnerie des offres', async () => {
      const envois: any[] = [];
      const prisma = {
        deliverer: { findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[x]', first_name: 'Koffi', protocole_appli: 4 })) },
      };
      const push = new DelivererPushService(prisma as never, { sendPushNotifications: jest.fn(async (m: unknown) => void envois.push(m)) } as never);
      push.notifyLivraisonRelancee({ delivererId: 'l1', courseId: 'k1', orderId: 'o1', deliveryId: 'd1', reference: 'ORD-123', enDernier: false });
      push.notifyLivraisonRelancee({ delivererId: 'l1', courseId: 'k1', orderId: 'o1', deliveryId: 'd1', reference: 'ORD-123', enDernier: true });
      await new Promise((r) => setImmediate(r));

      expect(envois).toEqual([
        expect.objectContaining({
          title: 'Livraison relancée',
          body: 'ORD-123',
          priority: 'high',
          channelId: 'offres_v1',
          sound: 'offre_course.wav',
          data: { type: 'livraison_relancee', courseId: 'k1', orderId: 'o1', deliveryId: 'd1', reference: 'ORD-123', enDernier: false },
        }),
        expect.objectContaining({ title: 'Livraison relancée', body: 'ORD-123 · en dernier' }),
      ]);
      for (const e of envois) expect(`${e.title} ${e.body}`).not.toMatch(/—/);
    });
  });

  it('10. client : statut et heure d’arrivée au départ, WhatsApp de départ une fois (même code) pour un client sans appli', async () => {
    const b = enTournee({ seulementA: true });
    const { a, la, t, relancer, annuler, passerelle } = b;
    await annuler(la.id);
    t.emis.length = 0;
    await relancer(a.id);
    const n = b.neuve();

    const twilio = { sendOrderTracking: jest.fn(async () => undefined) };
    t.base.prisma.notificationSetting = { findUnique: jest.fn(async () => null) }; // client sans appli
    const notifier = new OrderDepartureNotifierService(t.base.prisma, twilio as never);
    const suivi = new DeliveryTrackingService(t.base.prisma, passerelle as never, {} as never, notifier);
    jest.spyOn(suivi as any, 'etaAuDepart').mockResolvedValue(12);
    passerelle.emitToUser.mockClear();

    for (const p of t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)) await suivi.onDeliveryStatutChanged(p);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(passerelle.emitToUser).toHaveBeenCalledWith(
      'client-a',
      'customer',
      CourseChannels.CUSTOMER_DELIVERY_STATUT_CHANGED,
      expect.objectContaining({ orderId: a.id, statut: DeliveryStatut.IN_ROUTE, previousStatut: DeliveryStatut.FAILED, courseId: n.id, etaMin: 12 }),
    );
    expect(twilio.sendOrderTracking).toHaveBeenCalledTimes(1);
    expect(twilio.sendOrderTracking).toHaveBeenCalledWith(expect.objectContaining({ orderReference: a.reference, recoveryCode: '4821' }));
  });

  describe('11. écrans : l’alerte « a annulé », `sac_a_rapporter`, le rappel du livreur', () => {
    const lireCommande = async (t: Banc['t'], id: string) =>
      t.base.prisma.order.findUnique({
        where: { id },
        include: { delivery: { include: { course: { include: { deliverer: true } } } } },
      });
    const p = { maintenant: MAINTENANT, fenetreMaxS: 240 };

    it('`sac_a_rapporter` rempli après « Annuler », `null` après la relance ; rappel du livreur vide', async () => {
      const { d1, a, la, t, relancer, annuler, appliLivreur } = enTournee({ seulementA: true });
      await annuler(la.id);
      const [annulee] = enrichirCommandesOperations([await lireCommande(t, a.id)], p) as any[];
      expect(annulee.sac_a_rapporter).not.toBeNull();
      expect(await appliLivreur.sacsARapporter(d1 as never)).toHaveLength(1);

      await relancer(a.id);

      const [relancee] = enrichirCommandesOperations([await lireCommande(t, a.id)], p) as any[];
      expect(relancee.sac_a_rapporter).toBeNull();
      expect(await appliLivreur.sacsARapporter(d1 as never)).toEqual([]);
    });

    it('alerte LIVRAISON_ANNULEE_PAR_LIVREUR : présente après « Annuler », absente après la relance', async () => {
      const { d1, a, k, la, t, relancer, annuler } = enTournee();
      await annuler(la.id);
      const lue = (): CourseLue => ({
        ...k,
        deliverer: { id: d1.id, first_name: 'Koffi' },
        deliveries: t.livraisonsDe(k.id).map((l) => {
          const o = t.base.commandes.find((c) => c.id === l.order_id)!;
          return {
            statut: l.statut,
            ajoutee_apres_retrait: l.ajoutee_apres_retrait,
            failed_at: l.failed_at ?? null,
            failure_reason: l.failure_reason ?? null,
            order: { id: o.id, reference: o.reference, status: o.status, entity_status: o.entity_status, delivery_service: o.delivery_service },
          };
        }),
      }) as CourseLue;
      const alertes = () =>
        construireTableau({
          maintenant: MAINTENANT,
          reglages: { facteurRetard: 1.5, sansLivreurAlerteMin: 5, attenteAuRestaurantMin: 15, positionExpireeMin: 5 },
          restaurants: [{ id: RESTO, nom: 'Zone 4' }],
          livreurs: [],
          courses: [lue()],
          aEncaisser: [],
          livrees: [],
          planning: { jour: new Date('2026-10-22T00:00:00.000Z'), plans: [], repos: [], absents: [] },
        }).signaux.filter((s) => s.cle === 'LIVRAISON_ANNULEE_PAR_LIVREUR');

      expect(alertes()).toEqual([expect.objectContaining({ commandes_ids: [a.id] })]);

      await relancer(a.id);

      expect(alertes()).toEqual([]);
    });
  });

  describe('12. la suite', () => {
    it('payée : code juste, livrée, commande terminée, course finie, livreur remis dans la file', async () => {
      const { d1, a, la, relancer, annuler, livraisons, neuve, file } = enTournee({ seulementA: true });
      await annuler(la.id);
      await relancer(a.id);
      const n = neuve();
      file.onComplete.mockClear();

      await livraisons.markArrived(la.id, d1.id);
      await livraisons.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);

      expect(la.statut).toBe(DeliveryStatut.DELIVERED);
      expect(a.status).toBe(OrderStatus.COMPLETED);
      expect(n.statut).toBe(CourseStatut.COMPLETED);
      expect(file.onComplete).toHaveBeenCalledWith(d1.id);
      expect(d1.last_available_at).toEqual(MAINTENANT);
    });

    it('non payée : livrée, commande collectée, paiement en attente (encaissement à la livraison, comme toujours)', async () => {
      const { d1, a, la, t, relancer, annuler, livraisons } = enTournee({ seulementA: true, surchargeA: { paied: false } });
      const paiements: any[] = [];
      t.base.prisma.paiement = {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => {
          paiements.push(data);
          return data;
        }),
      };
      await annuler(la.id);
      await relancer(a.id);
      expect(paiements).toHaveLength(0);

      await livraisons.markArrived(la.id, d1.id);
      await livraisons.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);

      expect(a.status).toBe(OrderStatus.COLLECTED);
      expect(a.paied).toBe(false);
      expect(paiements).toEqual([expect.objectContaining({ order_id: a.id, status: 'PENDING', amount: 6000 })]);
    });

    it('nouvel « Annuler » possible, puis nouvelle relance ; « Plus tard » de nouveau possible', async () => {
      const b = enTournee({ surchargeB: { paied: true } });
      const { d1, a, la, lb, t, relancer, annuler, livraisons } = b;
      // A passée à plus tard (B démarre), B livrée, A reprise puis annulée.
      await livraisons.reporterLivraison(la.id, d1.id);
      expect(la.reportee_at).toEqual(MAINTENANT);
      expect(lb.statut).toBe(DeliveryStatut.IN_ROUTE);
      await livraisons.markArrived(lb.id, d1.id);
      await livraisons.confirmDelivery(lb.id, d1.id, { pin: '7733' } as never);
      await livraisons.startDelivery(la.id, d1.id);
      await annuler(la.id);

      const premiere = await relancer(a.id);
      expect(premiere).toMatchObject({ nouvelle_course: true, demarree: true });
      // « Plus tard » de nouveau possible une fois.
      expect(la.reportee_at).toBeNull();

      // Nouvel « Annuler » (nouveau ticket, nouvelle alerte), puis nouvelle relance.
      await annuler(la.id);
      expect(la.statut).toBe(DeliveryStatut.FAILED);
      expect(t.journalDe('LIVRAISON_ANNULEE')).toHaveLength(2);
      const seconde = await relancer(a.id);
      expect(seconde).toMatchObject({ deja: false, nouvelle_course: true });
      expect(t.journalDe('LIVRAISON_RELANCEE')).toHaveLength(2);
      expect(la.statut).toBe(DeliveryStatut.IN_ROUTE);
      expect(b.coursesActives()).toHaveLength(1);
    });
  });
});

describe('règles pures de la relance', () => {
  const etat = (s: Record<string, unknown> = {}) => ({
    status: DelivererStatus.ACTIVE,
    is_operational: true,
    entity_status: EntityStatus.ACTIVE,
    pause_until: null,
    auto_pause_until: null,
    last_available_at: avant(60),
    en_course: false,
    offre_en_attente: false,
    appli_active: true,
    restaurant_id: RESTO,
    ...s,
  });

  it('refusLivreurRelance : appli fermée, connexion coupée, en appel ne refusent jamais', () => {
    expect(refusLivreurRelance(etat({ appli_active: false, appli_fermee_prouvee: true }) as never, [], MAINTENANT)).toBeNull();
    expect(refusLivreurRelance(etat({ appli_active: false }) as never, [], MAINTENANT)).toBeNull();
    expect(refusLivreurRelance(etat({ en_appel: true }) as never, [], MAINTENANT)).toBeNull();
    // Appli fermée ET injoignable : injoignable refuse.
    expect(refusLivreurRelance(etat({ appli_active: false, joignable: false }) as never, [], MAINTENANT)?.motif).toBe('INJOIGNABLE');
    expect(refusLivreurRelance(null, [], MAINTENANT)?.motif).toBe('INACTIF');
    expect(
      refusLivreurRelance(etat({ pause_until: apres(60) }) as never, [{ statut: CourseStatut.IN_DELIVERY }], MAINTENANT),
    ).toBeNull();
    expect(
      refusLivreurRelance(etat() as never, [{ statut: CourseStatut.IN_DELIVERY }, { statut: CourseStatut.ACCEPTED }], MAINTENANT)?.motif,
    ).toBe('VA_AU_RESTAURANT');
  });

  it('rangsApresRelance : terminées, autres à faire, la relancée, annulées', () => {
    const l = (id: string, statut: DeliveryStatut, sequence_order: number) => ({ id, statut, sequence_order });
    const rangs = rangsApresRelance(
      [
        l('annulee', DeliveryStatut.CANCELLED, 1),
        l('afaire', DeliveryStatut.PENDING, 2),
        l('livree', DeliveryStatut.DELIVERED, 3),
        l('relancee', DeliveryStatut.FAILED, 4),
        l('enroute', DeliveryStatut.IN_ROUTE, 5),
        l('echec', DeliveryStatut.FAILED, 6),
      ],
      'relancee',
    );
    expect([...rangs.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id)).toEqual([
      'livree',
      'echec',
      'afaire',
      'enroute',
      'relancee',
      'annulee',
    ]);
  });

  it('aDemarrerApresRelance et « en dernier »', () => {
    const remise = { status: OrderStatus.PICKED_UP };
    expect(aDemarrerApresRelance({ nouvelle: true, parti_at: null, autres: [] })).toBe(true);
    expect(aDemarrerApresRelance({ nouvelle: false, parti_at: null, autres: [] })).toBe(false);
    expect(aDemarrerApresRelance({ nouvelle: false, parti_at: MAINTENANT, autres: [] })).toBe(true);
    expect(
      aDemarrerApresRelance({ nouvelle: false, parti_at: MAINTENANT, autres: [{ statut: DeliveryStatut.PENDING, order: remise }] }),
    ).toBe(false);
    expect(
      aDemarrerApresRelance({
        nouvelle: false,
        parti_at: MAINTENANT,
        autres: [{ statut: DeliveryStatut.PENDING, order: { status: OrderStatus.READY } }, { statut: DeliveryStatut.DELIVERED, order: remise }],
      }),
    ).toBe(true);
    expect(aDemarrerApresRelance({ nouvelle: false, parti_at: MAINTENANT, autres: [{ statut: DeliveryStatut.ARRIVED, order: remise }] })).toBe(false);
    expect(relanceeEnDernier(false, [{ statut: DeliveryStatut.IN_ROUTE }])).toBe(true);
    expect(relanceeEnDernier(true, [{ statut: DeliveryStatut.PENDING }])).toBe(false);
    expect(relanceeEnDernier(false, [{ statut: DeliveryStatut.DELIVERED }])).toBe(false);
  });
});
