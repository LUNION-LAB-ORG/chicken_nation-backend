/**
 * AJOUT APRÈS LE RETRAIT ET DÉPART DU RESTAURANT (planificateur v2,
 * conception 3.8, recette R10 à R13 de 7.3 en tests de service ; demandes du
 * 22/10 et du 23/10).
 *
 * Un livreur qui a récupéré sa course mais est encore au restaurant reçoit
 * sans attendre la commande compatible qui devient prête, remise avec le
 * MÊME code. Le départ se déduit sans rien lui demander : position hors du
 * rayon de départ, première livraison démarrée, fenêtre écoulée ; « Je pars »
 * reste facultatif. Réservé à la nouvelle appli (protocole 3).
 *
 * Les VRAIS services sur la base simulée (banc-planificateur.simulee-spec.ts).
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import { lireProtocoleAppli } from 'src/modules/auth-deliverer/helpers/signal-livreur.rules';

import { CourseChannels } from '../enums/course-channels';
import { DispatchEvenements } from '../enums/dispatch-evenements';
import { MESSAGE_DEPART_AVANT_RETRAIT, MESSAGE_RIEN_A_REMETTRE } from '../helpers/depart.rules';
import { course, DonneesDispatch, livraison, livreur, RESTO } from './base-dispatch.simulee-spec';
import { AU_COMPTOIR, avant, apres, B, KM_LNG, MAINTENANT, monter, prete, RESTAURANT } from './banc-planificateur.simulee-spec';

/** Position du livreur à `metres` à l'est du restaurant (sur l'axe des clients). */
const aLEst = (metres: number) => ({ lat: RESTAURANT.lat, lng: RESTAURANT.lng + (metres / 1000) * KM_LNG });

/**
 * Le livreur remonte sa position (comme `PATCH /deliverers/me/location`) :
 * écrite sur le livreur, puis l'événement `deliverer:location:updated`.
 */
async function bouge(t: ReturnType<typeof monter>, d: Record<string, any>, metres: number, a = new Date()) {
  d.last_location = aLEst(metres);
  d.last_location_at = a;
  await t.ecouteur.onPosition({
    delivererId: d.id,
    ...aLEst(metres),
    heading: null,
    speedKmh: null,
    ts: a.toISOString(),
    restaurantId: RESTO,
  });
}

/** Ce que `PATCH /orders/:id/status` émet après avoir passé la commande PICKED_UP (bouton de la caisse). */
const boutonCaisse = (o: Record<string, any>) => {
  o.status = OrderStatus.PICKED_UP;
  o.picked_up_at = new Date();
  return { order: { ...o, type: OrderType.DELIVERY } } as never;
};

/** La caisse saisit le code de retrait (caisse Sunmi : restaurant de son compte). */
const saisirCode = (t: ReturnType<typeof monter>, code: string) =>
  t.actions.validatePickupByCashier({ pickup_code: code, restaurant_id: RESTO } as never, undefined);

/**
 * D1 au comptoir, sa course K (A, à 2 km à l'est) au restaurant ; C, à 4 km
 * sur le même axe, en cuisine. Protocole de l'appli de D1 au choix.
 */
function auComptoir(protocole: number | null) {
  const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: protocole });
  const a = prete();
  const k = course({
    statut: CourseStatut.AT_RESTAURANT,
    deliverer_id: d1.id,
    assigned_at: avant(400),
    at_restaurant_at: avant(120),
    created_at: avant(600),
  });
  const c = prete({ address: B, status: OrderStatus.IN_PROGRESS, ready_at: null, prepared_at: avant(900) });
  const donnees: DonneesDispatch = {
    commandes: [a, c],
    courses: [k],
    livraisons: [livraison({ course_id: k.id, order_id: a.id })],
    livreurs: [d1],
  };
  return { d1, a, k, c, donnees };
}

/** Comme `auComptoir`, mais la course est déjà récupérée et C, prête, déjà ajoutée après le retrait. */
function avecAjoutNonRemis(protocole = 3) {
  const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: protocole });
  const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(60) });
  const c = prete({ address: B, ready_at: avant(10) });
  const k = course({
    statut: CourseStatut.IN_DELIVERY,
    deliverer_id: d1.id,
    assigned_at: avant(400),
    at_restaurant_at: avant(300),
    picked_up_at: avant(60),
    created_at: avant(600),
  });
  const donnees: DonneesDispatch = {
    commandes: [a, c],
    courses: [k],
    livraisons: [
      livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }),
      livraison({ course_id: k.id, order_id: c.id, sequence_order: 2, ajoutee_at: avant(10), ajoutee_apres_retrait: true }),
    ],
    livreurs: [d1],
  };
  return { d1, a, c, k, donnees };
}

/** La commande sort de cuisine (statut écrit, comme le fait l'écran de la cuisine). */
function devientPrete(o: Record<string, any>) {
  o.status = OrderStatus.READY;
  o.ready_at = new Date();
  o.updated_at = new Date();
}

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('R10 : retrait validé, nouvelle appli encore au restaurant, une commande compatible devient prête', () => {
  it('ajoutée sans attendre, remise avec le même code, seule elle passe récupérée ; le départ se déduit de la position', async () => {
    const s = auComptoir(3);
    const t = monter(s.donnees);

    // La caisse remet A : la fenêtre d'ajout reste ouverte (protocole 3), la
    // première livraison n'est PAS démarrée tant que le livreur est là.
    const remise = await saisirCode(t, s.k.pickup_code);
    expect(remise.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(s.k.parti_at).toBeNull();
    expect(s.a.status).toBe(OrderStatus.PICKED_UP);
    expect(t.livraisonsDe(s.k.id)[0].statut).toBe(DeliveryStatut.PENDING);

    // C sort de cuisine : ajoutée à la course de D1 dans le passage.
    jest.setSystemTime(apres(20));
    devientPrete(s.c);
    await t.passer();
    const ajoutee = t.livraisonsDe(s.k.id).find((l) => l.order_id === s.c.id);
    expect(ajoutee).toMatchObject({ ajoutee_apres_retrait: true, statut: DeliveryStatut.PENDING });
    expect(t.push.notifyCommandeAjoutee).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: s.d1.id, apresRetrait: true, corps: `Code ${s.k.pickup_code} au comptoir`, code: s.k.pickup_code }),
    );
    expect(t.journalDe('COMMANDE_AJOUTEE')[0]).toMatchObject({
      order_id: s.c.id,
      details: expect.objectContaining({ apres_retrait: true }),
    });

    // Même code à la caisse : seule C est remise, la course reste en livraison.
    jest.setSystemTime(apres(50));
    const estimation = jest.spyOn(t.actions, 'estimerDureeTournee');
    const complement = await saisirCode(t, s.k.pickup_code);
    expect(complement.id).toBe(s.k.id);
    expect(s.c.status).toBe(OrderStatus.PICKED_UP);
    expect(s.c.picked_up_at).toEqual(apres(50));
    expect(s.a.picked_up_at).toEqual(MAINTENANT);
    expect(s.k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(s.k.parti_at).toBeNull();
    expect(estimation).toHaveBeenCalledWith(s.k.id);
    expect(t.journalDe('RETRAIT_COMPLEMENTAIRE')[0].details).toMatchObject({ commandes: [s.c.reference] });
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: s.d1.id, titre: 'Tout est récupéré', corps: 'Tu peux partir' }),
    );
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED)).toContainEqual(
      expect.objectContaining({ reason: 'RETRAIT_COMPLEMENTAIRE', new_statut: CourseStatut.IN_DELIVERY }),
    );

    // D1 s'en va sans rien toucher : une position à 300 m suffit. Départ
    // enregistré aussitôt, première livraison démarrée par le serveur.
    jest.setSystemTime(apres(80));
    await bouge(t, s.d1, 300);
    expect(s.k.parti_at).toEqual(apres(80));
    expect(t.journalDe('COURSE_PARTIE')[0]).toMatchObject({ motif: 'POSITION', source: 'serveur' });
    const [premiere, seconde] = t.livraisonsDe(s.k.id);
    expect(premiere).toMatchObject({ order_id: s.a.id, statut: DeliveryStatut.IN_ROUTE, in_route_at: apres(80) });
    expect(seconde).toMatchObject({ order_id: s.c.id, statut: DeliveryStatut.PENDING });
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toEqual([
      expect.objectContaining({ course_id: s.k.id, new_statut: DeliveryStatut.IN_ROUTE }),
    ]);
    expect(t.emisSur(CourseChannels.COURSE_STATUT_CHANGED)).toContainEqual(
      expect.objectContaining({ reason: 'DEPART', course: expect.objectContaining({ id: s.k.id }) }),
    );
  });

  it('bouton de la caisse « Livreur a récupéré » sur la commande ajoutée : remise, course en livraison, livreur prévenu', async () => {
    const s = avecAjoutNonRemis();
    const t = monter(s.donnees);
    const estimation = jest.spyOn(t.actions, 'estimerDureeTournee').mockResolvedValue(undefined);

    await t.remiseCaisse.onStatutCommande(boutonCaisse(s.c));

    expect(s.k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(s.k.parti_at).toBeNull();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id, s.c.id]);
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: s.d1.id, titre: 'Tout est récupéré', corps: 'Tu peux partir' }),
    );
    expect(estimation).toHaveBeenCalledWith(s.k.id);
    // Remise : plus rien à retirer au départ.
    await t.depart.jePars(s.k.id, s.d1.id);
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id, s.c.id]);
    expect(t.journalDe('COMMANDE_DETACHEE')).toHaveLength(0);
  });
});

describe('R11 : livreur parti, plus aucun ajout', () => {
  it('après « Je pars » : C crée sa propre course ; la première livraison est démarrée par le serveur', async () => {
    const s = auComptoir(3);
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);

    const rendue = await t.depart.jePars(s.k.id, s.d1.id);
    expect(rendue.parti_at).toEqual(MAINTENANT);
    expect(t.journalDe('COURSE_PARTIE')[0]).toMatchObject({ motif: 'BOUTON', source: 'appli' });
    expect(t.livraisonsDe(s.k.id)[0].statut).toBe(DeliveryStatut.IN_ROUTE);
    // Deux fois : sans effet, sans erreur.
    await t.depart.jePars(s.k.id, s.d1.id);
    expect(t.journalDe('COURSE_PARTIE')).toHaveLength(1);

    devientPrete(s.c);
    await t.passer();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
    const autre = t.coursesOuvertes().find((k) => k.id !== s.k.id)!;
    expect(t.livraisonsDe(autre.id).map((l) => l.order_id)).toEqual([s.c.id]);
    expect(t.push.notifyCommandeAjoutee).not.toHaveBeenCalled();
  });

  it('après une position à 300 m : départ enregistré tout de suite, C crée sa propre course ; à 100 m, rien', async () => {
    const s = auComptoir(3);
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);

    // Encore dans le rayon de départ (250 m) : pas parti.
    jest.setSystemTime(apres(10));
    await bouge(t, s.d1, 100);
    expect(s.k.parti_at).toBeNull();

    jest.setSystemTime(apres(30));
    await bouge(t, s.d1, 300);
    expect(s.k.parti_at).toEqual(apres(30));
    expect(t.journalDe('COURSE_PARTIE')[0]).toMatchObject({ motif: 'POSITION', details: expect.objectContaining({ distance_m: 300 }) });

    devientPrete(s.c);
    await t.passer();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
    expect(t.coursesOuvertes().filter((k) => k.id !== s.k.id)).toHaveLength(1);
  });

  it('première livraison démarrée par le livreur : c’est son départ ; démarrer deux fois ne fait pas d’erreur', async () => {
    const s = auComptoir(3);
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);
    const [premiere] = t.livraisonsDe(s.k.id);

    const demarree = await t.actionsLivraison.startDelivery(premiere.id, s.d1.id);
    expect(demarree.statut).toBe(DeliveryStatut.IN_ROUTE);
    expect(s.k.parti_at).toEqual(MAINTENANT);
    expect(t.journalDe('COURSE_PARTIE')[0]).toMatchObject({ motif: 'LIVRAISON_DEMARREE', source: 'appli' });
    await expect(t.actionsLivraison.startDelivery(premiere.id, s.d1.id)).resolves.toMatchObject({ statut: DeliveryStatut.IN_ROUTE });
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(1);

    devientPrete(s.c);
    await t.passer();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
  });

  it('fenêtre écoulée (4 min après le retrait) : partie au passage, première livraison démarrée par le serveur', async () => {
    const s = avecAjoutNonRemis();
    s.k.picked_up_at = avant(241);
    // Dernière position vieille de 16 min : rien ne dit qu'il attend au comptoir.
    // (Une position de quelques minutes au comptoir prolonge la fenêtre : il
    // attend son sac sans bouger, l'appli n'envoie plus rien à l'arrêt.)
    s.d1.last_location_at = avant(16 * 60);
    const t = monter(s.donnees);

    await t.passer();

    expect(s.k.parti_at).toEqual(MAINTENANT);
    expect(t.journalDe('COURSE_PARTIE')[0]).toMatchObject({ motif: 'FENETRE_ECHUE' });
    // C pas remise : retirée et reprise ailleurs ; A part, démarrée.
    expect(t.livraisonsDe(s.k.id)).toEqual([expect.objectContaining({ order_id: s.a.id, statut: DeliveryStatut.IN_ROUTE })]);
    const autre = t.coursesOuvertes().find((k) => k.id !== s.k.id)!;
    expect(t.livraisonsDe(autre.id).map((l) => l.order_id)).toEqual([s.c.id]);
  });

  it('fenêtre écoulée, livreur toujours au comptoir avec un sac à prendre : la course l’attend 2 min de plus, la caisse remet le sac (relecture)', async () => {
    const s = avecAjoutNonRemis();
    s.k.picked_up_at = avant(241);
    s.d1.last_location_at = avant(20); // position fraîche, au comptoir
    const t = monter(s.donnees);

    await t.passer();
    expect(s.k.parti_at).toBeNull();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id, s.c.id]);
    expect(t.push.notifyCommandeRetiree).not.toHaveBeenCalled();

    // La caisse remet C avec le même code pendant la prolongation.
    jest.setSystemTime(apres(60));
    s.d1.last_location_at = new Date();
    await saisirCode(t, s.k.pickup_code);
    expect(s.c.status).toBe(OrderStatus.PICKED_UP);

    // Sans remise, au-delà de 2 min de prolongation : parti, C retirée.
    const s2 = avecAjoutNonRemis();
    s2.k.picked_up_at = avant(241 + 120);
    s2.d1.last_location_at = avant(5);
    const t2 = monter(s2.donnees);
    await t2.passer();
    expect(t2.journalDe('COURSE_PARTIE')[0]).toMatchObject({ motif: 'FENETRE_ECHUE' });
    expect(t2.livraisonsDe(s2.k.id).map((l) => l.order_id)).toEqual([s2.a.id]);
  });

  it('une commande ajoutée pas encore remise ne se démarre pas (409) ; « Je pars » la retire tout de suite', async () => {
    const s = avecAjoutNonRemis();
    const t = monter(s.donnees);
    const [, ajoutee] = t.livraisonsDe(s.k.id);

    await expect(t.actionsLivraison.startDelivery(ajoutee.id, s.d1.id)).rejects.toThrow(new ConflictException(MESSAGE_DEPART_AVANT_RETRAIT));
    expect(s.k.parti_at).toBeNull();

    const rendue = await t.depart.jePars(s.k.id, s.d1.id);
    // La réponse ne la contient plus : l'appli n'affiche rien de faux.
    expect(rendue.deliveries.map((d) => d.order_id)).toEqual([s.a.id]);
    expect(rendue.deliveries[0].statut).toBe(DeliveryStatut.IN_ROUTE);
    expect(rendue.total_delivery_fee).toBe(1000);
    expect(t.journalDe('COMMANDE_DETACHEE')[0]).toMatchObject({ order_id: s.c.id, motif: 'LIVREUR_PARTI' });
    expect(t.push.notifyCommandeRetiree).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: s.d1.id, titre: 'Commande retirée', corps: '1 commande à livrer', commande: s.c.reference }),
    );
    expect(t.emis).toContainEqual({ canal: DispatchEvenements.PLANIFIER_RESTAURANT, charge: { restaurant_id: RESTO, raison: 'DEPART_BOUTON' } });

    await t.passer();
    const autre = t.coursesOuvertes().find((k) => k.id !== s.k.id)!;
    expect(t.livraisonsDe(autre.id).map((l) => l.order_id)).toEqual([s.c.id]);
  });
});

describe('R12 : appli sans protocole 3 (ancienne appli, protocole 2, ou sans en-tête), jamais d’ajout après le retrait', () => {
  it.each([
    ['sans en-tête', lireProtocoleAppli(undefined)],
    ['protocole 2', lireProtocoleAppli('2')],
    ['jamais vu', null],
  ])('%s : fenêtre fermée à la validation, C a sa propre course, la première livraison reste à l’appli', async (_nom, protocole) => {
    const s = auComptoir(protocole);
    const t = monter(s.donnees);

    await saisirCode(t, s.k.pickup_code);
    expect(s.k.parti_at).toEqual(MAINTENANT);
    expect(t.journalDe('COURSE_PARTIE')[0]).toMatchObject({ motif: 'ANCIENNE_APPLI' });
    // L'ancienne appli démarre elle-même sa première livraison : le serveur n'y touche pas.
    expect(t.livraisonsDe(s.k.id)[0].statut).toBe(DeliveryStatut.PENDING);

    jest.setSystemTime(apres(20));
    devientPrete(s.c);
    await t.passer();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
    expect(t.coursesOuvertes().filter((k) => k.id !== s.k.id)).toHaveLength(1);
    expect(t.push.notifyCommandeAjoutee).not.toHaveBeenCalled();
    // La recherche par code ne la retrouve plus : rien à remettre.
    await expect(saisirCode(t, s.k.pickup_code)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('R13 : bouton de la caisse « Livreur a récupéré » sur une commande de course', () => {
  it('course au restaurant : partie en livraison, l’autre commande reste à remettre, jamais annulée', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 3 });
    const a = prete();
    const b = prete({ address: B });
    const k = course({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: d1.id, assigned_at: avant(400), at_restaurant_at: avant(100) });
    const t = monter({
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }), livraison({ course_id: k.id, order_id: b.id, sequence_order: 2 })],
      livreurs: [d1],
    });
    jest.spyOn(t.actions, 'estimerDureeTournee').mockResolvedValue(undefined);

    await t.remiseCaisse.onStatutCommande(boutonCaisse(a));

    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(k.picked_up_at).toEqual(MAINTENANT);
    expect(k.parti_at).toBeNull(); // nouvelle appli : encore au restaurant
    expect(b.status).toBe(OrderStatus.READY);
    // Un sac reste au comptoir : pas de « Sacs remis, tu peux partir » (seconde relecture).
    expect(t.push.notifyPickupValidated).not.toHaveBeenCalled();

    // La tâche d'annulation des courses bloquées au restaurant ne la touche plus.
    jest.setSystemTime(apres(31 * 60));
    expect(await t.annulationAuto.annulerAutomatiquement(k.id, 'bloquée au restaurant')).toBeNull();
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect([a.status, b.status]).toEqual([OrderStatus.PICKED_UP, OrderStatus.READY]);

    // Seconde commande remise par le même bouton : le livreur peut partir (une seule fois).
    await t.remiseCaisse.onStatutCommande(boutonCaisse(b));
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledTimes(1);
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledWith(expect.objectContaining({ delivererId: d1.id, corps: 'Tu peux partir' }));
    expect(t.push.notifyPickupValidated).not.toHaveBeenCalled();
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([a.id, b.id]);
  });
});

describe('concurrence', () => {
  it('double remise simultanée du même code : une seule passe, l’autre reçoit 409, le livreur est prévenu une fois', async () => {
    const s = avecAjoutNonRemis();
    const t = monter(s.donnees);
    // Les deux caisses lisent la course avant que l'une d'elles n'écrive.
    const lire = t.requetes.findByActivePickupCode.bind(t.requetes);
    let arrivees = 0;
    let lacher: () => void = () => undefined;
    const lues = new Promise<void>((r) => (lacher = r));
    jest.spyOn(t.requetes, 'findByActivePickupCode').mockImplementation(async (...args) => {
      const lue = await lire(...args);
      if (++arrivees === 2) lacher();
      await lues;
      return lue;
    });

    const issues = await Promise.allSettled([saisirCode(t, s.k.pickup_code), saisirCode(t, s.k.pickup_code)]);

    expect(issues.map((i) => i.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refus = issues.find((i): i is PromiseRejectedResult => i.status === 'rejected')!.reason;
    expect(refus).toEqual(new ConflictException(MESSAGE_RIEN_A_REMETTRE));
    expect(s.c.status).toBe(OrderStatus.PICKED_UP);
    expect(t.journalDe('RETRAIT_COMPLEMENTAIRE')).toHaveLength(1);
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledTimes(1);
    expect(s.k.statut).toBe(CourseStatut.IN_DELIVERY);
  });

  it('départ entre la lecture et l’écriture du planificateur : l’ajout est abandonné, C a sa propre course', async () => {
    const s = auComptoir(3);
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);
    devientPrete(s.c);
    const appliquer = t.application.appliquer.bind(t.application);
    jest.spyOn(t.application, 'appliquer').mockImplementationOnce(async (...args) => {
      await t.depart.jePars(s.k.id, s.d1.id); // le livreur part pendant le calcul
      return appliquer(...args);
    });

    const resultat = await t.passer();

    expect(resultat?.abandonnees).toContainEqual({ type: 'AJOUTER', motif: 'COURSE_CHANGEE' });
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
    expect(t.push.notifyCommandeAjoutee).not.toHaveBeenCalled();
    await t.passer();
    const autre = t.coursesOuvertes().find((k) => k.id !== s.k.id)!;
    expect(t.livraisonsDe(autre.id).map((l) => l.order_id)).toEqual([s.c.id]);
  });

  it('départ juste après l’ajout : la commande ajoutée pas remise est retirée au départ, jamais emportée', async () => {
    const s = auComptoir(3);
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);
    devientPrete(s.c);
    await t.passer(); // C ajoutée

    jest.setSystemTime(apres(1));
    await bouge(t, s.d1, 400);

    expect(s.k.parti_at).not.toBeNull();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
    expect(s.c.status).toBe(OrderStatus.READY);
    expect(t.push.notifyCommandeRetiree).toHaveBeenCalledTimes(1);
    await t.passer();
    expect(t.coursesOuvertes().filter((k) => k.id !== s.k.id)).toHaveLength(1);
  });

  it('départ au milieu de l’écriture d’un ajout (impossible en base, ligne verrouillée) : rattrapé au passage suivant', async () => {
    const s = auComptoir(3);
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);
    devientPrete(s.c);
    const transaction = t.base.prisma.$transaction;
    let parti = false;
    t.base.prisma.$transaction = jest.fn((arg: unknown) =>
      typeof arg !== 'function'
        ? transaction(arg)
        : transaction(async (tx: any) => {
            const creer = tx.delivery.create;
            tx.delivery.create = async (args: any) => {
              if (!parti && args.data.order_id === s.c.id) {
                parti = true;
                await t.depart.jePars(s.k.id, s.d1.id);
              }
              return creer(args);
            };
            return (arg as (tx: unknown) => Promise<unknown>)(tx);
          }),
    );

    await t.passer();
    expect(parti).toBe(true);
    t.base.prisma.$transaction = transaction;

    // Le passage suivant voit une commande pas remise sur une course partie : retirée, reprise ailleurs.
    await t.passer();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
    const autre = t.coursesOuvertes().find((k) => k.id !== s.k.id)!;
    expect(t.livraisonsDe(autre.id).map((l) => l.order_id)).toEqual([s.c.id]);
    expect(t.push.notifyCommandeRetiree).toHaveBeenCalledWith(expect.objectContaining({ delivererId: s.d1.id }));
  });
});

describe('repli v1 : jamais de fenêtre ouverte', () => {
  it('restaurant en v1 : partie à la validation, même avec la nouvelle appli (première livraison démarrée par le serveur)', async () => {
    const s = auComptoir(3);
    const t = monter(s.donnees, { reglages: { 'course.planificateur': 'v1' } });

    await saisirCode(t, s.k.pickup_code);

    expect(s.k.parti_at).toEqual(MAINTENANT);
    expect(t.livraisonsDe(s.k.id)[0].statut).toBe(DeliveryStatut.IN_ROUTE);
    // Rien de v2 n'est journalisé pour un restaurant en v1.
    expect(t.journalDe('COURSE_PARTIE')).toHaveLength(0);
  });
});
