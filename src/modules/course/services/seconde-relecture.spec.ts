/**
 * SECONDE RELECTURE (23/10 au soir) : les constats du serveur en tests de
 * service, chacun avec un test qui échoue sans sa correction. Les VRAIS
 * services sur la base simulée (banc-planificateur.simulee-spec.ts), Google
 * coupé, aucun appel sortant.
 *
 *  - course sans livreur dont toutes les commandes sont annulées : annulée
 *    par le système, son offre close sans pénalité, la commande prête suivante
 *    a sa propre course ;
 *  - commande neuve jamais collée à une course refusée par un livreur libre :
 *    elle lui est proposée ;
 *  - offre forcée par l'administrateur : jamais reprise par le planificateur ;
 *  - offre laissée expirer puis appli rouverte : la course est reproposée ;
 *  - temps Google : un seul appel pour tous les livreurs mesurés, gardé.
 */
import { CourseOfferStatus, CourseStatut, OrderStatus } from '@prisma/client';

import { CourseChannels } from '../enums/course-channels';
import { h, instant, livr } from '../helpers/monde-planification.simulee-spec';
import { etasLivreurs, REGLAGES_PLANIFICATION_DEFAUT } from '../helpers/planification.rules';
import { course, livraison, livreur, offre } from './base-dispatch.simulee-spec';
import { apres, AU_COMPTOIR, avant, B, LOIN, MAINTENANT, monter, prete } from './banc-planificateur.simulee-spec';
import { InstantanePlanificationService } from './instantane-planification.service';

jest.setTimeout(30_000);

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('course sans livreur dont toutes les commandes ont été annulées', () => {
  function videEtPrete() {
    const sollicite = livreur({ ...LOIN, last_available_at: avant(3000) });
    const comptoir = livreur({ ...AU_COMPTOIR, last_available_at: avant(600) });
    const x = prete({ status: OrderStatus.CANCELLED, cancelled_at: avant(3000) });
    const y = prete({ ready_at: avant(10) });
    const k0 = course({ created_at: avant(55 * 60), no_deliverer_alerted_at: avant(48 * 60) });
    const o = offre({ course_id: k0.id, deliverer_id: sollicite.id, offered_at: avant(20), expires_at: apres(100) });
    const t = monter({
      commandes: [x, y],
      courses: [k0],
      livraisons: [livraison({ course_id: k0.id, order_id: x.id })],
      livreurs: [sollicite, comptoir],
      offres: [o],
    });
    return { sollicite, comptoir, x, y, k0, o, t };
  }

  it('annulée par le système (commandes intouchées), offre close sans pénalité ; la commande prête a sa propre course', async () => {
    const { comptoir, x, y, k0, o, t } = videEtPrete();

    const r = await t.passer();

    expect(r?.appliquees[0]).toBe('ANNULER_COURSE_VIDE');
    expect(k0).toMatchObject({ statut: CourseStatut.CANCELLED, cancelled_by: 'system' });
    expect(x.status).toBe(OrderStatus.CANCELLED);
    expect(o.status).toBe(CourseOfferStatus.CANCELLED);
    expect(t.queue.onOfferExpired).not.toHaveBeenCalled();
    expect(t.journalDe('COURSE_VIDE_ANNULEE')).toEqual([expect.objectContaining({ course_id: k0.id })]);
    expect(t.emisSur(CourseChannels.COURSE_CANCELLED)).toContainEqual(
      expect.objectContaining({ course: expect.objectContaining({ id: k0.id }), cancelled_by: 'system' }),
    );
    // Y n'hérite ni de l'âge (expiration à 60 min, cloche déjà sonnée) ni des refus de K0.
    const ky = t.coursesOuvertes().find((k) => t.livraisonsDe(k.id).some((l) => l.order_id === y.id))!;
    expect(ky.id).not.toBe(k0.id);
    expect(t.base.offres.filter((x2) => x2.status === CourseOfferStatus.PENDING)).toEqual([
      expect.objectContaining({ course_id: ky.id, deliverer_id: comptoir.id }),
    ]);
  });

  it('une commande rattachée à la course au même instant : l’annulation est abandonnée', async () => {
    const { k0, t } = videEtPrete();
    const z = prete({ ready_at: avant(5) });
    t.base.commandes.push(z);
    const lire = t.instantanes.lire.bind(t.instantanes);
    jest.spyOn(t.instantanes, 'lire').mockImplementationOnce(async (...args) => {
      const lu = await lire(...args);
      t.base.livraisons.push(livraison({ course_id: k0.id, order_id: z.id, sequence_order: 2 }));
      return lu;
    });

    const r = await t.passer();

    expect(r?.abandonnees).toContainEqual({ type: 'ANNULER_COURSE_VIDE', motif: 'COURSE_CHANGEE' });
    expect(k0.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
  });
});

describe('refus : la commande neuve est proposée au livreur libre qui a refusé une autre course', () => {
  it('K1 refusée par A, proposée à B : B prête part seule et est proposée à A, au comptoir', async () => {
    const A = livreur({ ...AU_COMPTOIR, last_available_at: avant(600) });
    const Bl = livreur({ ...AU_COMPTOIR, last_available_at: avant(500) });
    const a = prete({ ready_at: avant(60) });
    const b = prete({ address: B, ready_at: avant(1) });
    const k1 = course({ created_at: avant(60) });
    const t = monter({
      commandes: [a, b],
      courses: [k1],
      livraisons: [livraison({ course_id: k1.id, order_id: a.id })],
      livreurs: [A, Bl],
      offres: [
        offre({ course_id: k1.id, deliverer_id: A.id, status: CourseOfferStatus.REFUSED, offered_at: avant(50), responded_at: avant(40) }),
        offre({ course_id: k1.id, deliverer_id: Bl.id, offered_at: avant(30), expires_at: apres(90) }),
      ],
    });

    await t.passer();

    expect(t.livraisonsDe(k1.id).map((l) => l.order_id)).toEqual([a.id]);
    const kb = t.coursesOuvertes().find((k) => t.livraisonsDe(k.id).some((l) => l.order_id === b.id))!;
    expect(t.base.offres.filter((o) => o.status === CourseOfferStatus.PENDING)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ course_id: kb.id, deliverer_id: A.id }),
        expect.objectContaining({ course_id: k1.id, deliverer_id: Bl.id }),
      ]),
    );
  });
});

describe('offre forcée par l’administrateur', () => {
  function forcee() {
    const x = livreur({ ...LOIN, last_available_at: avant(3000) });
    const comptoir = livreur({ ...AU_COMPTOIR, last_available_at: avant(60) });
    const a = prete();
    const k = course({ created_at: avant(60) });
    const t = monter({ commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [x, comptoir] });
    return { x, comptoir, k, t };
  }

  it('l’offre forcée vers un livreur lointain n’est pas reprise pour le livreur du comptoir', async () => {
    const { x, k, t } = forcee();
    expect(await t.offres.offerToDeliverer(k.id, x.id, false, true)).toBe(true);
    const [o] = t.base.offres;
    expect(o).toMatchObject({ deliverer_id: x.id, status: CourseOfferStatus.PENDING, forcee: true });

    const r = await t.passer();

    expect(r?.appliquees ?? []).not.toContain('REPRENDRE_OFFRE');
    expect(o.status).toBe(CourseOfferStatus.PENDING);
    expect(t.journalDe('OFFRE_CLOSE')).toEqual([]);
  });

  it('une offre du planificateur, elle, est reprise ; forcée ensuite au même livreur, elle devient intouchable', async () => {
    const { x, k, t } = forcee();
    expect(await t.offres.offerToDeliverer(k.id, x.id)).toBe(true);
    expect(t.base.offres[0].forcee).toBe(false);
    expect(await t.offres.offerToDeliverer(k.id, x.id, false, true)).toBe(true); // renvoi par l'administrateur
    expect(t.base.offres).toHaveLength(1);
    expect(t.base.offres[0].forcee).toBe(true);
    await t.passer();
    expect(t.base.offres[0].status).toBe(CourseOfferStatus.PENDING);

    const autre = forcee();
    await autre.t.offres.offerToDeliverer(autre.k.id, autre.x.id);
    expect((await autre.t.passer())?.appliquees).toEqual(['REPRENDRE_OFFRE', 'OFFRIR']);
  });
});

describe('offre laissée expirer, téléphone en poche, puis appli rouverte au comptoir', () => {
  function expiree(signal: Date | null) {
    const d1 = livreur({ ...AU_COMPTOIR, last_location_at: avant(120), last_available_at: avant(900), dernier_signal_at: signal });
    const a = prete({ ready_at: avant(150) });
    const k = course({ created_at: avant(150) });
    const o = offre({
      course_id: k.id,
      deliverer_id: d1.id,
      status: CourseOfferStatus.EXPIRED,
      offered_at: avant(150),
      expires_at: avant(30),
      responded_at: avant(30),
    });
    const t = monter({ commandes: [a], courses: [k], livraisons: [livraison({ course_id: k.id, order_id: a.id })], livreurs: [d1], offres: [o] });
    return { d1, k, t };
  }

  it('signe de vie après l’expiration : la course lui est reproposée', async () => {
    const { d1, k, t } = expiree(avant(10));
    await t.passer();
    expect(t.base.offres.filter((o) => o.status === CourseOfferStatus.PENDING)).toEqual([
      expect.objectContaining({ course_id: k.id, deliverer_id: d1.id }),
    ]);
  });

  it('aucun signe de vie depuis : rien (il n’a toujours pas vu l’offre)', async () => {
    const { t } = expiree(avant(45));
    await t.passer();
    expect(t.base.offres.filter((o) => o.status === CourseOfferStatus.PENDING)).toEqual([]);
  });
});

describe('temps Google des livreurs : un seul appel pour tous ceux dont le temps se mesure', () => {
  function service(temps: (n: number) => (number | null)[]) {
    const appels: number[] = [];
    const maps = {
      getTravelTimes: jest.fn(async (origines: unknown[]) => {
        appels.push(origines.length);
        return temps(origines.length);
      }),
    };
    const reglagesLivreurs = { load: async () => ({ travelTimeRanking: true }) };
    const s = new InstantanePlanificationService({} as never, {} as never, {} as never, maps as never, reglagesLivreurs as never);
    return { s, appels };
  }
  const t = h('12:31');
  const inst = () =>
    instant(t, {
      livreurs: [
        livr('L1', t, { aEst: 1500 }),
        livr('L2', t, { aEst: -2500 }),
        livr('C1', t, { aEst: 3000, etat: { en_course: true, last_available_at: null } }),
        livr('P', t, { auComptoir: true }),
      ],
    });

  it('libres et livreur en course dans le même appel : les temps Google servent au classement', async () => {
    const { s, appels } = service((n) => Array.from({ length: n }, () => 300));
    const i = inst();
    expect(await s.completerTempsGoogle(i, REGLAGES_PLANIFICATION_DEFAUT)).toBe(true);
    expect(appels).toEqual([3]);
    const etas = etasLivreurs(i.livreurs, i.restaurant.position, REGLAGES_PLANIFICATION_DEFAUT, t);
    expect([etas.get('L1')!.source, etas.get('L2')!.source, etas.get('C1')!.source]).toEqual(['GOOGLE', 'GOOGLE', 'GOOGLE']);
    expect(etas.get('P')!.source).toBe('COMPTOIR');
  });

  it('un temps manquant : rien n’est retenu (vol d’oiseau pour tous) ; un seul livreur libre à départager : aucun appel', async () => {
    const { s } = service((n) => Array.from({ length: n }, (_, k) => (k === 2 ? null : 300)));
    const i = inst();
    expect(await s.completerTempsGoogle(i, REGLAGES_PLANIFICATION_DEFAUT)).toBe(false);
    expect(i.livreurs.every((l) => l.secondes_google === undefined)).toBe(true);

    const seul = service((n) => Array.from({ length: n }, () => 300));
    const i2 = instant(t, { livreurs: [livr('L1', t, { aEst: 1500 }), livr('C1', t, { aEst: 3000, etat: { en_course: true } })] });
    expect(await seul.s.completerTempsGoogle(i2, REGLAGES_PLANIFICATION_DEFAUT)).toBe(false);
    expect(seul.appels).toEqual([]);
  });
});
