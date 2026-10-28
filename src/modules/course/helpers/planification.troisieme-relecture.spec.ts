/**
 * TROISIÈME RELECTURE (24/10) : les constats sur les règles du planificateur
 * v2, chacun avec un test qui échoue sans sa correction. Les VRAIES règles
 * (`planifier`), sur des instantanés construits à la main.
 *
 *  - position imprécise (plus de 80 m) : elle ne fait jamais partir la
 *    course, ne retire rien au livreur qui attend son sac et ne le met pas au
 *    comptoir ; seule la dernière position précise décide ;
 *  - retour d'un livreur qui a refusé la course : il ne justifie plus d'y
 *    coller une commande neuve ni de fusionner (Turbo prenait le tout) ;
 *  - ordre des arrêts : le client qui serait en retard au-delà du délai
 *    toléré passe d'abord quand un autre ordre tient toutes les limites ;
 *  - offre en attente d'un livreur sans position récente : reprise au profit
 *    d'un livreur au comptoir.
 *
 * Restaurant Zone 4 ; 12 h 30 = heure de pointe (16 km/h).
 */
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { lirePositionLivreur, positionAEnregistrer } from 'src/modules/deliverers/helpers/position-livreur.rules';

import { actionsDe, cmd, crs, decale, h, instant, livr, plus, R, types } from './monde-planification.simulee-spec';
import {
  estAuRestaurant,
  etasLivreurs,
  planifier,
  REGLAGES_PLANIFICATION_DEFAUT,
  ReglagesPlanification,
} from './planification.rules';

const REG = REGLAGES_PLANIFICATION_DEFAUT;
const avec = (r: Partial<ReglagesPlanification>): ReglagesPlanification => ({ ...REG, ...r });
const occupe = (id: string, t: Date) => livr(id, t, { etat: { en_course: true, last_available_at: null } });
const refusDe = (plan: ReturnType<typeof planifier>, quoi: string, cle: string) =>
  plan.refus.filter((x) => (x.order_id === quoi || x.source_id === quoi) && x.course_cle === cle).map((x) => x.refus);

/**
 * Le livreur tel que l'instantané le lit en base après ce relevé (comme
 * `PATCH /deliverers/me/location`) : dernière position, dernière position
 * précise gardée à côté.
 */
function apresReleve(
  id: string,
  M: Date,
  releve: { position: { lat: number; lng: number }; precision_m: number; a: Date },
  precedente: { position: { lat: number; lng: number }; precision_m: number; a: Date } | null,
  o: Parameters<typeof livr>[2] = {},
) {
  const enBase = positionAEnregistrer(
    { ...releve.position, precision_m: releve.precision_m },
    precedente ? { last_location: { ...precedente.position, precision_m: precedente.precision_m }, last_location_at: precedente.a } : null,
  );
  const lue = lirePositionLivreur(enBase, releve.a);
  return livr(id, M, { ...o, position: lue.position, position_at: lue.position_at, position_sure: lue.sure });
}

describe('position imprécise (relevé « Balanced » dans le restaurant)', () => {
  const M = h('12:30');
  const A300 = decale(R, 0, 300);

  /** D1 a récupéré A il y a `depuisS` ; B ajoutée après le retrait, pas encore remise. */
  function courseRecuperee(depuisS: number) {
    const a = cmd('a', { statut: OrderStatus.PICKED_UP });
    const b = cmd('b', { statut: OrderStatus.READY, est: 2300 });
    return crs('k', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd1',
      picked_up_at: plus(M, -depuisS),
      livraisons: [
        { id: 'la', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: a },
        { id: 'lb', statut: DeliveryStatut.PENDING, sequence_order: 2, ajoutee_apres_retrait: true, commande: b },
      ],
    });
  }
  const auComptoirAvant = (s: number) => ({ position: R, precision_m: 8, a: plus(M, -s) });

  it('300 m à 150 m près après le retrait : la course ne part pas, B reste au livreur qui attend son sac', () => {
    const d1 = apresReleve('d1', M, { position: A300, precision_m: 150, a: plus(M, -5) }, auComptoirAvant(90), {
      etat: { en_course: true },
    });
    const plan = planifier(instant(M, { courses: [courseRecuperee(60)], livreurs: [d1] }));
    expect(actionsDe(plan, 'MARQUER_PARTI')).toEqual([]);
    expect(actionsDe(plan, 'DETACHER')).toEqual([]);

    // Aucune position précise connue : rien ne décide non plus.
    const sansSure = apresReleve('d1', M, { position: A300, precision_m: 150, a: plus(M, -5) }, null, { etat: { en_course: true } });
    expect(actionsDe(planifier(instant(M, { courses: [courseRecuperee(60)], livreurs: [sansSure] })), 'MARQUER_PARTI')).toEqual([]);
  });

  it('la même position, précise : départ (POSITION), B détachée', () => {
    const d1 = apresReleve('d1', M, { position: A300, precision_m: 12, a: plus(M, -5) }, auComptoirAvant(90), {
      etat: { en_course: true },
    });
    const plan = planifier(instant(M, { courses: [courseRecuperee(60)], livreurs: [d1] }));
    expect(actionsDe(plan, 'MARQUER_PARTI').map((x) => x.motif)).toEqual(['POSITION']);
    expect(actionsDe(plan, 'DETACHER').map((x) => x.order_id)).toEqual(['b']);
  });

  it('une position précise hors du rayon, reçue après le retrait, fait partir même si le relevé suivant est imprécis', () => {
    const sortie = { position: decale(R, 0, 600), precision_m: 10, a: plus(M, -20) };
    const d1 = apresReleve('d1', M, { position: decale(R, 0, 700), precision_m: 150, a: plus(M, -5) }, sortie, {
      etat: { en_course: true },
    });
    expect(actionsDe(planifier(instant(M, { courses: [courseRecuperee(60)], livreurs: [d1] })), 'MARQUER_PARTI').map((x) => x.motif)).toEqual([
      'POSITION',
    ]);
  });

  it('fenêtre échue, sac attendu : la prolongation tient sur la dernière position précise (au comptoir)', () => {
    // Retrait il y a 250 s (fenêtre de 240 s) ; au comptoir à 10 m près il y a 100 s, puis un relevé grossier à 300 m.
    const d1 = apresReleve('d1', M, { position: A300, precision_m: 150, a: plus(M, -5) }, auComptoirAvant(100), {
      etat: { en_course: true },
    });
    const plan = planifier(instant(M, { courses: [courseRecuperee(250)], livreurs: [d1] }));
    expect(actionsDe(plan, 'MARQUER_PARTI')).toEqual([]);
    expect(actionsDe(plan, 'DETACHER')).toEqual([]);
  });

  it('un relevé grossier qui tombe près du restaurant ne met pas au comptoir un livreur qui en est loin', () => {
    const loin = { position: decale(R, 0, 3000), precision_m: 10, a: plus(M, -120) };
    const d1 = apresReleve('d1', M, { position: decale(R, 0, 100), precision_m: 300, a: plus(M, -10) }, loin);
    expect(estAuRestaurant(d1, R, REG, M)).toBe(false);
    expect(etasLivreurs([d1], R, REG, M).get('d1')).toMatchObject({ au_comptoir: false, source: 'VOL_OISEAU' });

    // Un relevé précis au comptoir, lui, le met au comptoir.
    const d1b = apresReleve('d1', M, { position: decale(R, 0, 30), precision_m: 15, a: plus(M, -10) }, loin);
    expect(estAuRestaurant(d1b, R, REG, M)).toBe(true);
  });
});

describe('retour d’un livreur qui a refusé la course', () => {
  // D a refusé K (A, 2 km à l'est, prête à 12 h 27), puis a pris une course courte X : il revient vers 12 h 34 30.
  const a = cmd('a', { ready_at: h('12:27'), created_at: h('12:15') });
  const q = cmd('q', { ready_at: h('12:30'), created_at: h('12:20'), est: 2100 });
  const x1 = cmd('x1', { statut: OrderStatus.PICKED_UP, est: 300, ready_at: h('12:20') });
  const X = crs('x', {
    statut: CourseStatut.IN_DELIVERY,
    deliverer_id: 'd',
    picked_up_at: h('12:25'),
    parti_at: h('12:26'),
    livraisons: [{ id: 'lx', statut: DeliveryStatut.IN_ROUTE, sequence_order: 1, commande: x1 }],
  });
  const dEnCourse = (M: Date) =>
    livr('d', M, { etat: { en_course: true, last_available_at: null }, position: decale(R, 0, 290), position_at: plus(M, -10) });
  const K = (refusee: boolean) => crs('k', { created_at: h('12:27'), deja_sollicites: refusee ? ['d'] : [], commandes: [a] });

  it('12 h 30 : q n’est pas collée à K (elle avancerait sa bascule vers Turbo) ; elle a sa propre course', () => {
    const M = h('12:30');
    const plan = planifier(instant(M, { commandes: [q], courses: [K(true), X], livreurs: [dEnCourse(M)] }));
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(refusDe(plan, 'q', 'k')).toEqual(['AVANCE_TURBO']);
    expect(actionsDe(plan, 'CREER_COURSE').map((x) => x.order_ids)).toEqual([['q']]);
  });

  it('contre-épreuve : D n’a pas refusé K, son retour justifie l’ajout', () => {
    const M = h('12:30');
    const plan = planifier(instant(M, { commandes: [q], courses: [K(false), X], livreurs: [dEnCourse(M)] }));
    expect(actionsDe(plan, 'AJOUTER').map((x) => [x.order_id, x.course_id])).toEqual([['q', 'k']]);
  });

  it('fusion de deux courses sans livreur : le retour de D, qui a refusé l’une, ne la justifie pas', () => {
    const M = h('12:30');
    const N = crs('n', { created_at: h('12:30'), commandes: [q] });
    const plan = planifier(instant(M, { courses: [K(true), N, X], livreurs: [dEnCourse(M)] }));
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(refusDe(plan, 'k', 'n')).toContain('AVANCE_TURBO');

    const sansRefus = planifier(instant(M, { courses: [K(false), N, X], livreurs: [dEnCourse(M)] }));
    expect(actionsDe(sansRefus, 'FUSIONNER')).toHaveLength(1);
  });

  it('12 h 33 10 : seule K part chez Turbo ; N (q) attend D, proposée à son retour', () => {
    const M = h('12:33:10');
    const N = crs('n', { created_at: h('12:30'), commandes: [q] });
    const plan = planifier(instant(M, { courses: [K(true), N, X], livreurs: [dEnCourse(M)] }));
    expect(actionsDe(plan, 'CONFIER_TURBO').map((x) => x.course_id)).toEqual(['k']);

    const M2 = h('12:34:40');
    const plan2 = planifier(instant(M2, { courses: [N], livreurs: [livr('d', M2, { auComptoir: true })] }));
    expect(actionsDe(plan2, 'OFFRIR').map((x) => [x.course_id, x.deliverer_id])).toEqual([['n', 'd']]);
  });
});

describe('ordre des arrêts : le client qui serait en retard passe d’abord', () => {
  const t = h('12:30');
  // Q : 2,4 km à l'est ; P : 1,7 km à l'est et 250 m au nord, créée à 12 h 20 (promesse 12 h 55).
  const Q = (creee: string) => cmd('q', { est: 2400, created_at: h(creee), ready_at: h('12:28') });
  const P = cmd('p', { est: 1700, nord: 250, created_at: h('12:20'), ready_at: t });
  const K = (creee: string) => crs('k', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [Q(creee)], created_at: h('12:28') });
  const d1 = livr('d1', t, { auComptoir: true, etat: { en_course: true } });

  it('Q promise à 12 h 38 (limite 12 h 43) : P puis Q la mettait à 12 h 48 ; Q puis P tient tout, P est ajoutée', () => {
    const plan = planifier(instant(t, { commandes: [P], courses: [K('12:03')], livreurs: [d1, occupe('d2', t)] }));
    expect(actionsDe(plan, 'AJOUTER').map((x) => [x.order_id, x.course_id])).toEqual([['p', 'k']]);
    expect(actionsDe(plan, 'ORDONNER').map((x) => x.sequence)).toEqual([['q', 'p']]);
    expect(actionsDe(plan, 'CREER_COURSE')).toEqual([]);
  });

  it('durée de tournée maximale : l’autre ordre (20 min 36, 7 min 59 de plus que Q seule) ne la dépasse jamais ; à 20 min et 6 min de détour maximal, refus comme avant', () => {
    const plan = planifier(
      instant(t, { commandes: [P], courses: [K('12:03')], livreurs: [d1, occupe('d2', t)] }),
      avec({ dureeTourneeMaxMin: 20, detourMaxAjoutMin: 6 }),
    );
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(refusDe(plan, 'p', 'k')).toEqual(['RETARD_CLIENT']);
  });

  it('à 20 min avec le détour maximal par défaut (8 min) : l’autre ordre passe, il n’allonge Q seule que de 7 min 59 (borne du 28/10)', () => {
    const plan = planifier(instant(t, { commandes: [P], courses: [K('12:03')], livreurs: [d1, occupe('d2', t)] }), avec({ dureeTourneeMaxMin: 20 }));
    expect(actionsDe(plan, 'AJOUTER').map((x) => [x.order_id, x.course_id])).toEqual([['p', 'k']]);
    expect(actionsDe(plan, 'ORDONNER').map((x) => x.sequence)).toEqual([['q', 'p']]);
  });

  it('retard dans le délai toléré (Q promise à 12 h 47) : l’ordre du trajet reste, sans revenir sur ses pas', () => {
    const plan = planifier(instant(t, { commandes: [P], courses: [K('12:12')], livreurs: [d1, occupe('d2', t)] }));
    expect(actionsDe(plan, 'AJOUTER').map((x) => x.order_id)).toEqual(['p']);
    expect(actionsDe(plan, 'ORDONNER').map((x) => x.sequence)).toEqual([['p', 'q']]);
  });

  it('nouvelle course de deux commandes prêtes : la plus pressée d’abord', () => {
    const libre = livr('d1', t, { auComptoir: true });
    const plan = planifier(instant(t, { commandes: [Q('12:03'), P], livreurs: [libre] }));
    expect(actionsDe(plan, 'CREER_COURSE').map((x) => x.sequence)).toEqual([['q', 'p']]);
  });

  it('aucun enjeu de promesse : ordre du trajet inchangé', () => {
    const plan = planifier(instant(t, { commandes: [P], courses: [K('12:20')], livreurs: [d1, occupe('d2', t)] }));
    expect(actionsDe(plan, 'ORDONNER').map((x) => x.sequence)).toEqual([['p', 'q']]);
  });
});

describe('offre en attente d’un livreur sans position récente', () => {
  const t = h('12:31');
  const K = (forcee = false) =>
    crs('k', { commandes: [cmd('a', { ready_at: h('12:30') })], offre: { id: 'o1', deliverer_id: 'd1', expires_at: h('12:32'), forcee } });
  const sansPositionRecente = () => livr('d1', t, { position: R, position_at: plus(t, -20 * 60), etat: { offre_en_attente: true } });

  it('un livreur arrive au comptoir : l’offre est reprise sans pénalité et lui est proposée', () => {
    const plan = planifier(instant(t, { courses: [K()], livreurs: [sansPositionRecente(), livr('d2', t, { auComptoir: true })] }));
    expect(types(plan)).toEqual(['REPRENDRE_OFFRE', 'OFFRIR']);
    expect(actionsDe(plan, 'OFFRIR').map((x) => x.deliverer_id)).toEqual(['d2']);
  });

  it('livreur sollicité au comptoir (position de 10 min), offre forcée, ou candidat hors du comptoir : rien', () => {
    const d1Comptoir = livr('d1', t, { position: R, position_at: plus(t, -10 * 60), etat: { offre_en_attente: true } });
    expect(types(planifier(instant(t, { courses: [K()], livreurs: [d1Comptoir, livr('d2', t, { auComptoir: true })] })))).toEqual([]);
    expect(types(planifier(instant(t, { courses: [K(true)], livreurs: [sansPositionRecente(), livr('d2', t, { auComptoir: true })] })))).toEqual([]);
    expect(types(planifier(instant(t, { courses: [K()], livreurs: [sansPositionRecente(), livr('d2', t, { aEst: 1000 })] })))).toEqual([]);
  });
});
