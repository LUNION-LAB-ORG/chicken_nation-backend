/**
 * RELECTURE DU 23/10 : les constats du serveur, chacun avec un test qui
 * échoue sans sa correction. Les VRAIS services sur la base simulée
 * (banc-planificateur.simulee-spec.ts), Google coupé, aucun appel sortant.
 *
 *  - Turbo muet : le passage ne l'attend pas plus de 15 s, les autres
 *    restaurants passent ; aucune action commencée après 40 s de passage ;
 *  - repli v1 : les commandes prêtes laissées sans lot ni course par v2
 *    repartent dans l'ancien regroupement ;
 *  - deux serveurs : un événement reçu pendant le passage de l'autre serveur
 *    est rejoué une seconde plus tard ;
 *  - cloche « aucun livreur » après la bascule vers Turbo sous v2 ;
 *  - retenue d'une course acceptée annoncée à l'arrivée au comptoir, pas sur
 *    la route ;
 *  - offre d'un livreur lointain reprise pour le livreur du comptoir ;
 *  - écran Opérations et caisse prévenus en direct quand une offre est
 *    proposée, refusée, expirée ou close, et quand des courses fusionnent.
 */
import { CourseOfferStatus, CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { CourseChannels } from '../enums/course-channels';
import { CourseListenerService } from '../listeners/course.listener.service';
import { RetenueALArriveeListener } from '../listeners/retenue-a-l-arrivee.listener';
import { SuiviOffresListener } from '../listeners/suivi-offres.listener';
import { CourseWebSocketService } from '../websockets/course-websocket.service';
import { DELAI_ENVOI_TURBO_MS } from './application-plan.service';
import { course, livraison, livreur, offre, RESTO } from './base-dispatch.simulee-spec';
import { apres, AU_COMPTOIR, avant, B, LOIN, MAINTENANT, monter, prete } from './banc-planificateur.simulee-spec';
import { DELAI_COMMANDE_SANS_LOT_MS, DELAI_NOUVELLE_DEMANDE_MS } from './course-planificateur.service';

// Horloge simulée : rien n'attend vraiment, mais une machine très chargée
// (suite complète en parallèle) peut dépasser les 5 s par défaut.
jest.setTimeout(30_000);

/** Laisse passer les promesses en attente (setImmediate n'est pas simulé). */
const laisserPasser = async (n = 60) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Turbo muet pendant un passage', () => {
  function enAttenteDeTurbo() {
    const a = prete({ ready_at: avant(7 * 60) });
    const k = course({ created_at: avant(7 * 60) });
    const t = monter({ commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [] });
    let repondre!: (v: unknown) => void;
    t.turbo.creerCourseGroupe.mockImplementation(() => new Promise((r) => (repondre = r)) as never);
    return { a, k, t, repondre: (v: unknown) => repondre(v) };
  }

  it('le passage n’attend pas Turbo plus de 15 s : le restaurant suivant passe, l’issue tardive est journalisée', async () => {
    const { a, k, t, repondre } = enAttenteDeTurbo();
    const lus: string[] = [];
    const lire = t.instantanes.lire.bind(t.instantanes);
    jest.spyOn(t.instantanes, 'lire').mockImplementation(async (id, ...reste) => {
      lus.push(id);
      return lire(id, ...reste);
    });
    const passage = jest.spyOn(t.planificateur, 'planifierRestaurant');

    void t.planificateur.enfiler(RESTO, ['TACHE']);
    void t.planificateur.enfiler('restaurant-2', ['COMMANDE_READY']);
    await laisserPasser();
    expect(t.turbo.creerCourseGroupe).toHaveBeenCalledTimes(1);
    expect(lus).toEqual([RESTO]);

    await jest.advanceTimersByTimeAsync(DELAI_ENVOI_TURBO_MS + 100);
    await laisserPasser();
    expect(lus).toEqual([RESTO, 'restaurant-2']);
    const resultat = await passage.mock.results[0].value;
    expect(resultat.abandonnees).toContainEqual({ type: 'CONFIER_TURBO', motif: 'TURBO_SANS_REPONSE' });
    expect(t.base.verrousTenus.size).toBe(0);
    // Réservée : jamais un second envoi pendant que le premier attend.
    expect(k.turbo_escalated_at).toBeTruthy();

    repondre({ sentOrderIds: [a.id] });
    await laisserPasser();
    expect(t.journalDe('TURBO_PLANIFIE')).toEqual([
      expect.objectContaining({ motif: 'CONFIEE', details: expect.objectContaining({ reponse_tardive: true }) }),
    ]);
  });

  it('passage trop long (verrou bientôt rendu) : plus aucune action commencée après 40 s', async () => {
    const t = monter({ commandes: [prete()], livreurs: [livreur(AU_COMPTOIR)] });
    const lire = t.instantanes.lire.bind(t.instantanes);
    jest.spyOn(t.instantanes, 'lire').mockImplementationOnce(async (...args) => {
      const lu = await lire(...args);
      jest.setSystemTime(apres(41)); // lecture très lente
      return lu;
    });

    const resultat = await t.passer();

    expect(resultat?.appliquees).toEqual([]);
    expect(resultat?.abandonnees).toEqual([
      { type: 'CREER_COURSE', motif: 'PASSAGE_TROP_LONG' },
      { type: 'OFFRIR', motif: 'PASSAGE_TROP_LONG' },
    ]);
    expect(t.base.courses).toHaveLength(0);
  });
});

describe('repli v1 : commandes prêtes laissées sans lot ni course par v2', () => {
  it('passage v2 en échec, puis retour à v1 : la commande prête repart dans un lot', async () => {
    const a = prete({ ready_at: avant(30) });
    const t = monter({ commandes: [a], livreurs: [livreur(AU_COMPTOIR)] });
    jest.spyOn(t.instantanes, 'lire').mockRejectedValueOnce(new Error('panne'));
    await t.planificateur.enfiler(RESTO, ['COMMANDE_READY']);
    expect(t.base.livraisons).toHaveLength(0);

    t.valeurs['course.planificateur'] = 'v1';
    // Moins d'une minute après : c'est encore au pont des commandes de v1.
    expect(await t.passer()).toBeNull();
    expect(t.regroupement.tryGroupOrder).not.toHaveBeenCalled();

    jest.setSystemTime(apres(DELAI_COMMANDE_SANS_LOT_MS / 1000));
    const r = await t.passer();
    expect(r?.rendues_aux_lots).toBe(1);
    expect(t.regroupement.tryGroupOrder).toHaveBeenCalledWith(a.id);

    // Déjà dans un lot : plus rien.
    a.batch_id = 'lot';
    expect(await t.passer()).toBeNull();
    expect(t.regroupement.tryGroupOrder).toHaveBeenCalledTimes(1);
  });
});

describe('deux serveurs : demande reçue pendant le passage de l’autre', () => {
  it('le serveur qui trouve le verrou pris redemande une seconde plus tard : la commande prête a sa course', async () => {
    const a = prete({ ready_at: avant(30) });
    const b = prete({ address: B, status: OrderStatus.IN_PROGRESS, ready_at: null, prepared_at: avant(600) });
    const t = monter({ commandes: [a, b], livreurs: [livreur(AU_COMPTOIR), livreur(AU_COMPTOIR)] });
    const serveur2 = t.nouveauPlanificateur();

    let reprendre!: () => void;
    const lire = t.instantanes.lire.bind(t.instantanes);
    jest.spyOn(t.instantanes, 'lire').mockImplementationOnce(async (...args) => {
      const lu = await lire(...args); // le serveur 1 lit : b encore en cuisine
      await new Promise<void>((r) => (reprendre = r));
      return lu;
    });

    const p1 = t.passer();
    await laisserPasser();
    b.status = OrderStatus.READY;
    b.ready_at = new Date();
    b.updated_at = new Date();
    const r2 = await serveur2.planifierRestaurant(RESTO, 'COMMANDE_READY');
    expect(r2?.verrou).toBe(false);
    reprendre();
    await p1;
    expect(t.base.livraisons.some((l) => l.order_id === b.id)).toBe(false);

    await jest.advanceTimersByTimeAsync(DELAI_NOUVELLE_DEMANDE_MS + 600);
    await (serveur2 as unknown as { file: Promise<unknown> }).file;
    await laisserPasser();
    expect(t.base.livraisons.some((l) => l.order_id === b.id)).toBe(true);
    serveur2.onModuleDestroy();
  });
});

describe('cloche « aucun livreur » sous v2 : après la bascule vers Turbo', () => {
  function sansLivreur(reglages: Record<string, string> = {}) {
    const a = prete({ ready_at: avant(5 * 60 + 10) });
    const k = course({ created_at: avant(5 * 60 + 10) });
    const t = monter(
      { commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [livreur({ last_available_at: null })] },
      { reglages },
    );
    return { k, t, cloche: () => (t.offres as unknown as { notificationsSender: { sendCourseNoDelivererBell: jest.Mock } }).notificationsSender.sendCourseNoDelivererBell };
  }

  it('Turbo actif : pas de cloche à 5 min (Turbo passe à 6), cloche à 7 min si personne ne l’a prise', async () => {
    const { k, t, cloche } = sansLivreur();
    await t.offres.retryUnassignedCourses();
    expect(k.no_deliverer_alerted_at).toBeNull();
    expect(cloche()).not.toHaveBeenCalled();

    jest.setSystemTime(apres(2 * 60));
    await t.offres.retryUnassignedCourses();
    expect(k.no_deliverer_alerted_at).toEqual(apres(2 * 60));
    expect(cloche()).toHaveBeenCalledTimes(1);
  });

  it('Turbo coupé : la cloche sonne à 5 min comme avant', async () => {
    const { k, t } = sansLivreur({ 'course.turbo_fallback_enabled': '0' });
    await t.offres.retryUnassignedCourses();
    expect(k.no_deliverer_alerted_at).toEqual(MAINTENANT);
  });
});

describe('retenue d’une course acceptée : annoncée à l’arrivée au comptoir, jamais sur la route', () => {
  it('livreur en route : retenue posée sans « Attends » ; à son arrivée : « Attends 2 min », minutes comptées de là', async () => {
    const enRoute = livreur({
      last_location: { lat: 5.286, lng: -3.9737 + 0.4 / 110.8 }, // 400 m
      last_location_at: avant(20),
      last_available_at: null,
      protocole_appli: 3,
    });
    const a = prete();
    const b = prete({ address: B, status: OrderStatus.IN_PROGRESS, ready_at: null, prepared_at: avant(600), estimated_preparation_time: apres(180) });
    const k = course({ statut: CourseStatut.ACCEPTED, deliverer_id: enRoute.id, assigned_at: avant(60), created_at: avant(120) });
    const t = monter({ commandes: [a, b], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [enRoute] });

    await t.passer();
    expect(k.retenue_jusqua).toEqual(apres(180));
    expect(t.push.notifyCourseAttente).not.toHaveBeenCalled();

    // Arrivé au comptoir 60 s plus tard (route de l'appli) : annoncée, 2 min.
    jest.setSystemTime(apres(60));
    await t.actions.markAtRestaurant(k.id, enRoute.id);
    const arrivee = t.emisSur(CourseChannels.COURSE_STATUT_CHANGED).find((e) => e.new_statut === CourseStatut.AT_RESTAURANT);
    const ecouteur = new RetenueALArriveeListener(t.push as never);
    expect(ecouteur.onStatut(arrivee, new Date())).toBe(true);
    expect(t.push.notifyCourseAttente).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: enRoute.id, courseId: k.id, titre: 'Attends 2 min', attendues: [b.reference] }),
    );

    // Course sans retenue, ou retenue échue : rien.
    expect(ecouteur.onStatut({ ...arrivee, course: { ...arrivee.course, retenue_jusqua: avant(1) } }, new Date())).toBe(false);
  });

  it('la commande attendue est prête avant son arrivée : « Commande ajoutée », jamais « Tout est prêt » sur la route', async () => {
    const enRoute = livreur({
      last_location: { lat: 5.286, lng: -3.9737 + 0.4 / 110.8 },
      last_location_at: avant(20),
      last_available_at: null,
      protocole_appli: 3,
    });
    const a = prete();
    const b = prete({ address: B, status: OrderStatus.IN_PROGRESS, ready_at: null, prepared_at: avant(600), estimated_preparation_time: apres(180) });
    const k = course({ statut: CourseStatut.ACCEPTED, deliverer_id: enRoute.id, assigned_at: avant(60), created_at: avant(120) });
    const t = monter({ commandes: [a, b], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [enRoute] });
    await t.passer();
    expect(k.retenue_jusqua).toEqual(apres(180));

    // B sort de cuisine pendant qu'il roule encore vers le restaurant.
    jest.setSystemTime(apres(60));
    b.status = OrderStatus.READY;
    b.ready_at = new Date();
    b.updated_at = new Date();
    const r = await t.passer();

    expect(r?.appliquees).toEqual(expect.arrayContaining(['AJOUTER', 'LIBERER']));
    expect(t.push.notifyCourseToutPret).not.toHaveBeenCalled();
    expect(t.push.notifyCourseAttente).not.toHaveBeenCalled();
    expect(t.push.notifyCommandeAjoutee).toHaveBeenCalledTimes(1);
    expect(t.push.notifyCommandeAjoutee).toHaveBeenCalledWith(expect.objectContaining({ delivererId: enRoute.id, courseId: k.id, total: 2 }));
  });
});

describe('zéro temps mort : offre d’un livreur lointain reprise pour le livreur du comptoir', () => {
  function offreLointaine() {
    const loin = livreur({ ...LOIN, last_available_at: avant(3000) });
    const comptoir = livreur({ ...AU_COMPTOIR, last_available_at: avant(60) });
    const a = prete();
    const k = course({ created_at: avant(60) });
    const o = offre({ course_id: k.id, deliverer_id: loin.id, offered_at: avant(20), expires_at: apres(100) });
    const t = monter({ commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [loin, comptoir], offres: [o] });
    return { loin, comptoir, k, o, t };
  }

  it('offre close sans pénalité (« Course retirée » sur l’appli), course proposée au comptoir', async () => {
    const { loin, comptoir, k, o, t } = offreLointaine();

    const resultat = await t.passer();

    expect(resultat?.appliquees).toEqual(['REPRENDRE_OFFRE', 'OFFRIR']);
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
    expect(k.refusal_count).toBe(0);
    expect(t.emisSur(CourseChannels.COURSE_OFFER_EXPIRED)).toContainEqual(
      expect.objectContaining({ course_id: k.id, deliverer_id: loin.id, motif: 'COURSE_REPRISE' }),
    );
    expect(t.journalDe('OFFRE_CLOSE')).toEqual([expect.objectContaining({ motif: 'COURSE_REPRISE', deliverer_id: loin.id })]);
    expect(t.base.offres.filter((x) => x.status === CourseOfferStatus.PENDING)).toEqual([
      expect.objectContaining({ course_id: k.id, deliverer_id: comptoir.id }),
    ]);
  });

  it('le livreur lointain accepte au même instant : il garde la course, rien n’est proposé au comptoir', async () => {
    const { loin, k, o, t } = offreLointaine();
    const lire = t.instantanes.lire.bind(t.instantanes);
    jest.spyOn(t.instantanes, 'lire').mockImplementationOnce(async (...args) => {
      const lu = await lire(...args);
      await t.garde.reserverAcceptation(k.id, loin.id);
      return lu;
    });

    const resultat = await t.passer();

    expect(resultat?.abandonnees).toContainEqual({ type: 'REPRENDRE_OFFRE', motif: 'OFFRE_CHANGEE' });
    expect(o.status).toBe(CourseOfferStatus.ACCEPTED);
    expect(k).toMatchObject({ statut: CourseStatut.ACCEPTED, deliverer_id: loin.id });
    expect(t.base.offres.filter((x) => x.status === CourseOfferStatus.PENDING)).toEqual([]);
  });
});

describe('écran Opérations et caisse à jour en direct', () => {
  /** Les vrais relais vers les sockets, branchés sur un faux gateway. */
  function relais(t: ReturnType<typeof monter>) {
    const sorties: { salle: string; canal: string; charge: any }[] = [];
    const gateway = {
      emitToBackoffice: (canal: string, charge: unknown) => sorties.push({ salle: 'siege', canal, charge }),
      emitToRestaurant: (id: string, canal: string, charge: unknown) => sorties.push({ salle: `restaurant:${id}`, canal, charge }),
      emitToDeliverer: (id: string, canal: string, charge: unknown) => sorties.push({ salle: `livreur:${id}`, canal, charge }),
    };
    const ws = new CourseWebSocketService(gateway as never);
    const sockets = new CourseListenerService(ws);
    const ecrans = new SuiviOffresListener(t.base.prisma, ws);
    let vus = 0;
    /** Relaie aux sockets les événements émis depuis le dernier appel. */
    const relayer = async () => {
      for (const { canal, charge } of t.emis.slice(vus)) {
        if (canal === CourseChannels.COURSE_OFFER_NEW) {
          sockets.onOfferNew(charge);
          await ecrans.onProposee(charge);
        } else if (canal === CourseChannels.COURSE_OFFER_EXPIRED) {
          sockets.onOfferExpired(charge);
          await ecrans.onExpiree(charge);
        } else if (canal === CourseChannels.COURSE_OFFER_REFUSED) {
          await ecrans.onRefusee(charge);
        } else if (canal === CourseChannels.COURSE_STATUT_CHANGED) {
          sockets.onStatutChanged(charge);
        } else if (canal === CourseChannels.COURSE_CANCELLED) {
          sockets.onCancelled(charge);
        } else if (canal === CourseChannels.DELIVERY_STATUT_CHANGED) {
          sockets.onDeliveryStatutChanged(charge);
        }
      }
      vus = t.emis.length;
    };
    const raisons = (salle: string) =>
      sorties.filter((s) => s.salle === salle && s.canal === CourseChannels.COURSE_STATUT_CHANGED).map((s) => s.charge.reason);
    return { sorties, relayer, raisons };
  }

  it('offre proposée, refusée, expirée, close : `course:statut:changed` au siège et au restaurant, jamais au livreur', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: avant(600) });
    const d2 = livreur({ ...AU_COMPTOIR, last_available_at: avant(60) });
    const t = monter({ commandes: [prete()], livreurs: [d1, d2] });
    const r = relais(t);

    await t.passer(); // course créée, proposée à d1
    const [k] = t.coursesOuvertes();
    await r.relayer();
    // (l'offre part pendant le passage, la course créée est annoncée à sa fin)
    expect(r.raisons('siege').sort()).toEqual(['COURSE_CREEE', 'OFFRE_PROPOSEE']);
    expect(r.raisons(`restaurant:${RESTO}`).sort()).toEqual(['COURSE_CREEE', 'OFFRE_PROPOSEE']);
    const proposee = r.sorties.find((s) => s.charge?.reason === 'OFFRE_PROPOSEE')!;
    expect(proposee.charge).toMatchObject({ course: expect.objectContaining({ id: k.id }), offre: expect.objectContaining({ deliverer_id: d1.id }) });

    // Refus : proposée au suivant.
    await t.actions.refuseOffer(k.id, d1.id, { reason: 'Trop loin' } as never);
    await t.passer();
    await r.relayer();
    expect(r.raisons('siege').slice(2)).toEqual(['OFFRE_REFUSEE', 'OFFRE_PROPOSEE']);

    // Laissée sans réponse jusqu'à l'échéance.
    jest.setSystemTime(apres(10 * 60));
    await t.offres.expirePendingOffers();
    await r.relayer();
    expect(r.raisons('siege').slice(4)).toEqual(['OFFRE_EXPIREE']);

    // Close par le serveur (ici : course annulée pendant une offre).
    t.base.offres.push(offre({ course_id: k.id, deliverer_id: d2.id, offered_at: new Date(), expires_at: apres(10 * 60 + 120) }));
    await t.cloture.clorePourCourse(k.id, 'COURSE_ANNULEE', { relancerRecherche: false });
    await r.relayer();
    expect(r.raisons(`restaurant:${RESTO}`)).toContain('OFFRE_CLOSE');
    expect(r.sorties.find((s) => s.charge?.reason === 'OFFRE_CLOSE')!.charge.offre).toMatchObject({ motif: 'COURSE_ANNULEE' });

    // Jamais vers la salle d'un livreur.
    expect(r.sorties.filter((s) => s.salle.startsWith('livreur:') && /^OFFRE_/.test(s.charge?.reason ?? ''))).toEqual([]);
  });

  it('livraison démarrée : `course:delivery:statut:changed` au siège ET au restaurant, sans le code du client', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 3 });
    const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(60) });
    const k = course({
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: d1.id,
      assigned_at: avant(300),
      picked_up_at: avant(60),
      parti_at: avant(5),
      created_at: avant(400),
    });
    const t = monter({ commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [d1] });
    const r = relais(t);

    await t.depart.demarrerPremiereLivraison(k.id);
    await r.relayer();

    const sorties = r.sorties.filter((s) => s.canal === CourseChannels.DELIVERY_STATUT_CHANGED);
    expect(sorties.map((s) => s.salle)).toEqual(['siege', `restaurant:${RESTO}`]);
    expect(sorties[1].charge).toMatchObject({ course_id: k.id, restaurant_id: RESTO, new_statut: DeliveryStatut.IN_ROUTE });
    expect(sorties[1].charge.delivery).toMatchObject({ order_id: a.id, statut: DeliveryStatut.IN_ROUTE });
    expect('delivery_pin' in sorties[1].charge.delivery).toBe(false);
  });

  it('fusion : la course cible (« fusionnées ») et la course absorbée (annulée) au siège et au restaurant', async () => {
    const a = prete({ ready_at: avant(120) });
    const b = prete({ address: B, ready_at: avant(60) });
    const k1 = course({ created_at: avant(110) });
    const k2 = course({ created_at: avant(50) });
    const t = monter({
      commandes: [a, b],
      courses: [k1, k2],
      livraisons: [livraison({ course_id: k1.id, order_id: a.id }), livraison({ course_id: k2.id, order_id: b.id })],
      livreurs: [livreur({ ...AU_COMPTOIR, last_available_at: avant(600) })],
    });
    const r = relais(t);

    await t.passer();
    await r.relayer();

    for (const salle of ['siege', `restaurant:${RESTO}`]) {
      expect(r.sorties).toContainEqual(
        expect.objectContaining({ salle, canal: CourseChannels.COURSE_STATUT_CHANGED, charge: expect.objectContaining({ reason: 'COURSES_FUSIONNEES' }) }),
      );
      expect(r.sorties).toContainEqual(expect.objectContaining({ salle, canal: CourseChannels.COURSE_CANCELLED }));
      expect(r.raisons(salle)).toContain('OFFRE_PROPOSEE');
    }
  });
});
