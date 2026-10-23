/**
 * SECONDE RELECTURE (23/10 au soir) : les constats sur les règles du
 * planificateur v2, chacun avec un test qui échoue sans sa correction. Les
 * VRAIES règles (`planifier`), sur des instantanés construits à la main.
 *
 *  - course sans livreur dont toutes les commandes sont annulées : jamais une
 *    cible, annulée par le système ;
 *  - commande collée à une course refusée par un livreur libre : elle lui est
 *    proposée seule, et deux courses ne fusionnent pas si un livreur qui
 *    pourrait les prendre en a refusé une ;
 *  - offre forcée par l'administrateur : jamais reprise, jamais close par une
 *    fusion ;
 *  - « attend son sac » : un livreur immobile au comptoir n'envoie plus de
 *    position, la fenêtre l'attend quand même ;
 *  - offre laissée expirer : le livreur redevient candidat dès qu'il donne
 *    signe de vie ; un refus reste définitif ;
 *  - fusion qui reprendrait l'offre du livreur au comptoir pour attendre un
 *    livreur en route : refusée ;
 *  - reprise d'une offre : 2 min d'écart suffisent quand le livreur libre est
 *    au comptoir ;
 *  - Turbo attend au plus 4 min un livreur interne qui revient ;
 *  - commande sans coordonnées : trajet supposé de 12 min.
 *
 * Restaurant Zone 4 ; 12 h 30 = heure de pointe (16 km/h).
 */
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { actionsDe, cmd, crs, enPrep, h, instant, livr, plus, types } from './monde-planification.simulee-spec';
import {
  attendSonSac,
  estCourseVideSansLivreur,
  lireReglagesPlanification,
  planifier,
  REGLAGES_PLANIFICATION_DEFAUT,
  ReglagesPlanification,
  signeDeVieApres,
} from './planification.rules';
import { R } from './monde-planification.simulee-spec';

const REG = REGLAGES_PLANIFICATION_DEFAUT;
const avec = (r: Partial<ReglagesPlanification>): ReglagesPlanification => ({ ...REG, ...r });
const occupe = (id: string, t: Date) => livr(id, t, { etat: { en_course: true, last_available_at: null } });
const refusDe = (plan: ReturnType<typeof planifier>, quoi: string, cle: string) =>
  plan.refus.filter((x) => (x.order_id === quoi || x.source_id === quoi) && x.course_cle === cle).map((x) => x.refus);

describe('course sans livreur dont toutes les commandes ont été annulées', () => {
  const k0 = (o: { offre?: boolean } = {}) =>
    crs('k0', {
      created_at: h('11:35'),
      livraisons: [
        {
          id: 'l-x',
          statut: DeliveryStatut.PENDING,
          sequence_order: 1,
          commande: cmd('x', { statut: OrderStatus.CANCELLED, est: -3000, ready_at: h('11:35') }),
        },
      ],
      offre: o.offre ? { id: 'o-k0', deliverer_id: 'd9', expires_at: h('12:31') } : null,
    });

  it('la commande prête suivante a sa propre course, jamais collée à la course vide (qui est annulée)', () => {
    const t = h('12:30');
    const y = cmd('y', { ready_at: t, created_at: h('12:10'), est: 2500 });
    const plan = planifier(instant(t, { commandes: [y], courses: [k0()], livreurs: [occupe('d1', t), occupe('d2', t)] }));
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(actionsDe(plan, 'CREER_COURSE')).toEqual([expect.objectContaining({ order_ids: ['y'] })]);
    expect(actionsDe(plan, 'ANNULER_COURSE_VIDE')).toEqual([{ type: 'ANNULER_COURSE_VIDE', course_id: 'k0', offre: null, libelle: 'Plus aucune commande à livrer' }]);
    expect(types(plan)[0]).toBe('ANNULER_COURSE_VIDE');

    // Un livreur libre : la commande lui est proposée dans sa course neuve.
    const libre = planifier(instant(t, { commandes: [y], courses: [k0()], livreurs: [livr('d1', t, { auComptoir: true })] }));
    expect(types(libre)).toEqual(['ANNULER_COURSE_VIDE', 'CREER_COURSE', 'OFFRIR']);
    expect(actionsDe(libre, 'OFFRIR')[0]).toMatchObject({ course_cle: 'nouvelle-1', deliverer_id: 'd1' });
  });

  it('offre en attente sur la course vide : rendue pour être close sans pénalité ; jamais proposée ni confiée à Turbo', () => {
    const t = h('12:40');
    const plan = planifier(instant(t, { courses: [k0({ offre: true })], livreurs: [livr('d1', t, { auComptoir: true })] }));
    expect(types(plan)).toEqual(['ANNULER_COURSE_VIDE']);
    expect(actionsDe(plan, 'ANNULER_COURSE_VIDE')[0].offre).toMatchObject({ id: 'o-k0' });
  });

  it('le livreur sollicité par la course vide est libéré dans le même passage : la commande prête lui est proposée', () => {
    const t = h('12:40');
    const y = cmd('y', { ready_at: t, created_at: h('12:20'), est: 2500 });
    const d9 = livr('d9', t, { auComptoir: true, etat: { offre_en_attente: true } });
    const plan = planifier(instant(t, { commandes: [y], courses: [k0({ offre: true })], livreurs: [d9] }));
    expect(types(plan)).toEqual(['ANNULER_COURSE_VIDE', 'CREER_COURSE', 'OFFRIR']);
    expect(actionsDe(plan, 'OFFRIR')[0].deliverer_id).toBe('d9');
  });

  it('jamais une course en train de naître (aucune livraison), ni une course affectée, chez Turbo ou qui a une commande vivante', () => {
    const base = k0();
    expect(estCourseVideSansLivreur(base)).toBe(true);
    expect(estCourseVideSansLivreur({ ...base, livraisons: [] })).toBe(false);
    expect(estCourseVideSansLivreur({ ...base, deliverer_id: 'd1', statut: CourseStatut.ACCEPTED })).toBe(false);
    expect(estCourseVideSansLivreur({ ...base, turbo_escalated_at: h('12:00') })).toBe(false);
    const vivante = { ...base, livraisons: [...base.livraisons, { id: 'l-y', statut: DeliveryStatut.PENDING, sequence_order: 2, commande: cmd('y') }] };
    expect(estCourseVideSansLivreur(vivante)).toBe(false);
    const t = h('12:30');
    expect(actionsDe(planifier(instant(t, { courses: [{ ...base, livraisons: [] }] })), 'ANNULER_COURSE_VIDE')).toEqual([]);
  });
});

describe('refus : une commande neuve n’hérite jamais des refus d’une course', () => {
  it('K1 refusée par A (libre), proposée à B : B prête n’y est pas collée, elle part seule et est proposée à A', () => {
    const t = h('12:31');
    const k1 = crs('k1', {
      commandes: [cmd('a', { ready_at: h('12:30'), est: 2000 })],
      created_at: h('12:30'),
      deja_sollicites: ['A'],
      offre: { id: 'o-b', deliverer_id: 'B', expires_at: h('12:32:30') },
    });
    const plan = planifier(
      instant(t, {
        commandes: [cmd('b', { ready_at: t, est: 2400 })],
        courses: [k1],
        livreurs: [livr('A', t, { auComptoir: true }), livr('B', t, { auComptoir: true, etat: { offre_en_attente: true } })],
      }),
    );
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(refusDe(plan, 'b', 'k1')).toEqual(['DEJA_REFUSEE']);
    expect(actionsDe(plan, 'CREER_COURSE')).toEqual([expect.objectContaining({ order_ids: ['b'] })]);
    expect(actionsDe(plan, 'OFFRIR')).toEqual([expect.objectContaining({ course_cle: 'nouvelle-1', deliverer_id: 'A' })]);
  });

  it('passage suivant : K1 (offre à B) et K2 (offre à A) ne fusionnent dans aucun sens, A ne revoit jamais la commande refusée', () => {
    const t = h('12:31:10');
    const k1 = crs('k1', {
      commandes: [cmd('a', { ready_at: h('12:30'), est: 2000 })],
      created_at: h('12:30'),
      deja_sollicites: ['A'],
      offre: { id: 'o-b', deliverer_id: 'B', expires_at: h('12:32:30') },
    });
    const k2 = crs('k2', {
      commandes: [cmd('b', { ready_at: h('12:31'), est: 2400 })],
      created_at: h('12:31'),
      offre: { id: 'o-a', deliverer_id: 'A', expires_at: h('12:33') },
    });
    const enAttente = { auComptoir: true, etat: { offre_en_attente: true } };
    const plan = planifier(instant(t, { courses: [k1, k2], livreurs: [livr('A', t, enAttente), livr('B', t, enAttente)] }));
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(refusDe(plan, 'k2', 'k1')).toContain('DEJA_REFUSEE');
    expect(refusDe(plan, 'k1', 'k2')).toContain('DEJA_REFUSEE');
  });

  it('le refuseur occupé ailleurs : le regroupement reste permis (personne ne pourrait prendre la commande seule maintenant)', () => {
    const t = h('12:31');
    const k1 = crs('k1', { commandes: [cmd('a', { ready_at: h('12:30'), est: 2000 })], created_at: h('12:30'), deja_sollicites: ['A'] });
    const plan = planifier(
      instant(t, { commandes: [cmd('b', { ready_at: t, est: 2400 })], courses: [k1], livreurs: [occupe('A', t), occupe('B', t)] }),
      avec({ turboActif: false }),
    );
    expect(actionsDe(plan, 'AJOUTER')).toEqual([expect.objectContaining({ course_id: 'k1', order_id: 'b' })]);
  });

  it('fusion vers la course d’un livreur qui a refusé la course absorbée : refusée', () => {
    const t = h('12:33');
    const k = crs('k', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'D1', commandes: [cmd('a', { ready_at: h('12:30'), est: 2000 })] });
    const u = crs('u', { commandes: [cmd('b', { ready_at: h('12:31'), est: 2400 })], created_at: h('12:31'), deja_sollicites: ['D1'] });
    const plan = planifier(instant(t, { courses: [k, u], livreurs: [livr('D1', t, { auComptoir: true, etat: { en_course: true } }), occupe('D2', t)] }));
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(refusDe(plan, 'u', 'k')).toEqual(['DEJA_REFUSEE']);
    // Sans ce refus, la fusion se fait.
    const sansRefus = planifier(
      instant(t, { courses: [k, { ...u, deja_sollicites: [] }], livreurs: [livr('D1', t, { auComptoir: true, etat: { en_course: true } }), occupe('D2', t)] }),
    );
    expect(actionsDe(sansRefus, 'FUSIONNER')).toEqual([expect.objectContaining({ cible_id: 'k', absorbee_id: 'u' })]);
  });
});

describe('offre forcée par l’administrateur', () => {
  it('jamais reprise pour un livreur plus proche ; une offre ordinaire, si', () => {
    const t = h('12:31');
    const k = (forcee: boolean) =>
      crs('k', {
        commandes: [cmd('a', { ready_at: h('12:30'), est: 2000 })],
        offre: { id: 'o-x', deliverer_id: 'X', expires_at: h('12:33'), forcee },
      });
    const x = livr('X', t, { aEst: -4000, etat: { offre_en_attente: true } });
    const forcee = planifier(instant(t, { courses: [k(true)], livreurs: [x, livr('D2', t, { auComptoir: true })] }));
    expect(types(forcee)).toEqual([]);
    const ordinaire = planifier(instant(t, { courses: [k(false)], livreurs: [x, livr('D2', t, { auComptoir: true })] }));
    expect(types(ordinaire)).toEqual(['REPRENDRE_OFFRE', 'OFFRIR']);
  });

  it('jamais absorbée par une fusion, ni vers une course avec livreur ni vers une autre course sans livreur', () => {
    const t = h('12:33');
    const forcee = crs('f', {
      commandes: [cmd('a', { ready_at: h('12:30'), est: 2000 })],
      created_at: h('12:30'),
      offre: { id: 'o-x', deliverer_id: 'X', expires_at: h('12:34'), forcee: true },
    });
    const avecLivreur = crs('k', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'D1', commandes: [cmd('b', { ready_at: h('12:32'), est: 2400 })] });
    const x = livr('X', t, { aEst: -1500, etat: { offre_en_attente: true } });
    const plan = planifier(instant(t, { courses: [forcee, avecLivreur], livreurs: [x, livr('D1', t, { auComptoir: true, etat: { en_course: true } })] }));
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);

    const neuve = crs('v', { commandes: [cmd('c', { ready_at: h('12:32:50'), est: 2500 })], created_at: h('12:32:50') });
    const plan2 = planifier(instant(t, { courses: [forcee, neuve], livreurs: [x, occupe('D1', t)] }));
    // La neuve peut rejoindre la course forcée (son offre est réémise à jour), jamais l'inverse.
    expect(actionsDe(plan2, 'FUSIONNER').every((f) => f.absorbee_id !== 'f')).toBe(true);
  });
});

describe('« attend son sac » : livreur immobile au comptoir, l’appli n’envoie plus rien', () => {
  const A = cmd('a', { est: 2000, created_at: h('12:15'), ready_at: h('12:30'), statut: OrderStatus.PICKED_UP });
  const C = cmd('c', { est: 2300, created_at: h('12:20'), ready_at: h('12:32') });
  const course = () =>
    crs('k1', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd1',
      picked_up_at: h('12:31:00'),
      livraisons: [
        { id: 'la', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: A },
        { id: 'lc', statut: DeliveryStatut.PENDING, sequence_order: 2, ajoutee_apres_retrait: true, commande: C },
      ],
    });

  it('dernière position à son arrivée (12:30) : la fenêtre l’attend, rien n’est retiré à 12:35:05', () => {
    const t = h('12:35:05');
    const plan = planifier(
      instant(t, { courses: [course()], livreurs: [livr('d1', t, { auComptoir: true, position_at: h('12:30:00'), etat: { en_course: true } })] }),
    );
    expect(types(plan)).toEqual([]);
  });

  it('une position à 400 m reçue après le retrait : parti, la commande pas remise est détachée comme avant', () => {
    const t = h('12:35:05');
    const plan = planifier(
      instant(t, { courses: [course()], livreurs: [livr('d1', t, { aEst: 400, position_at: h('12:35:03'), etat: { en_course: true } })] }),
    );
    expect(types(plan)).toEqual(['MARQUER_PARTI', 'DETACHER', 'CREER_COURSE']);
    expect(actionsDe(plan, 'MARQUER_PARTI')[0].motif).toBe('POSITION');
  });

  it('au plus 2 min de plus, et jamais sur une position de plus de 15 min', () => {
    const base = {
      fermeAMs: h('12:35').getTime(),
      sacAttendu: true,
      position: R,
      restaurant: R,
      departRayonM: 250,
    };
    expect(attendSonSac({ ...base, maintenant: h('12:36'), position_at: h('12:29') })).toBe(true);
    expect(attendSonSac({ ...base, maintenant: h('12:37'), position_at: h('12:29') })).toBe(false);
    expect(attendSonSac({ ...base, maintenant: h('12:36'), position_at: h('12:20') })).toBe(false);
  });
});

describe('offre laissée expirer : le livreur redevient candidat dès qu’il donne signe de vie', () => {
  const A = cmd('a', { est: 2000, created_at: h('11:45'), ready_at: h('12:00') });
  const Z = cmd('z', { est: 5000, created_at: h('11:30'), ready_at: h('11:50') });
  const kz = () =>
    crs('kz', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd2',
      picked_up_at: h('11:55'),
      parti_at: h('11:56'),
      livraisons: [{ id: 'lz', statut: DeliveryStatut.IN_ROUTE, sequence_order: 1, commande: { ...Z, statut: OrderStatus.PICKED_UP } }],
    });
  const k1 = (o: { refus?: boolean } = {}) =>
    crs('k1', {
      commandes: [A],
      created_at: h('12:00'),
      deja_sollicites: o.refus ? ['d1'] : [],
      expirees: o.refus ? [] : [{ deliverer_id: 'd1', a: h('12:02') }],
    });
  const d1 = (t: Date, signal: Date | null) =>
    livr('d1', t, {
      auComptoir: true,
      position_at: h('11:59'),
      dernier_signal_at: signal,
      queue_penalty_until: plus(t, 600),
      queue_penalty_positions: 1,
    });
  const d2 = (t: Date) => livr('d2', t, { aEst: 3500, etat: { en_course: true, last_available_at: null } });

  it('sans signe de vie : rien, puis Turbo à 12:06 (comme avant)', () => {
    expect(types(planifier(instant(h('12:03:10'), { courses: [k1(), kz()], livreurs: [d1(h('12:03:10'), h('12:01:30')), d2(h('12:03:10'))] })))).toEqual([]);
    const turbo = planifier(instant(h('12:06'), { courses: [k1(), kz()], livreurs: [d1(h('12:06'), h('12:01:30')), d2(h('12:06'))] }));
    expect(types(turbo)).toEqual(['CONFIER_TURBO']);
  });

  it('appli rouverte à 12:03 : la course lui est reproposée au passage suivant, Turbo n’a plus lieu d’être', () => {
    const t = h('12:03:10');
    const plan = planifier(instant(t, { courses: [k1(), kz()], livreurs: [d1(t, h('12:03')), d2(t)] }));
    expect(actionsDe(plan, 'OFFRIR')).toEqual([expect.objectContaining({ course_id: 'k1', deliverer_id: 'd1' })]);
  });

  it('une position reçue après l’expiration vaut signe de vie ; un REFUS reste définitif', () => {
    const t = h('12:03:10');
    const bouge = livr('d1', t, { auComptoir: true, position_at: h('12:03'), dernier_signal_at: null });
    expect(actionsDe(planifier(instant(t, { courses: [k1(), kz()], livreurs: [bouge, d2(t)] })), 'OFFRIR')).toHaveLength(1);
    expect(types(planifier(instant(t, { courses: [k1({ refus: true }), kz()], livreurs: [d1(t, h('12:03')), d2(t)] })))).toEqual([]);
    expect(signeDeVieApres({ position_at: h('12:01'), dernier_signal_at: h('12:02') }, h('12:02'))).toBe(false);
    expect(signeDeVieApres({ position_at: null, dernier_signal_at: h('12:02:01') }, h('12:02'))).toBe(true);
  });
});

describe('fusion vers un livreur en route : jamais au prix de l’offre faite au livreur du comptoir', () => {
  const A = cmd('a', { est: 2000, created_at: h('12:15'), ready_at: h('12:30') });
  const B = cmd('b', { est: 2300, created_at: h('12:16'), ready_at: h('12:30:30') });

  it('B proposée à D2 au comptoir, D1 (course A acceptée) à 650 m : aucune fusion, l’offre de D2 reste', () => {
    const t = h('12:32:00');
    const plan = planifier(
      instant(t, {
        courses: [
          crs('k1', { statut: CourseStatut.ACCEPTED, deliverer_id: 'd1', commandes: [A], created_at: h('12:30'), assigned_at: h('12:30:05') }),
          crs('k2', { commandes: [B], created_at: h('12:30:31'), offre: { id: 'o2', deliverer_id: 'd2', expires_at: h('12:32:31') } }),
        ],
        livreurs: [livr('d1', t, { aEst: -650, etat: { en_course: true } }), livr('d2', t, { auComptoir: true, etat: { offre_en_attente: true } })],
      }),
    );
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(refusDe(plan, 'k2', 'k1')).toEqual(['OFFRE_EN_COURS']);
  });

  it('D1 déjà au comptoir (course au restaurant) : la fusion ne retarde rien, elle se fait', () => {
    const t = h('12:32:00');
    const plan = planifier(
      instant(t, {
        courses: [
          crs('k1', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [A], created_at: h('12:30'), assigned_at: h('12:30:05') }),
          crs('k2', { commandes: [B], created_at: h('12:30:31'), offre: { id: 'o2', deliverer_id: 'd2', expires_at: h('12:32:31') } }),
        ],
        livreurs: [livr('d1', t, { auComptoir: true, etat: { en_course: true } }), livr('d2', t, { auComptoir: true, etat: { offre_en_attente: true } })],
      }),
    );
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([expect.objectContaining({ cible_id: 'k1', absorbee_id: 'k2', offres_a_clore: [expect.objectContaining({ id: 'o2' })] })]);
  });
});

describe('reprise d’une offre en attente : 2 min suffisent quand le livreur libre est au comptoir', () => {
  const A = cmd('a', { est: 2000, created_at: h('12:15'), ready_at: h('12:30') });
  const t = h('12:30:20');
  const k1 = () => crs('k1', { commandes: [A], offre: { id: 'o1', deliverer_id: 'd1', expires_at: h('12:32:00') } });

  it('D1 à 920 m (4 min 30) sollicité, D2 arrive au comptoir : la course lui revient', () => {
    const plan = planifier(instant(t, { courses: [k1()], livreurs: [livr('d1', t, { aEst: -920, etat: { offre_en_attente: true } }), livr('d2', t, { auComptoir: true })] }));
    expect(types(plan)).toEqual(['REPRENDRE_OFFRE', 'OFFRIR']);
    expect(actionsDe(plan, 'OFFRIR')[0]).toMatchObject({ course_id: 'k1', deliverer_id: 'd2' });
  });

  it('D2 libre à 2 km, hors du comptoir : rien (seuil de 5 min, contre le va-et-vient des estimations)', () => {
    const plan = planifier(instant(t, { courses: [k1()], livreurs: [livr('d1', t, { aEst: -920, etat: { offre_en_attente: true } }), livr('d2', t, { aEst: 2000 })] }));
    expect(types(plan)).toEqual([]);
  });
});

describe('Turbo attend au plus 4 min un livreur interne qui revient', () => {
  const A = cmd('a', { est: 2000, created_at: h('12:15'), ready_at: h('12:30') });
  /** D1 chez son dernier client, à `m` mètres à l'ouest (livraison arrivée), position fraîche. */
  const enRetour = (t: Date, m: number) => {
    const Z = cmd('z', { est: -m, created_at: h('12:00'), ready_at: h('12:20'), statut: OrderStatus.PICKED_UP });
    return {
      course: crs('kz', {
        statut: CourseStatut.IN_DELIVERY,
        deliverer_id: 'd1',
        picked_up_at: h('12:22'),
        parti_at: h('12:23'),
        livraisons: [{ id: 'lz', statut: DeliveryStatut.ARRIVED, sequence_order: 1, commande: Z }],
      }),
      livreur: livr('d1', t, { aEst: -m, etat: { en_course: true, last_available_at: null } }),
    };
  };
  const passage = (t: Date, m: number, r: ReglagesPlanification = REG) => {
    const d1 = enRetour(t, m);
    return planifier(
      instant(t, {
        courses: [crs('k1', { commandes: [A], created_at: h('12:30') }), d1.course],
        livreurs: [d1.livreur, livr('d2', t, { aEst: 6000, etat: { en_course: true, last_available_at: null } })],
      }),
      r,
    );
  };

  it('D1 de retour dans 3 min 30 : pas de Turbo à 12:36:05 ; toujours pas revenu à 12:40:05 : Turbo (4 min de plus au pire)', () => {
    const attente = passage(h('12:36:05'), 100);
    expect(types(attente)).toEqual([]);
    expect(attente.refus).toEqual([expect.objectContaining({ essai: 'TURBO', course_cle: 'k1', refus: 'RETOUR_ATTENDU' })]);
    expect(types(passage(h('12:40:05'), 100))).toEqual(['CONFIER_TURBO']);
  });

  it('réglage à 0, ou D1 de retour dans plus de 4 min : Turbo à l’heure (12:36:05)', () => {
    expect(types(passage(h('12:36:05'), 100, avec({ turboAttenteRetourMaxMin: 0 })))).toEqual(['CONFIER_TURBO']);
    expect(types(passage(h('12:36:05'), 900))).toEqual(['CONFIER_TURBO']);
  });

  it('la promesse ne tiendrait pas avec lui : Turbo à l’heure', () => {
    const tard = cmd('a', { est: 2000, created_at: h('11:50'), ready_at: h('12:30') }); // promise 12:25, déjà dépassée
    const t = h('12:36:05');
    const d1 = enRetour(t, 100);
    const plan = planifier(
      instant(t, { courses: [crs('k1', { commandes: [tard], created_at: h('12:30') }), d1.course], livreurs: [d1.livreur] }),
    );
    expect(types(plan)).toEqual(['CONFIER_TURBO']);
  });

  it('un livreur qui revient pour une seule course : la plus urgente l’attend, l’autre part chez Turbo', () => {
    const t = h('12:36:05');
    const d1 = enRetour(t, 100);
    // Sens opposés : jamais fusionnées. U, plus ancienne, est la plus urgente.
    const urgente = cmd('u', { est: -1500, nord: 300, created_at: h('12:10'), ready_at: h('12:30') });
    const plan = planifier(
      instant(t, {
        courses: [crs('k1', { commandes: [A], created_at: h('12:30') }), crs('ku', { commandes: [urgente], created_at: h('12:30') }), d1.course],
        livreurs: [d1.livreur],
      }),
    );
    expect(actionsDe(plan, 'CONFIER_TURBO').map((a) => a.course_id)).toEqual(['k1']);
    expect(plan.refus.filter((x) => x.essai === 'TURBO').map((x) => x.course_cle)).toEqual(['ku']);
  });

  it('réglage lu : 0 accepté, 4 par défaut, hors bornes refusé et signalé', () => {
    expect(lireReglagesPlanification({}).reglages.turboAttenteRetourMaxMin).toBe(4);
    expect(lireReglagesPlanification({ 'course.turbo_attente_retour_max_min': '0' }).reglages.turboAttenteRetourMaxMin).toBe(0);
    const refuse = lireReglagesPlanification({ 'course.turbo_attente_retour_max_min': '45' });
    expect(refuse.reglages.turboAttenteRetourMaxMin).toBe(4);
    expect(refuse.refusees).toEqual([{ cle: 'course.turbo_attente_retour_max_min', valeur: '45' }]);
  });
});

describe('commande sans coordonnées : trajet supposé de 12 min', () => {
  it('la plus ancienne, sans coordonnées, n’est plus jugée la moins urgente', () => {
    const t = h('12:21:00');
    const X = cmd('x', { sansCoordonnees: true, created_at: h('12:00'), ready_at: h('12:20') });
    const Y = cmd('y', { est: 3000, created_at: h('12:05'), ready_at: h('12:21') });
    const plan = planifier(
      instant(t, {
        courses: [crs('kx', { commandes: [X], created_at: h('12:20') }), crs('ky', { commandes: [Y], created_at: h('12:21') })],
        livreurs: [livr('d1', t, { auComptoir: true })],
      }),
    );
    expect(actionsDe(plan, 'OFFRIR')).toEqual([expect.objectContaining({ course_id: 'kx', deliverer_id: 'd1' })]);
  });

  it('le livreur qui livre un client sans coordonnées n’est pas réputé déjà revenu : la retenue reste possible', () => {
    const A = cmd('a', { est: 2000, created_at: h('12:15'), ready_at: h('12:30') });
    const Bp = enPrep('b', h('12:34'), { est: 2300, created_at: h('12:16') });
    const X = cmd('x', { sansCoordonnees: true, created_at: h('12:00'), ready_at: h('12:18'), statut: OrderStatus.PICKED_UP });
    const t = h('12:30:10');
    const kx = crs('kx', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd2',
      picked_up_at: h('12:19'),
      parti_at: h('12:20'),
      livraisons: [{ id: 'lx', statut: DeliveryStatut.IN_ROUTE, sequence_order: 1, commande: X }],
    });
    const plan = planifier(
      instant(t, {
        commandes: [Bp],
        courses: [crs('k1', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [A], assigned_at: h('12:30:02') }), kx],
        livreurs: [
          livr('d1', t, { auComptoir: true, etat: { en_course: true } }),
          livr('d2', t, { aEst: 3000, position_at: plus(t, -9 * 60), etat: { en_course: true } }),
        ],
      }),
    );
    expect(actionsDe(plan, 'RETENIR')).toEqual([expect.objectContaining({ course_id: 'k1', jusqua: h('12:34') })]);
  });

  it('réglage lu : 12 min par défaut, 0 refusé (une durée nulle dirait le client au restaurant)', () => {
    expect(lireReglagesPlanification({}).reglages.trajetSansCoordonneesMin).toBe(12);
    const zero = lireReglagesPlanification({ 'course.trajet_sans_coordonnees_min': '0' });
    expect(zero.reglages.trajetSansCoordonneesMin).toBe(12);
    expect(zero.refusees).toEqual([{ cle: 'course.trajet_sans_coordonnees_min', valeur: '0' }]);
  });
});
