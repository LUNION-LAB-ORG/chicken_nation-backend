/**
 * REGROUPEMENT APRÈS L'ESSAI DU 25/10, côté services (conception
 * `.banc-test-crm/regroupement-correction.md`, scénarios S10 à S13).
 *
 *  - S10 : la caisse remet A pendant une retenue (code, ou bouton « Livreur
 *    a récupéré ») : le livreur reçoit « Attends 4 min / Départ 15 h 34 »,
 *    jamais « Sacs remis / Tu peux partir » ;
 *  - S11 : retenue levée après la remise : « Tout est récupéré / Tu peux
 *    partir », ou « Commande ajoutée / Code 421 au restaurant » quand la
 *    commande attendue vient d'être ajoutée ; avant la remise, « Tout est
 *    prêt » comme avant ;
 *  - S12 : retenue reposée pour une commande entrée en préparation après sa
 *    fin, écrite seulement si la retenue n'a pas bougé depuis la lecture ;
 *  - S13 : refus du planificateur journalisés (PLAN_REFUS), une ligne par
 *    refus et par 10 min, passage sans action compris.
 *
 * Les VRAIS services sur la base simulée (banc-planificateur.simulee-spec.ts),
 * 15 h 30 hors pointe, restaurant Zone 4, A à 2 km à l'est, B à 4 km.
 */
import { CourseStatut, OrderStatus, OrderType } from '@prisma/client';

import { commande, course, DonneesDispatch, livraison, livreur, RESTO } from './base-dispatch.simulee-spec';
import { apres, AU_COMPTOIR, avant, B, MAINTENANT, monter, prete } from './banc-planificateur.simulee-spec';

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** La caisse saisit le code de retrait (caisse Sunmi : restaurant de son compte). */
const saisirCode = (t: ReturnType<typeof monter>, code: string) =>
  t.actions.validatePickupByCashier({ pickup_code: code, restaurant_id: RESTO } as never, undefined);

/** Ce que `PATCH /orders/:id/status` émet après avoir passé la commande PICKED_UP (bouton de la caisse). */
const boutonCaisse = (o: Record<string, any>) => {
  o.status = OrderStatus.PICKED_UP;
  o.picked_up_at = new Date();
  return { order: { ...o, type: OrderType.DELIVERY } } as never;
};

/** B en cuisine, même direction, finie dans `dansS` secondes (durée de la cuisine). */
const enCuisine = (dansS: number, prepareeIlYaS = 600) =>
  commande({
    status: OrderStatus.IN_PROGRESS,
    address: B,
    created_at: avant(prepareeIlYaS + 60),
    updated_at: avant(prepareeIlYaS),
    prepared_at: avant(prepareeIlYaS),
    estimated_preparation_time: apres(dansS),
  });

const attendue = (o: Record<string, any>, vers: Date) => ({
  order_id: o.id,
  reference: o.reference,
  prete_vers: vers.toISOString(),
  prete_au_plus_tard: vers.toISOString(),
  motif: 'ATTENTE_COURTE',
});

/**
 * D1 au comptoir (appli de l'essai, protocole 4 par défaut), sa course K au
 * comptoir avec A prête ; B en cuisine attendue jusqu'à 15 h 34 (`retenue`).
 */
function auComptoirRetenu(o: { protocole?: number; retenue?: boolean } = {}) {
  const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: o.protocole ?? 4 });
  const a = prete({ ready_at: avant(20) });
  const b = enCuisine(240);
  const k = course({
    statut: CourseStatut.AT_RESTAURANT,
    deliverer_id: d1.id,
    assigned_at: avant(200),
    at_restaurant_at: avant(100),
    created_at: avant(300),
    ...(o.retenue === false ? {} : { retenue_jusqua: apres(240), commandes_attendues: [attendue(b, apres(240))] }),
  });
  const donnees: DonneesDispatch = {
    commandes: [a, b],
    courses: [k],
    livraisons: [livraison({ course_id: k.id, order_id: a.id })],
    livreurs: [d1],
  };
  return { d1, a, b, k, donnees };
}

describe('S10. remise de A pendant une retenue : le livreur attend, il ne part pas', () => {
  it('code de retrait : « Attends 4 min / Départ 15 h 34 », jamais « Sacs remis / Tu peux partir »', async () => {
    const s = auComptoirRetenu();
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);
    expect(s.k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(s.k.parti_at).toBeNull();
    expect(t.push.notifyCourseAttente).toHaveBeenCalledWith({
      delivererId: s.d1.id,
      courseId: s.k.id,
      titre: 'Attends 4 min',
      corps: 'Départ 15 h 34',
      jusqua: apres(240),
      attendues: [s.b.reference],
    });
    expect(t.push.notifyPickupValidated).not.toHaveBeenCalled();
  });

  it('code de retrait sans retenue : « Sacs remis / Tu peux partir », comme avant', async () => {
    const s = auComptoirRetenu({ retenue: false });
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledWith(expect.objectContaining({ delivererId: s.d1.id, courseId: s.k.id }));
    expect(t.push.notifyCourseAttente).not.toHaveBeenCalled();
  });

  it('retenue échue (pas encore levée) à la remise : « Sacs remis », comme avant', async () => {
    const s = auComptoirRetenu();
    s.k.retenue_jusqua = avant(5);
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
    expect(t.push.notifyCourseAttente).not.toHaveBeenCalled();
  });

  it('appli au protocole 2 (fenêtre fermée d’office) : partie à la remise, « Sacs remis », comme avant', async () => {
    const s = auComptoirRetenu({ protocole: 2 });
    const t = monter(s.donnees);
    await saisirCode(t, s.k.pickup_code);
    expect(s.k.parti_at).toEqual(MAINTENANT);
    expect(t.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
    expect(t.push.notifyCourseAttente).not.toHaveBeenCalled();
  });

  it('bouton « Livreur a récupéré » : même chose (retenue, sans retenue, protocole 2)', async () => {
    const avec = auComptoirRetenu();
    const t1 = monter(avec.donnees);
    await t1.remiseCaisse.onStatutCommande(boutonCaisse(avec.a));
    expect(avec.k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(t1.push.notifyCourseAttente).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: avec.d1.id, titre: 'Attends 4 min', corps: 'Départ 15 h 34' }),
    );
    expect(t1.push.notifyPickupValidated).not.toHaveBeenCalled();

    const sans = auComptoirRetenu({ retenue: false });
    const t2 = monter(sans.donnees);
    await t2.remiseCaisse.onStatutCommande(boutonCaisse(sans.a));
    expect(t2.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
    expect(t2.push.notifyCourseAttente).not.toHaveBeenCalled();

    const ancienne = auComptoirRetenu({ protocole: 2 });
    const t3 = monter(ancienne.donnees);
    await t3.remiseCaisse.onStatutCommande(boutonCaisse(ancienne.a));
    expect(ancienne.k.parti_at).not.toBeNull();
    expect(t3.push.notifyPickupValidated).toHaveBeenCalledTimes(1);
    expect(t3.push.notifyCourseAttente).not.toHaveBeenCalled();
  });

  it('dernier sac remis (commande ajoutée) pendant une retenue pour une autre commande : « Attends », pas « Tu peux partir »', async () => {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 4 });
    const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(60), ready_at: avant(90) });
    const c = prete({ address: B, ready_at: avant(10) });
    const b = enCuisine(180);
    const k = course({
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: d1.id,
      assigned_at: avant(400),
      at_restaurant_at: avant(300),
      picked_up_at: avant(60),
      created_at: avant(600),
      retenue_jusqua: apres(180),
      commandes_attendues: [attendue(b, apres(180))],
    });
    const t = monter({
      commandes: [a, b, c],
      courses: [k],
      livraisons: [
        livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }),
        livraison({ course_id: k.id, order_id: c.id, sequence_order: 2, ajoutee_at: avant(10), ajoutee_apres_retrait: true }),
      ],
      livreurs: [d1],
    });
    await saisirCode(t, k.pickup_code);
    expect(c.status).toBe(OrderStatus.PICKED_UP);
    expect(t.push.notifyCourseAttente).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: d1.id, titre: 'Attends 3 min', corps: 'Départ 15 h 33' }),
    );
    expect(t.push.notifyCommandeRemise).not.toHaveBeenCalled();
  });
});

describe('S11. retenue levée : le bon texte selon que le livreur a déjà ses sacs', () => {
  /** K récupérée à 15 h 29, livreur au comptoir, B attendue. */
  function recupereeRetenue(o: { retenueJusqua: Date; bPrete: boolean }) {
    const d1 = livreur({ ...AU_COMPTOIR, last_location_at: avant(70), last_available_at: null, protocole_appli: 4 });
    const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(60), ready_at: avant(90) });
    const b = o.bPrete ? prete({ address: B, ready_at: avant(1), created_at: avant(900) }) : enCuisine(120);
    const k = course({
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: d1.id,
      assigned_at: avant(300),
      at_restaurant_at: avant(200),
      picked_up_at: avant(60),
      created_at: avant(400),
      retenue_jusqua: o.retenueJusqua,
      commandes_attendues: [attendue(b, o.retenueJusqua)],
    });
    const donnees: DonneesDispatch = {
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d1],
    };
    return { d1, a, b, k, donnees };
  }

  it('échéance après la remise, rien à reprendre : « Tout est récupéré / Tu peux partir »', async () => {
    const s = recupereeRetenue({ retenueJusqua: avant(5), bPrete: false });
    const t = monter(s.donnees);
    await t.passer();
    expect(t.journalDe('RETENUE_LEVEE')).toEqual([expect.objectContaining({ course_id: s.k.id, motif: 'ECHEANCE' })]);
    expect(t.push.notifyCommandeRemise).toHaveBeenCalledWith({
      delivererId: s.d1.id,
      courseId: s.k.id,
      titre: 'Tout est récupéré',
      corps: 'Tu peux partir',
    });
    expect(t.push.notifyCourseToutPret).not.toHaveBeenCalled();
  });

  it('B prête et ajoutée après la remise : « Commande ajoutée / Code 421 au restaurant »', async () => {
    const s = recupereeRetenue({ retenueJusqua: apres(120), bPrete: true });
    const t = monter(s.donnees);
    await t.passer();
    expect(t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id, s.b.id]);
    expect(t.journalDe('RETENUE_LEVEE')).toEqual([expect.objectContaining({ course_id: s.k.id, motif: 'TOUT_PRET' })]);
    expect(t.push.notifyCommandeAjoutee).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: s.d1.id, titre: 'Commande ajoutée', corps: `Code ${s.k.pickup_code} au restaurant`, apresRetrait: true }),
    );
    expect(t.push.notifyCourseToutPret).not.toHaveBeenCalled();
    expect(t.push.notifyCommandeRemise).not.toHaveBeenCalled();
  });

  it('avant la remise (au comptoir) : « Tout est prêt / 2 commandes · code 421 », comme avant', async () => {
    const s = auComptoirRetenu();
    s.b.status = OrderStatus.READY;
    s.b.ready_at = avant(1);
    const t = monter(s.donnees);
    await t.passer();
    expect(t.push.notifyCourseToutPret).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: s.d1.id, titre: 'Tout est prêt', corps: `2 commandes · code ${s.k.pickup_code}` }),
    );
    expect(t.push.notifyCommandeRemise).not.toHaveBeenCalled();
  });
});

describe('S12. retenue reposée pour une commande entrée en préparation après sa fin', () => {
  /** K au comptoir, retenue levée il y a 30 s ; C entrée en cuisine il y a 10 s, finie dans 2 min. */
  function levee() {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 4 });
    const a = prete({ ready_at: avant(60) });
    const c = enCuisine(120, 10);
    const k = course({
      statut: CourseStatut.AT_RESTAURANT,
      deliverer_id: d1.id,
      assigned_at: avant(300),
      at_restaurant_at: avant(200),
      created_at: avant(400),
      retenue_jusqua: avant(30),
      commandes_attendues: [],
    });
    const donnees: DonneesDispatch = {
      commandes: [a, c],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d1],
    };
    return { d1, a, c, k, donnees };
  }

  it('écrite, le livreur est prévenu', async () => {
    const s = levee();
    const t = monter(s.donnees);
    await t.passer();
    expect(s.k.retenue_jusqua).toEqual(apres(120));
    expect(s.k.commandes_attendues).toEqual([expect.objectContaining({ order_id: s.c.id })]);
    expect(t.journalDe('COURSE_RETENUE')).toHaveLength(1);
    expect(t.push.notifyCourseAttente).toHaveBeenCalledWith(
      expect.objectContaining({ delivererId: s.d1.id, titre: 'Attends 2 min', corps: 'Départ 15 h 32' }),
    );
  });

  it('la retenue a bougé entre la lecture et l’écriture : abandonnée (COURSE_CHANGEE), rien d’écrit', async () => {
    const s = levee();
    const t = monter(s.donnees);
    const lire = t.instantanes.lire.bind(t.instantanes);
    jest.spyOn(t.instantanes, 'lire').mockImplementation(async (...args: Parameters<typeof lire>) => {
      const lu = await lire(...args);
      s.k.retenue_jusqua = avant(20); // levée encore une fois ailleurs
      return lu;
    });
    const resultat = await t.passer();
    expect(resultat?.abandonnees).toEqual([{ type: 'RETENIR', motif: 'COURSE_CHANGEE' }]);
    expect(s.k.retenue_jusqua).toEqual(avant(20));
    expect(t.push.notifyCourseAttente).not.toHaveBeenCalled();
  });
});

describe('S13. refus du planificateur journalisés (PLAN_REFUS)', () => {
  /** K au comptoir avec A ; B en cuisine pour 30 min (trajet court) : refus HORIZON, aucune action. */
  function horizon() {
    const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 4 });
    const a = prete({ ready_at: avant(20) });
    const b = enCuisine(30 * 60, 60);
    const k = course({ statut: CourseStatut.AT_RESTAURANT, deliverer_id: d1.id, assigned_at: avant(200), at_restaurant_at: avant(100) });
    const donnees: DonneesDispatch = {
      commandes: [a, b],
      courses: [k],
      livraisons: [livraison({ course_id: k.id, order_id: a.id })],
      livreurs: [d1],
    };
    return { d1, a, b, k, donnees };
  }

  it('passage sans action : le refus est écrit ; le même refus au passage suivant, non ; 10 min plus tard, de nouveau', async () => {
    const s = horizon();
    const t = monter(s.donnees);
    const r1 = await t.passer();
    expect(r1?.appliquees).toEqual([]);
    expect(t.journalDe('PLAN_REFUS')).toEqual([
      expect.objectContaining({
        motif: 'HORIZON',
        source: 'serveur',
        restaurant_id: RESTO,
        order_id: s.b.id,
        course_id: s.k.id,
        details: expect.objectContaining({ essai: 'RETENUE', course_cle: s.k.id, source_id: null }),
      }),
    ]);
    jest.setSystemTime(apres(10));
    await t.passer();
    expect(t.journalDe('PLAN_REFUS')).toHaveLength(1);
    jest.setSystemTime(apres(10 * 60 + 5));
    await t.passer();
    expect(t.journalDe('PLAN_REFUS')).toHaveLength(2);
  });

  it('motif qui change : une nouvelle ligne', async () => {
    const s = horizon();
    const d2 = livreur({ ...AU_COMPTOIR, last_available_at: avant(60), protocole_appli: 4 });
    const t = monter({ ...s.donnees, livreurs: [s.d1] });
    await t.passer();
    // B annoncée dans 9 min (trajet long pour D1), D2 libre au comptoir la prendrait seule.
    t.base.livreurs.push(d2);
    s.b.estimated_preparation_time = apres(10 + 9 * 60);
    jest.setSystemTime(apres(10));
    await t.passer();
    expect(t.journalDe('PLAN_REFUS').map((l) => l.motif)).toEqual(['HORIZON', 'AUTRE_LIVREUR_LIBRE']);
  });
});
