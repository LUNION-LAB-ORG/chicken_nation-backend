/**
 * PLANIFICATEUR v2, côté service : les VRAIS services (instantané, règle,
 * application, offres, gardes, clôture, journal, départ) sur une base
 * simulée qui évalue les `where`, annule les transactions et tient les
 * verrous consultatifs (banc-planificateur.simulee-spec.ts). Google coupé
 * (`course.direction_google` = 0) : la règle de direction passe par son
 * repli sans carte, comme sur le banc local.
 *
 * Restaurant Zone 4 (5.286, -3.9737). Clients sur l'axe est : A à 2 km,
 * B à 4 km (même direction) ; O à 2 km à l'ouest (sens opposé).
 */
import { ConflictException } from '@nestjs/common';
import { CourseBatchStatus, CourseOfferStatus, CourseStatut, DeliveryService, DeliveryStatut, OrderStatus } from '@prisma/client';

import { evaluer } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { CourseChannels } from '../enums/course-channels';
import { DispatchEvenements } from '../enums/dispatch-evenements';
import { whereCoursesARemettre } from '../helpers/code-retrait.rules';
import { journeeDeService } from '../helpers/journee-service.rules';
import { CLASSE_VERROU_PLANIFICATEUR } from '../helpers/planification.rules';
import { OrderBridgeListenerService } from '../listeners/order-bridge.listener.service';
import { CourseBatchTask } from '../tasks/course-batch.task';
import { commande, course, DonneesDispatch, livraison, livreur, monterBaseDispatch, offre, RESTO } from './base-dispatch.simulee-spec';
import { A, apres, AU_COMPTOIR, avant, B, LOIN, MAINTENANT, monter, O, prete } from './banc-planificateur.simulee-spec';
import { MARGE_REVEIL_RETENUE_MS } from './course-planificateur.service';
import { LotsV2Service } from './lots-v2.service';

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('commande prête : course créée tout de suite, proposée au livreur au comptoir', () => {
  it('une course, une offre au livreur au comptoir (pas au plus ancien de la file), annoncée au restaurant', async () => {
    const a = prete();
    const loin = livreur({ ...LOIN, last_available_at: avant(3600) });
    const comptoir = livreur({ ...AU_COMPTOIR, last_available_at: avant(60) });
    const t = monter({ commandes: [a], livreurs: [loin, comptoir] });

    const resultat = await t.passer();

    expect(resultat?.verrou).toBe(true);
    expect(resultat?.appliquees).toEqual(['CREER_COURSE', 'OFFRIR']);
    const [k] = t.coursesOuvertes();
    expect(k.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
    expect(k.pickup_code).toMatch(/^\d{3}$/);
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id]);
    expect(t.base.offres).toEqual([
      expect.objectContaining({ course_id: k.id, deliverer_id: comptoir.id, status: CourseOfferStatus.PENDING }),
    ]);
    expect(t.journalDe('OFFRE_PLANIFIEE')[0]).toMatchObject({ motif: 'AU_COMPTOIR', deliverer_id: comptoir.id });
    expect(t.journalDe('COURSE_CREEE')).toHaveLength(1);
    // Code visible dès la création : course:statut:changed vers le restaurant et le siège.
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED)).toEqual([
      expect.objectContaining({ reason: 'COURSE_CREEE', course: expect.objectContaining({ id: k.id }) }),
    ]);
    expect(t.push.notifyNewCourseOffer).toHaveBeenCalledWith(expect.objectContaining({ delivererId: comptoir.id }));
    // Verrou du planificateur pris sur le restaurant, classe à part.
    expect(t.base.verrous).toContainEqual([CLASSE_VERROU_PLANIFICATEUR, RESTO]);
  });

  it('deux commandes prêtes de la même direction : une seule course, ordre restaurant → A → B', async () => {
    const b = prete({ address: B, ready_at: avant(40) });
    const a = prete({ address: A });
    const t = monter({ commandes: [b, a], livreurs: [livreur(AU_COMPTOIR)] });

    await t.passer();

    const [k] = t.coursesOuvertes();
    expect(t.coursesOuvertes()).toHaveLength(1);
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id, b.id]);
    expect(k.total_delivery_fee).toBe(2000);
    expect(k.motif_regroupement).toBeTruthy();
  });

  it('sens opposés : jamais dans la même course', async () => {
    const t = monter({ commandes: [prete(), prete({ address: O })], livreurs: [livreur(AU_COMPTOIR)] });
    await t.passer();
    expect(t.coursesOuvertes()).toHaveLength(2);
  });

  it('aucun livreur libre : la course attend, sans offre ni Turbo avant 6 min', async () => {
    const t = monter({ commandes: [prete()], livreurs: [livreur({ last_available_at: null })] });
    await t.passer();
    expect(t.coursesOuvertes()).toHaveLength(1);
    expect(t.base.offres).toHaveLength(0);
    expect(t.turbo.creerCourseGroupe).not.toHaveBeenCalled();
  });
});

describe('demande 4 : fusion automatique des courses non affectées, puis offre immédiate', () => {
  function deuxCoursesEnAttente() {
    const a = prete({ ready_at: avant(120) });
    const b = prete({ address: B, ready_at: avant(60) });
    const k1 = course({ created_at: avant(110) });
    const k2 = course({ created_at: avant(50) });
    const enRoute = livreur({ ...LOIN, last_available_at: avant(3000) });
    const comptoir = livreur({ ...AU_COMPTOIR, last_available_at: avant(600) });
    const offreK1 = offre({ course_id: k1.id, deliverer_id: enRoute.id, offered_at: avant(100), expires_at: apres(20) });
    const donnees: DonneesDispatch = {
      commandes: [a, b],
      courses: [k1, k2],
      livraisons: [
        livraison({ course_id: k1.id, order_id: a.id, sequence_order: 1 }),
        livraison({ course_id: k2.id, order_id: b.id, sequence_order: 1 }),
      ],
      livreurs: [enRoute, comptoir],
      offres: [offreK1],
    };
    return { a, b, k1, k2, enRoute, comptoir, offreK1, donnees };
  }

  it('la course sans livreur est absorbée, son offre close sans pénalité, la course fusionnée proposée au livreur au comptoir', async () => {
    const s = deuxCoursesEnAttente();
    const t = monter(s.donnees);

    const resultat = await t.passer();

    expect(resultat?.appliquees).toEqual(expect.arrayContaining(['FUSIONNER', 'ORDONNER', 'OFFRIR']));
    // K1 absorbée par K2 (qui part le plus tôt : livreur au comptoir).
    expect(s.k1.statut).toBe(CourseStatut.CANCELLED);
    expect(s.k1.cancelled_reason).toContain('Fusionnée');
    expect(t.livraisonsDe(s.k2.id).map((l) => l.order_id)).toEqual([s.a.id, s.b.id]);
    expect(s.k2.total_delivery_fee).toBe(2000);
    expect(s.k1.total_delivery_fee).toBe(0);
    // Offre de la course absorbée : close, sans pénalité ni refus compté, et l'appli la ferme.
    expect(s.offreK1.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
    expect(s.k1.refusal_count).toBe(0);
    expect(t.emisSur(CourseChannels.COURSE_OFFER_EXPIRED)).toContainEqual(
      expect.objectContaining({ course_id: s.k1.id, deliverer_id: s.enRoute.id, motif: 'COURSE_FUSIONNEE' }),
    );
    // Course fusionnée proposée tout de suite, au livreur au comptoir.
    expect(t.base.offres.filter((o) => o.status === CourseOfferStatus.PENDING)).toEqual([
      expect.objectContaining({ course_id: s.k2.id, deliverer_id: s.comptoir.id }),
    ]);
    expect(t.journalDe('COURSES_FUSIONNEES')).toHaveLength(1);
    expect(t.emisSur(CourseChannels.COURSE_CANCELLED)).toContainEqual(
      expect.objectContaining({ course: expect.objectContaining({ id: s.k1.id }) }),
    );
  });

  it('fusion concurrente avec une acceptation : le livreur qui accepte au même instant garde sa course', async () => {
    const s = deuxCoursesEnAttente();
    const t = monter(s.donnees);
    // Le livreur accepte K1 entre la lecture de l'instantané et l'écriture du plan.
    const lire = t.instantanes.lire.bind(t.instantanes);
    jest.spyOn(t.instantanes, 'lire').mockImplementationOnce(async (...args) => {
      const lu = await lire(...args);
      await t.garde.reserverAcceptation(s.k1.id, s.enRoute.id);
      return lu;
    });

    const resultat = await t.passer();

    expect(resultat?.abandonnees).toContainEqual({ type: 'FUSIONNER', motif: 'COURSE_ABSORBEE_CHANGEE' });
    expect(s.k1).toMatchObject({ statut: CourseStatut.ACCEPTED, deliverer_id: s.enRoute.id });
    expect(s.offreK1.status).toBe(CourseOfferStatus.ACCEPTED);
    expect(t.livraisonsDe(s.k1.id).map((l) => l.order_id)).toEqual([s.a.id]);
    expect(t.livraisonsDe(s.k2.id).map((l) => l.order_id)).toEqual([s.b.id]);
    expect(t.journalDe('ACTION_ABANDONNEE')).toContainEqual(expect.objectContaining({ motif: 'FUSIONNER' }));
    // Jamais deux livreurs sur une commande.
    const parCommande = new Map<string, number>();
    for (const l of t.base.livraisons) parCommande.set(l.order_id, (parCommande.get(l.order_id) ?? 0) + 1);
    expect([...parCommande.values()].every((n) => n === 1)).toBe(true);
  });

  it('acceptation juste après la fusion : 409 « plus disponible », offre close sans pénalité', async () => {
    const s = deuxCoursesEnAttente();
    const t = monter(s.donnees);
    await t.passer();

    await expect(t.garde.reserverAcceptation(s.k1.id, s.enRoute.id)).rejects.toBeInstanceOf(ConflictException);
    expect(s.k1.statut).toBe(CourseStatut.CANCELLED);
    expect(s.k1.deliverer_id).toBeNull();
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
  });

  it('livreur qui se libère : la course en attente lui est proposée au passage suivant', async () => {
    const enCourse = livreur({ ...AU_COMPTOIR, last_available_at: null });
    const k = course({ created_at: avant(60) });
    const a = prete();
    const t = monter({
      commandes: [a],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [enCourse],
    });
    await t.passer();
    expect(t.base.offres).toHaveLength(0);

    enCourse.last_available_at = new Date(); // fin de livraison : remis dans la file
    await t.passer();
    expect(t.base.offres).toEqual([expect.objectContaining({ course_id: k.id, deliverer_id: enCourse.id })]);
  });
});

describe('deux serveurs', () => {
  it('le verrou du restaurant fait passer un seul planificateur ; le second ne refait rien ensuite', async () => {
    const a = prete();
    const t = monter({ commandes: [a], livreurs: [livreur(AU_COMPTOIR)] });
    const serveur2 = t.nouveauPlanificateur();

    const [r1, r2] = await Promise.all([t.passer(), t.passer(serveur2)]);

    expect([r1?.verrou, r2?.verrou].sort()).toEqual([false, true]);
    expect(t.coursesOuvertes()).toHaveLength(1);
    expect(t.base.offres).toHaveLength(1);
    expect(t.base.verrousTenus.size).toBe(0); // rendu à la fin de la transaction

    const r3 = await t.passer(serveur2);
    expect(r3?.appliquees).toEqual([]);
    expect(t.coursesOuvertes()).toHaveLength(1);
    expect(t.base.offres).toHaveLength(1);
  });
});

describe('ajout à une course ouverte avant le départ (3.7)', () => {
  it('course en recherche avec une offre : l’offre à jour est renvoyée au livreur sollicité, même échéance', async () => {
    const a = prete({ ready_at: avant(60) });
    const k = course({ created_at: avant(50) });
    const sollicite = livreur({ ...LOIN });
    const o = offre({ course_id: k.id, deliverer_id: sollicite.id, offered_at: avant(40), expires_at: apres(80) });
    const b = prete({ address: B, ready_at: avant(5) });
    const t = monter({
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [sollicite],
      offres: [o],
    });

    await t.passer();

    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id, b.id]);
    expect(t.livraisonsDe(k.id)[1].ajoutee_at).toEqual(MAINTENANT);
    expect(k.total_delivery_fee).toBe(2000);
    expect(o.status).toBe(CourseOfferStatus.PENDING);
    const renvoyees = t.emisSur(CourseChannels.COURSE_OFFER_NEW).filter((p) => p.renvoi);
    expect(renvoyees).toEqual([expect.objectContaining({ deliverer_id: sollicite.id, expires_at: o.expires_at })]);
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED)).toContainEqual(
      expect.objectContaining({ reason: 'COMMANDE_AJOUTEE' }),
    );
  });

  it('course acceptée : le livreur est prévenu (« Commande ajoutée », 2 commandes à prendre)', async () => {
    const d1 = livreur({ ...LOIN, last_available_at: null });
    const a = prete({ status: OrderStatus.READY });
    const k = course({ statut: CourseStatut.ACCEPTED, deliverer_id: d1.id, assigned_at: avant(120) });
    const b = prete({ address: B });
    const t = monter({
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d1],
    });

    await t.passer();

    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id, b.id]);
    expect(t.push.notifyCommandeAjoutee).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: d1.id, titre: 'Commande ajoutée', corps: '2 commandes à prendre', total: 2 }),
    );
  });

  it('jamais d’ajout à la course d’un livreur en pause', async () => {
    const d1 = livreur({ ...LOIN, last_available_at: null, pause_until: apres(3600) });
    const a = prete();
    const k = course({ statut: CourseStatut.ACCEPTED, deliverer_id: d1.id, assigned_at: avant(120) });
    const b = prete({ address: B });
    const t = monter({
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d1],
    });
    await t.passer();
    expect(t.livraisonsDe(k.id)).toHaveLength(1);
  });
});

describe('retenue au comptoir puis ajout dès que la commande est prête (3.5, 3.9)', () => {
  it('livreur au comptoir, B en cuisine finie dans 2 min : retenue, puis B ajoutée et « Tout est prêt »', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null });
    const a = prete({ ready_at: avant(10) });
    const b = commande({
      status: OrderStatus.IN_PROGRESS,
      address: B,
      created_at: avant(10 * 60),
      updated_at: avant(8 * 60),
      prepared_at: avant(8 * 60),
      estimated_preparation_time: apres(120), // saisie cuisine : prioritaire
    });
    const k = course({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: d1.id, assigned_at: avant(200), at_restaurant_at: avant(100) });
    const t = monter({
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d1],
    });

    await t.passer();

    expect(k.retenue_jusqua).toEqual(apres(120));
    expect(k.commandes_attendues).toEqual([expect.objectContaining({ order_id: b.id, reference: b.reference })]);
    expect(t.push.notifyCourseAttente).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: d1.id, titre: 'Attends 2 min', corps: 'Départ 15 h 32' }),
    );

    // B prête 90 s plus tard : ajoutée dans la seconde, la retenue levée.
    jest.setSystemTime(apres(90));
    b.status = OrderStatus.READY;
    b.ready_at = new Date();
    await t.passer();

    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id, b.id]);
    expect(k.commandes_attendues).toEqual([]);
    expect(k.retenue_jusqua!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(t.journalDe('RETENUE_LEVEE')[0]).toMatchObject({ motif: 'TOUT_PRET' });
    // Une seule notification pour ce passage : « Tout est prêt ».
    expect(t.push.notifyCourseToutPret).toHaveBeenCalledWith(
      expect.objectContaining({ titre: 'Tout est prêt', corps: `2 commandes · code ${k.pickup_code}` }),
    );
    expect(t.push.notifyCommandeAjoutee).not.toHaveBeenCalled();
    // L'événement du passage annonce l'ajout (raison la plus utile), pas la levée de la retenue.
    const evenements = t.emisSur(CourseChannels.COURSE_STATUT_CHANGED).filter((e) => e.course.id === k.id);
    expect(evenements[evenements.length - 1]).toMatchObject({ reason: 'COMMANDE_AJOUTEE' });
  });
});

describe('échéance de la retenue : réveil programmé, sans attendre la tâche de 10 s (banc du 23/10)', () => {
  it('B toujours en cuisine à l’échéance : la retenue est levée 300 ms après, le livreur prévenu', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null });
    const a = prete({ ready_at: avant(10) });
    const b = commande({
      status: OrderStatus.IN_PROGRESS,
      address: B,
      created_at: avant(10 * 60),
      updated_at: avant(8 * 60),
      prepared_at: avant(8 * 60),
      estimated_preparation_time: apres(120),
    });
    const k = course({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: d1.id, assigned_at: avant(200), at_restaurant_at: avant(100) });
    const t = monter({
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d1],
    });

    await t.passer();
    expect(k.retenue_jusqua).toEqual(apres(120));
    const passage = jest.spyOn(t.planificateur, 'planifierRestaurant');

    // Juste avant l'échéance : rien.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(passage).not.toHaveBeenCalled();
    // 300 ms après : un passage, la retenue est levée (B pas prête : A part seule).
    await jest.advanceTimersByTimeAsync(MARGE_REVEIL_RETENUE_MS);
    await (t.planificateur as unknown as { file: Promise<unknown> }).file;
    expect(passage).toHaveBeenCalledWith(RESTO, 'ECHEANCE_RETENUE');
    expect(t.journalDe('RETENUE_LEVEE')).toEqual([expect.objectContaining({ course_id: k.id, motif: 'ECHEANCE' })]);
    expect(k.retenue_jusqua!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id]);
    expect(t.push.notifyCourseToutPret).toHaveBeenCalledWith(expect.objectContaining({ delivererId: d1.id, courseId: k.id }));
  });

  it('aucune retenue : aucun réveil programmé', async () => {
    const t = monter({ commandes: [prete()], livreurs: [livreur(AU_COMPTOIR)] });
    await t.passer();
    expect((t.planificateur as unknown as { reveils: Map<string, unknown> }).reveils.size).toBe(0);
  });
});

describe('ajout après le retrait, livreur encore au restaurant (3.8)', () => {
  function recuperee(protocole: number | null) {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: protocole });
    const a = prete({ status: OrderStatus.PICKED_UP });
    const k = course({
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: d1.id,
      assigned_at: avant(400),
      at_restaurant_at: avant(300),
      picked_up_at: avant(60),
    });
    const c = prete({ address: B, ready_at: avant(5) });
    return {
      d1,
      a,
      k,
      c,
      donnees: {
        commandes: [a, c],
        courses: [k],
        livraisons: [livraison({ course_id: k.id, order_id: a.id })],
        livreurs: [d1],
      } as DonneesDispatch,
    };
  }

  it('nouvelle appli (protocole 3) : C ajoutée, remise avec le même code, seule C passe récupérée', async () => {
    const s = recuperee(3);
    const t = monter(s.donnees);

    await t.passer();

    const ajoutee = t.livraisonsDe(s.k.id).find((l) => l.order_id === s.c.id);
    expect(ajoutee).toMatchObject({ ajoutee_apres_retrait: true, statut: DeliveryStatut.PENDING });
    expect(s.k.parti_at).toBeNull();
    expect(t.push.notifyCommandeAjoutee).toHaveBeenCalledWith(
      expect.objectContaining({ apresRetrait: true, corps: `Code ${s.k.pickup_code} au comptoir` }),
    );

    // La caisse retrouve la course par le même code…
    const where = whereCoursesARemettre(s.k.pickup_code, RESTO, journeeDeService(new Date()));
    s.k.created_at = avant(400);
    const trouvee = await t.base.prisma.course.findFirst({ where, include: { deliveries: { include: { order: true } } } });
    expect(trouvee?.id).toBe(s.k.id);
    // … et ne remet que C.
    await t.depart.remettreComplement(trouvee as never);
    expect(s.c.status).toBe(OrderStatus.PICKED_UP);
    expect(s.a.status).toBe(OrderStatus.PICKED_UP);
    expect(s.k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: s.d1.id, titre: 'Tout est récupéré', corps: 'Tu peux partir' }),
    );
    expect(t.journalDe('RETRAIT_COMPLEMENTAIRE')).toHaveLength(1);
  });

  it('ancienne appli (sans protocole 3) : course réputée partie, C a sa propre course', async () => {
    const s = recuperee(2);
    const t = monter(s.donnees);

    await t.passer();

    expect(s.k.parti_at).toEqual(MAINTENANT);
    expect(t.journalDe('COURSE_PARTIE')[0]).toMatchObject({ motif: 'ANCIENNE_APPLI' });
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
    const autre = t.coursesOuvertes().find((c) => c.id !== s.k.id)!;
    expect(t.livraisonsDe(autre.id).map((l) => l.order_id)).toEqual([s.c.id]);
  });

  it('« Je pars » avec C pas remise : C retirée de la course et reprise ailleurs, le livreur prévenu', async () => {
    const s = recuperee(3);
    const t = monter(s.donnees);
    await t.passer(); // C ajoutée après le retrait

    await t.depart.jePars(s.k.id, s.d1.id);
    expect(s.k.parti_at).toEqual(MAINTENANT);
    expect(t.emis.some((e) => e.canal === DispatchEvenements.PLANIFIER_RESTAURANT)).toBe(true);

    await t.passer();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
    expect(t.journalDe('COMMANDE_DETACHEE')).toHaveLength(1);
    const autre = t.coursesOuvertes().find((c) => c.id !== s.k.id)!;
    expect(t.livraisonsDe(autre.id).map((l) => l.order_id)).toEqual([s.c.id]);
    expect(t.push.notifyCommandeRetiree).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: s.d1.id, titre: 'Commande retirée', corps: '1 commande à livrer' }),
    );
  });

  it('commande ajoutée pendant la saisie du code : pas marquée remise, retirée au départ et reprise ailleurs', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 2 });
    const a = prete();
    const k = course({
      statut: CourseStatut.AT_RESTAURANT,
      deliverer_id: d1.id,
      assigned_at: avant(400),
      at_restaurant_at: avant(100),
      created_at: avant(500),
    });
    const b = prete({ address: B });
    const t = monter({
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d1],
    });
    // La caisse lit la course (A seule), le planificateur ajoute B juste avant l'écriture.
    const lire = t.requetes.findByActivePickupCode.bind(t.requetes);
    jest.spyOn(t.requetes, 'findByActivePickupCode').mockImplementationOnce(async (...args) => {
      const lue = await lire(...args);
      t.base.livraisons.push(livraison({ course_id: k.id, order_id: b.id, sequence_order: 2, ajoutee_at: new Date() }));
      return lue;
    });

    await t.actions.validatePickupByCashier({ pickup_code: k.pickup_code, restaurant_id: RESTO } as never, undefined);

    expect(a.status).toBe(OrderStatus.PICKED_UP);
    expect(b.status).toBe(OrderStatus.READY);
    expect(t.livraisonsDe(k.id)[1].ajoutee_apres_retrait).toBe(true);
    expect(k.parti_at).toEqual(MAINTENANT); // ancienne appli : fenêtre fermée à la validation

    await t.passer();
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id]);
    const autre = t.coursesOuvertes().find((c) => c.id !== k.id)!;
    expect(t.livraisonsDe(autre.id).map((l) => l.order_id)).toEqual([b.id]);
  });

  it('fenêtre fermée à la validation : ancienne appli et restaurant en v1 ; ouverte pour la nouvelle appli en v2', async () => {
    const ancienne = recuperee(null);
    ancienne.k.picked_up_at = new Date();
    const t1 = monter(ancienne.donnees);
    expect(await t1.depart.fermerFenetreALaValidation(ancienne.k.id)).toBe(true);
    expect(ancienne.k.parti_at).toEqual(MAINTENANT);

    const nouvelle = recuperee(3);
    const t2 = monter(nouvelle.donnees);
    expect(await t2.depart.fermerFenetreALaValidation(nouvelle.k.id)).toBe(false);
    expect(nouvelle.k.parti_at).toBeNull();

    const enV1 = recuperee(3);
    const t3 = monter(enV1.donnees, { reglages: { 'course.planificateur': 'v1' } });
    expect(await t3.depart.fermerFenetreALaValidation(enV1.k.id)).toBe(true);
  });
});

describe('Turbo sous v2 (3.11)', () => {
  it('aucun livreur depuis 6 min après la commande prête : confiée à Turbo ; pas avant', async () => {
    const a = prete({ ready_at: avant(5 * 60) });
    const k = course({ created_at: avant(5 * 60) });
    const t = monter({
      commandes: [a],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [livreur({ last_available_at: null })],
    });

    await t.passer();
    expect(t.turbo.creerCourseGroupe).not.toHaveBeenCalled();

    jest.setSystemTime(apres(61));
    await t.passer();
    expect(t.turbo.creerCourseGroupe).toHaveBeenCalledTimes(1);
    expect(k.turbo_escalated_at).toBeTruthy();
    expect(t.journalDe('TURBO_PLANIFIE')[0]).toMatchObject({ motif: 'CONFIEE' });
  });

  it('Turbo refuse : la course reste en recherche interne, nouvel essai seulement 2 min plus tard', async () => {
    const a = prete({ ready_at: avant(7 * 60) });
    const k = course({ created_at: avant(7 * 60) });
    const t = monter(
      {
        commandes: [a],
        courses: [k],
        livraisons: [livraison({ course_id: k.id, order_id: a.id })],
        livreurs: [livreur({ last_available_at: null })],
      },
      { turbo: { sentOrderIds: [] } },
    );

    await t.passer();
    expect(t.turbo.creerCourseGroupe).toHaveBeenCalledTimes(1);
    expect(k.turbo_escalated_at).toBeNull();
    expect(t.journalDe('TURBO_PLANIFIE')[0]).toMatchObject({ motif: 'ECHEC' });

    jest.setSystemTime(apres(60));
    await t.passer();
    expect(t.turbo.creerCourseGroupe).toHaveBeenCalledTimes(1);
    // Seul l'échec du premier essai est au journal : l'attente, elle, ne l'encombre pas.
    expect(t.journalDe('ACTION_ABANDONNEE')).toEqual([expect.objectContaining({ motif: 'CONFIER_TURBO' })]);

    jest.setSystemTime(apres(125));
    await t.passer();
    expect(t.turbo.creerCourseGroupe).toHaveBeenCalledTimes(2);
  });

  it('la tâche des courses sans livreur ne bascule plus à 4 min ni ne propose sous v2 ; elle le fait sous v1', async () => {
    const donnees = (): DonneesDispatch => {
      const a = prete({ ready_at: avant(5 * 60) });
      const k = course({ created_at: avant(5 * 60) });
      return {
        commandes: [a],
        courses: [k],
        livraisons: [livraison({ course_id: k.id, order_id: a.id })],
        livreurs: [livreur({ last_available_at: null })],
      };
    };
    const v2 = monter(donnees());
    await v2.offres.retryUnassignedCourses();
    expect(v2.turbo.creerCourseGroupe).not.toHaveBeenCalled();
    expect(v2.scoring.pickBestCandidate).not.toHaveBeenCalled();

    const v1 = monter(donnees(), { reglages: { 'course.planificateur': 'v1' } });
    await v1.offres.retryUnassignedCourses();
    expect(v1.turbo.creerCourseGroupe).toHaveBeenCalledTimes(1);
  });
});

describe('repli : planificateur v1 (« course.planificateur » = v1)', () => {
  it('v1 sans reste de v2 : le passage ne lit ni n’écrit rien', async () => {
    const t = monter({ commandes: [prete()], livreurs: [livreur(AU_COMPTOIR)] }, { reglages: { 'course.planificateur': 'v1' } });
    expect(await t.passer()).toBeNull();
    expect(t.base.courses).toHaveLength(0);
    expect(t.base.offres).toHaveLength(0);
    expect(t.base.journal).toHaveLength(0);
  });

  it('v1 inchangé : la recherche choisit par le score (pas de demande au planificateur)', async () => {
    const k = course();
    const a = prete();
    const t = monter(
      { commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [livreur()] },
      { reglages: { 'course.planificateur': 'v1' } },
    );
    await t.offres.offerNextDeliverer(k.id);
    expect(t.scoring.pickBestCandidate).toHaveBeenCalledTimes(1);
    expect(t.emis.some((e) => e.canal === DispatchEvenements.PLANIFIER_RESTAURANT)).toBe(false);

    const v2 = monter({ commandes: [a], courses: [course({ id: 'k-v2' })], livreurs: [livreur()] });
    await v2.offres.offerNextDeliverer('k-v2');
    expect(v2.scoring.pickBestCandidate).not.toHaveBeenCalled();
    expect(v2.emis).toContainEqual({
      canal: DispatchEvenements.PLANIFIER_RESTAURANT,
      charge: { restaurant_id: RESTO, raison: 'RECHERCHE' },
    });
  });

  it('v1 inchangé : commande prête vers les lots, lots et rééquilibrage comme avant ; v2 : planificateur', async () => {
    const lus = { v1: { version: 'v1', restaurants: [], refusees: [] }, v2: { version: 'v2', restaurants: [], refusees: [] } };
    for (const version of ['v1', 'v2'] as const) {
      const regroupement = { tryGroupOrder: jest.fn(async () => ({ batchId: 'l', flushed: false })), flushMatureBatches: jest.fn(async () => 0), rebalanceActiveCourses: jest.fn(async () => ({ merged: 0, transferred: 0 })) };
      const settings = { versionPour: jest.fn(async () => version), planificateurLu: jest.fn(async () => lus[version]) };
      const pont = new OrderBridgeListenerService(regroupement as never, settings as never);
      const commandePrete = (service: DeliveryService) => ({
        order: { id: 'o', reference: 'CMD-1', restaurant_id: RESTO, status: OrderStatus.READY, type: 'DELIVERY', delivery_service: service },
      });
      await pont.onOrderStatusUpdated(commandePrete(DeliveryService.CHICKEN_NATION) as never);
      await pont.onOrderStatusUpdated(commandePrete(DeliveryService.TURBO) as never);
      // Turbo d'origine : toujours le lot ; flotte interne : le lot en v1 seulement.
      expect(regroupement.tryGroupOrder).toHaveBeenCalledTimes(version === 'v1' ? 2 : 1);

      const lotsV2 = { libererLotsV2: jest.fn(async () => []) };
      const tache = new CourseBatchTask(regroupement as never, settings as never, lotsV2 as never, { demanderPlanification: jest.fn() } as never);
      await tache.flushMatureBatches();
      await tache.rebalanceActiveCourses();
      expect(regroupement.flushMatureBatches).toHaveBeenCalledTimes(1);
      const exclure = (regroupement.rebalanceActiveCourses.mock.calls[0] as unknown[])[0] as (id: string) => boolean;
      expect(exclure(RESTO)).toBe(version === 'v2');
    }
  });

  it('passage de v2 à v1 en pleine activité : courses récupérées marquées parties, ajouts non remis rendus aux lots, retenues levées', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 3 });
    const d2 = livreur({ ...AU_COMPTOIR, last_available_at: null });
    const remise = prete({ status: OrderStatus.PICKED_UP });
    const ajoutee = prete({ address: B });
    const k = course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: d1.id, picked_up_at: avant(60), assigned_at: avant(500) });
    const attente = prete();
    const retenue = course({
      statut: CourseStatut.AT_RESTAURANT,
      deliverer_id: d2.id,
      assigned_at: avant(500),
      retenue_jusqua: apres(90),
      commandes_attendues: [{ order_id: 'x', reference: 'CMD-X' }],
    });
    const t = monter(
      {
        commandes: [remise, ajoutee, attente],
        courses: [k, retenue],
        livraisons: [
          livraison({ course_id: k.id, order_id: remise.id, sequence_order: 1 }),
          livraison({ course_id: k.id, order_id: ajoutee.id, sequence_order: 2, ajoutee_apres_retrait: true }),
          livraison({ course_id: retenue.id, order_id: attente.id, sequence_order: 1 }),
        ],
        livreurs: [d1, d2],
      },
      { reglages: { 'course.planificateur': 'v1' } },
    );

    const resultat = await t.passer();

    expect(resultat?.version).toBe('v1');
    expect(k.parti_at).toEqual(MAINTENANT);
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([remise.id]);
    expect(t.regroupement.tryGroupOrder).toHaveBeenCalledWith(ajoutee.id);
    expect(retenue.retenue_jusqua).toEqual(MAINTENANT);
    expect(retenue.commandes_attendues).toEqual([]);
    // Rien d'autre : ni création, ni offre (l'ancien regroupement reprend la main).
    expect(t.base.offres).toHaveLength(0);
    expect(t.coursesOuvertes()).toHaveLength(2);
    // Plus rien de v2 : le passage suivant ne fait rien.
    expect(await t.passer()).toBeNull();
  });
});

describe('déclenchement regroupé par restaurant (500 ms)', () => {
  it('trois demandes rapprochées : un seul passage', async () => {
    const t = monter({ commandes: [prete()], livreurs: [livreur(AU_COMPTOIR)] });
    const passage = jest.spyOn(t.planificateur, 'planifierRestaurant');

    t.planificateur.demander(RESTO, 'COMMANDE_READY');
    t.planificateur.demander(RESTO, 'LIVREUR_FILE');
    jest.advanceTimersByTime(300);
    t.planificateur.demander(RESTO, 'COURSE_ACCEPTEE');
    expect(passage).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    await (t.planificateur as unknown as { file: Promise<unknown> }).file;

    expect(passage).toHaveBeenCalledTimes(1);
    expect(passage.mock.calls[0][1]).toBe('COMMANDE_READY,LIVREUR_FILE,COURSE_ACCEPTEE');
    expect(t.coursesOuvertes()).toHaveLength(1);
  });

  it('tâche de 10 s : les restaurants actifs, et une commande prête arrivée sans événement est reprise', async () => {
    const t = monter({ commandes: [prete()], livreurs: [livreur(AU_COMPTOIR)] });
    await t.planificateur.passerTout(new Date());
    expect(t.coursesOuvertes()).toHaveLength(1);
    expect(t.base.offres).toHaveLength(1);
  });
});

describe('lots sous v2 (5.5)', () => {
  it('les lots en attente de la flotte interne sont vidés aussitôt ; les lots Turbo restent', async () => {
    const base = monterBaseDispatch({});
    const lots = [
      { id: 'lot-interne', restaurant_id: RESTO, status: CourseBatchStatus.PENDING, orders: [{ id: 'o1', delivery_service: DeliveryService.CHICKEN_NATION }] },
      { id: 'lot-turbo', restaurant_id: RESTO, status: CourseBatchStatus.PENDING, orders: [{ id: 'o2', delivery_service: DeliveryService.TURBO }] },
    ];
    const prisma = {
      ...base.prisma,
      courseBatch: {
        findMany: jest.fn(async () => lots),
        updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const l = lots.find((x) => evaluer(x, where));
          if (l) Object.assign(l, data);
          return { count: l ? 1 : 0 };
        }),
      },
      order: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const service = new LotsV2Service(prisma as never, {} as never);

    const rendus = await service.libererLotsV2({ version: 'v2', restaurants: [], refusees: [] });

    expect(rendus).toEqual([RESTO]);
    expect(lots[0].status).toBe(CourseBatchStatus.EXPIRED);
    expect(lots[1].status).toBe(CourseBatchStatus.PENDING);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({ where: { batch_id: 'lot-interne', delivery: null }, data: { batch_id: null } });

    expect(await service.libererLotsV2({ version: 'v1', restaurants: [], refusees: [] })).toEqual([]);
  });
});

describe('appli fermée (24/10) : le planificateur ne la choisit jamais, la reprend dès sa réouverture', () => {
  const RESTAURANT_POS = { lat: 5.286, lng: -3.9737 };

  it('livreur au comptoir mais appli fermée : l’offre part au livreur dont l’appli est active', async () => {
    const ferme = livreur({
      last_location: RESTAURANT_POS,
      last_location_at: avant(400),
      dernier_signal_at: avant(400),
      protocole_appli: 4,
      last_available_at: avant(3600),
    });
    const actif = livreur({ protocole_appli: 4, ...LOIN, dernier_signal_at: avant(60), last_available_at: avant(60) });
    const t = monter({ commandes: [prete()], livreurs: [ferme, actif] }, { appli: { connectes: [] } });

    await t.passer();

    expect(t.base.offres).toEqual([expect.objectContaining({ deliverer_id: actif.id, status: CourseOfferStatus.PENDING })]);
    // Aucune pause, aucune sortie de la file pour l'appli fermée.
    expect(ferme.pause_until).toBeNull();
    expect(ferme.last_available_at).toEqual(avant(3600));
  });

  it('seule une appli fermée : la course attend ; il rouvre l’appli, l’offre lui part au passage suivant', async () => {
    const l = livreur({ protocole_appli: 4, ...AU_COMPTOIR, dernier_signal_at: avant(400) });
    const t = monter({ commandes: [prete()], livreurs: [l] }, { appli: { connectes: [] } });

    await t.passer();
    expect(t.coursesOuvertes()).toHaveLength(1);
    expect(t.base.offres).toHaveLength(0);

    // Réouverture : le socket se connecte (aucune requête encore).
    t.appli.etat.connectes = [l.id];
    await t.passer();
    expect(t.base.offres).toEqual([expect.objectContaining({ deliverer_id: l.id, status: CourseOfferStatus.PENDING })]);
  });

  it('offre en attente d’une appli qui se ferme : close par la tâche des relances, le planificateur la propose à un autre', async () => {
    const a = prete();
    const k = course({ created_at: avant(30) });
    const ferme = livreur({ protocole_appli: 4, ...AU_COMPTOIR, dernier_signal_at: avant(400), last_available_at: avant(3600) });
    const autre = livreur({ protocole_appli: 4, ...LOIN, dernier_signal_at: avant(20), last_available_at: avant(60) });
    const o = offre({ course_id: k.id, deliverer_id: ferme.id, offered_at: avant(20), expires_at: apres(100) });
    const t = monter(
      {
        commandes: [a],
        courses: [k],
        livraisons: [livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 })],
        livreurs: [ferme, autre],
        offres: [o],
      },
      { appli: { connectes: [] } },
    );

    await t.offres.remindPendingOffers();
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.journalDe('OFFRE_CLOSE')[0]).toMatchObject({ motif: 'APPLI_FERMEE', deliverer_id: ferme.id });
    expect(t.emisSur(DispatchEvenements.RECHERCHE_A_RELANCER)).toEqual([{ course_id: k.id }]);

    await t.passer();
    expect(t.base.offres.filter((x) => x.status === CourseOfferStatus.PENDING)).toEqual([
      expect.objectContaining({ course_id: k.id, deliverer_id: autre.id }),
    ]);
    expect(ferme.pause_until).toBeNull();
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
  });
});
