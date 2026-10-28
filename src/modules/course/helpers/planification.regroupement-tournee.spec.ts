/**
 * REGROUPEMENT PAR TOURNÉE, scènes jouées par `planifier` (retour du client
 * du 28/10, conception `regroupement-tournee.md`, section 9) :
 *
 *   « il arrive souvent des commandes peuvent être livrées groupées, mais le
 *   système ne les groupe pas car il choisit l'itinéraire le plus rapide (…)
 *   on avait un seul livreur disponible, il y avait 2 commandes »
 *
 * La règle de direction refuse ; le second avis compare alors la tournée
 * groupée, dans le meilleur ordre PAR LA ROUTE, aux livraisons séparées avec
 * les livreurs vraiment disponibles (un seul livreur : la seconde attend son
 * retour, ou part chez Turbo). Il groupe quand les clients y gagnent.
 *
 * Scènes : `regroupement-tournee.simulee-spec.ts`. Heures détaillées des
 * deux plans : `regroupement-tournee.rules.spec.ts`.
 */
import { createHash } from 'crypto';

import { cmd, crs, enPrep, instant } from './monde-planification.simulee-spec';
import { clePaire, pairesARegrouper, PlanRestaurant, REGLAGES_PLANIFICATION_DEFAUT } from './planification.rules';
import * as regroupement from './regroupement-tournee.rules';

import {
  commande,
  creation,
  empreinte,
  h,
  jouer,
  livreur,
  plus,
  refusDe,
  resume,
  SANS_SECOND_AVIS,
  Scene,
  sceneT10,
  sceneT5,
  sceneT7,
  sceneT8,
  T1_ANGLE_DROIT,
  T2_PONT_HKB,
  T3_AUTRE_ITINERAIRE,
  T6_SENS_OPPOSES,
  T9_MEME_ZONE,
  toutesLesScenes,
  Turbo,
  verdictScene,
} from './regroupement-tournee.simulee-spec';

/** Une course pour les deux, proposée au seul livreur. */
const UNE_COURSE = (sequence: string) => [`CREER nouvelle-1 [${sequence}] TOURNEE_ROUTE`, 'OFFRIR nouvelle-1 -> l'];

/** Le plan d'aujourd'hui (rien de groupé de plus) : identique avec l'interrupteur coupé. */
function commeAujourdhui(s: Scene) {
  const plan = jouer(s);
  expect(resume(plan)).toEqual(resume(jouer(s, SANS_SECOND_AVIS)));
  return plan;
}

const creees = (plan: ReturnType<typeof jouer>) => plan.actions.filter((a) => a.type === 'CREER_COURSE');

const HEURES_ET_TURBO = [
  ['12:15', 'coupe'],
  ['12:15', 15],
  ['16:00', 'coupe'],
  ['16:00', 15],
] as ['12:15' | '16:00', Turbo][];

describe('T1. un seul livreur, deux commandes à angle droit (Zone 4)', () => {
  it('aujourd’hui la direction refuse (« direction différente ») : deux courses', () => {
    const plan = jouer(creation(T1_ANGLE_DROIT, '12:15', 'coupe'), SANS_SECOND_AVIS);
    expect(resume(plan).filter((x) => x.startsWith('CREER'))).toEqual(['CREER nouvelle-1 [a]', 'CREER nouvelle-2 [b]']);
    expect(refusDe(plan, 'b')).toEqual(['CREATION:DIRECTION']);
  });

  it.each(HEURES_ET_TURBO)('%s, Turbo %s : une course, A puis B', (heure, turbo) => {
    expect(resume(jouer(creation(T1_ANGLE_DROIT, heure, turbo)))).toEqual(UNE_COURSE('a,b'));
  });

  it('Turbo en 0 min : séparées, les deux à l’heure (le groupe casserait la promesse de B)', () => {
    expect(creees(commeAujourdhui(creation(T1_ANGLE_DROIT, '12:15', 0)))).toHaveLength(2);
  });
});

describe('T2. de part et d’autre du pont HKB (Zone 4)', () => {
  it.each(HEURES_ET_TURBO)('%s, Turbo %s : une course, Marcory puis Riviera', (heure, turbo) => {
    expect(resume(jouer(creation(T2_PONT_HKB, heure, turbo)))).toEqual(UNE_COURSE('a,b'));
  });
});

describe('T3. cas du client : un autre itinéraire (Zone 4)', () => {
  it('aujourd’hui : « détour de 9 min, trop long », deux courses', () => {
    const plan = jouer(creation(T3_AUTRE_ITINERAIRE, '12:15', 'coupe'), SANS_SECOND_AVIS);
    expect(creees(plan)).toHaveLength(2);
    expect(plan.refus.find((x) => x.order_id === 'b')).toMatchObject({ refus: 'DIRECTION', libelle: 'détour de 9 min, trop long' });
  });

  it.each(HEURES_ET_TURBO)('%s, Turbo %s : une course, A puis B', (heure, turbo) => {
    expect(resume(jouer(creation(T3_AUTRE_ITINERAIRE, heure, turbo)))).toEqual(UNE_COURSE('a,b'));
  });

  it('Turbo en 0 min : séparées (le groupe est pire)', () => {
    expect(creees(commeAujourdhui(creation(T3_AUTRE_ITINERAIRE, '12:15', 0)))).toHaveLength(2);
  });
});

describe('T4. deux livreurs libres : toujours séparées, comme aujourd’hui', () => {
  for (const g of [T1_ANGLE_DROIT, T2_PONT_HKB, T3_AUTRE_ITINERAIRE]) {
    for (const [heure, turbo] of HEURES_ET_TURBO) {
      it(`${g.nom}, ${heure}, Turbo ${turbo}`, () => {
        const t = h(heure);
        const plan = commeAujourdhui(creation(g, heure, turbo, { livreurs: [livreur(t), livreur(t, 'm')] }));
        expect(creees(plan)).toHaveLength(2);
        expect(plan.actions.filter((a) => a.type === 'OFFRIR')).toHaveLength(2);
      });
    }
  }
});

describe('T5. commande déjà en retard (géographie de T1, 12 h 15)', () => {
  it.each(['coupe', 15] as Turbo[])('A (graine) passée 11 h 30, déjà au-delà de sa limite : une course, A d’abord (Turbo %s)', (turbo) => {
    expect(resume(jouer(sceneT5('A_EN_RETARD', turbo)))).toEqual(UNE_COURSE('a,b'));
  });

  it.each(['coupe', 15] as Turbo[])('B passée 11 h 30, A (graine) à l’heure : une course, B d’abord (Turbo %s)', (turbo) => {
    expect(resume(jouer(sceneT5('B_EN_RETARD', turbo)))).toEqual(UNE_COURSE('b,a'));
  });

  it.each(['coupe', 15] as Turbo[])(
    'A en retard dans la course au comptoir, B passée 11 h 45 : ajoutée, A gardée en tête par la borne de 8 min (Turbo %s)',
    (turbo) => {
      expect(resume(jouer(sceneT5('AJOUT_AU_COMPTOIR', turbo)))).toEqual(['AJOUTER b -> k TOURNEE_ROUTE', 'ORDONNER k [a,b] AJOUT']);
    },
  );
});

describe('T6. sens vraiment opposés, 10 km chacun (Angré) : séparées', () => {
  it.each([
    ['12:15', 'coupe', {}],
    ['12:15', 15, {}],
    ['16:00', 'coupe', {}],
    ['12:15', 'coupe', { regroupementTourneeMaxMin: 240 }],
    ['12:15', 15, { regroupementTourneeMaxMin: 240 }],
  ] as ['12:15' | '16:00', Turbo, Record<string, unknown>][])('%s, Turbo %s, %j', (heure, turbo, autres) => {
    expect(creees(commeAujourdhui(creation(T6_SENS_OPPOSES, heure, turbo, { autres })))).toHaveLength(2);
  });
});

describe('T7. retenue au comptoir (géographie de T2) : la course attend B au lieu de Turbo', () => {
  it('aujourd’hui : retenue refusée (DIRECTION), le livreur part avec A', () => {
    const plan = jouer(sceneT7(15, 1), SANS_SECOND_AVIS);
    expect(resume(plan)).toEqual([]);
    expect(refusDe(plan, 'b')).toEqual(['RETENUE:DIRECTION']);
  });

  it.each([15, 'coupe'] as Turbo[])('12 h 15, Turbo %s : RETENIR jusqu’à 12 h 18 (attente courte, règle inchangée)', (turbo) => {
    expect(resume(jouer(sceneT7(turbo, 1)))).toEqual(['RETENIR k 12:18:00 [b] ATTENTE_COURTE']);
  });

  it.each([15, 'coupe'] as Turbo[])('12 h 18, B prête, Turbo %s : ajoutée à la course qui l’attendait', (turbo) => {
    expect(resume(jouer(sceneT7(turbo, 2)))).toEqual(['AJOUTER b -> k TOURNEE_ROUTE', 'ORDONNER k [a,b] AJOUT', 'LIBERER k TOUT_PRET']);
  });
});

describe('T8. promesse tenue cassée (géographie de T3, 12 h 15)', () => {
  it('Turbo coupé : retenue jusqu’à 12 h 20, puis une course (23 min de retard total en moins)', () => {
    expect(resume(jouer(sceneT8('coupe')))).toEqual(['RETENIR k 12:20:00 [b] ATTENTE_COURTE']);
  });

  it('Turbo coupé, gain exigé réglé à 0 : jamais une promesse tenue cassée, pas de retenue', () => {
    expect(resume(commeAujourdhui(sceneT8('coupe', { regroupementGainMin: 0 })))).toEqual([]);
  });

  it('Turbo en 15 min : 4 min de gain seulement, pas de retenue', () => {
    expect(resume(commeAujourdhui(sceneT8(15)))).toEqual([]);
  });
});

describe('T9. groupe accepté aujourd’hui : rien ne change', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['coupe', 15] as Turbo[])('Biétry, même zone (Turbo %s) : même action, même ordre, motif MEME_ZONE', (turbo) => {
    const plan = commeAujourdhui(creation(T9_MEME_ZONE, '12:15', turbo));
    expect(creees(plan)).toEqual([expect.objectContaining({ order_ids: expect.arrayContaining(['a', 'b']), motif: 'MEME_ZONE' })]);
  });

  it('le second avis n’est jamais appelé pour un groupe que la règle d’aujourd’hui accepte', () => {
    const espion = jest.spyOn(regroupement, 'comparerPlans');
    jouer(creation(T9_MEME_ZONE, '12:15', 15));
    expect(espion).not.toHaveBeenCalled();
    // Témoin : il l'est quand la direction refuse (T1).
    jouer(creation(T1_ANGLE_DROIT, '12:15', 15));
    expect(espion).toHaveBeenCalled();
  });
});

describe('T10. distance entre les clients manquante, puis connue (géographie de T3)', () => {
  it('passage 1, distance absente : la règle d’aujourd’hui, deux courses', () => {
    expect(creees(commeAujourdhui({ ...creation(T3_AUTRE_ITINERAIRE, '12:15', 15), candidats: false }))).toHaveLength(2);
  });

  it('distance depuis le restaurant inconnue pour l’une : la règle d’aujourd’hui', () => {
    const t = h('12:15');
    const g = T3_AUTRE_ITINERAIRE;
    const s = creation(g, '12:15', 15, {
      commandes: [commande('a', g, { prete: plus(t, -60) }), commande('b', g, { prete: t, sansRoute: true })],
    });
    expect(creees(commeAujourdhui(s))).toHaveLength(2);
  });

  it('passage 2, offre en attente, Turbo coupé : fusion vers la course proposée', () => {
    expect(resume(jouer(sceneT10('coupe', false)))).toEqual(['FUSIONNER ka -> kb TOURNEE_ROUTE', 'ORDONNER kb [a,b] FUSION']);
  });

  it('passage 2, offre en attente, Turbo en 15 min : fusion (la course de A garde le livreur sollicité)', () => {
    expect(resume(jouer(sceneT10(15, false))).filter((x) => x.startsWith('FUSIONNER'))).toEqual(['FUSIONNER kb -> ka TOURNEE_ROUTE']);
  });

  it('passage 2, livreur au comptoir avec B, Turbo coupé : fusion vers sa course, B gardée en tête', () => {
    expect(resume(jouer(sceneT10('coupe', true)))).toEqual(['FUSIONNER ka -> kb TOURNEE_ROUTE', 'ORDONNER kb [b,a] FUSION']);
  });

  it('passage 2, livreur au comptoir avec B, Turbo en 15 min : séparées (A par Turbo arrive avant la tournée B puis A)', () => {
    expect(commeAujourdhui(sceneT10(15, true)).actions.filter((x) => x.type === 'FUSIONNER')).toEqual([]);
  });
});

/** Comparaison jointe au refus d'une commande (ou d'une course absorbée). */
const comparaison = (plan: PlanRestaurant, id: string) =>
  plan.refus.filter((x) => (x.order_id === id || x.source_id === id) && x.comparaison).map((x) => `${x.essai}:${x.refus}:${x.comparaison!.decision}`);

describe('refus maintenu : la comparaison est jointe au refus d’aujourd’hui (journal PLAN_REFUS)', () => {
  it.each([
    ['T1, Turbo en 0 min', creation(T1_ANGLE_DROIT, '12:15', 0), 'b', ['CREATION:DIRECTION:PROMESSE_CASSEE']],
    ['T3, Turbo en 0 min', creation(T3_AUTRE_ITINERAIRE, '12:15', 0), 'b', ['CREATION:DIRECTION:PIRE']],
    ['T6 par défaut', creation(T6_SENS_OPPOSES, '12:15', 'coupe'), 'b', ['CREATION:DIRECTION:TOURNEE_MAX']],
    ['T6 plafond 240, Turbo coupé', creation(T6_SENS_OPPOSES, '12:15', 'coupe', { autres: { regroupementTourneeMaxMin: 240 } }), 'b', ['CREATION:DIRECTION:EGAL']],
    ['T8, gain réglé à 0', sceneT8('coupe', { regroupementGainMin: 0 }), 'b', ['RETENUE:DIRECTION:PROMESSE_CASSEE']],
    ['T8, Turbo en 15 min', sceneT8(15), 'b', ['RETENUE:DIRECTION:PROMESSE_CASSEE']],
    ['T10, livreur au comptoir avec B, Turbo en 15 min', sceneT10(15, true), 'ka', ['FUSION:DIRECTION:PIRE']],
  ] as [string, Scene, string, string[]][])('%s', (_nom, s, id, attendu) => {
    expect(comparaison(jouer(s), id)).toEqual(attendu);
  });

  it('deux livreurs libres : PROMESSE_CASSEE ou PIRE, la seconde partirait avec l’autre livreur', () => {
    const t = h('12:15');
    const plan = jouer(creation(T3_AUTRE_ITINERAIRE, '12:15', 15, { livreurs: [livreur(t), livreur(t, 'm')] }));
    const x = plan.refus.find((r) => r.order_id === 'b')!;
    expect(x.comparaison).toMatchObject({ decision: 'PROMESSE_CASSEE', depart_second: 'AUTRE_LIVREUR' });
  });

  it('création : le refus nomme la commande graine (le journal dédoublonne sur elle)', () => {
    const plan = jouer(creation(T1_ANGLE_DROIT, '12:15', 0));
    expect(plan.refus.find((x) => x.essai === 'CREATION')).toMatchObject({ order_id: 'b', graine_id: 'a', course_cle: 'nouvelle-1' });
  });

  it('interrupteur coupé : aucune comparaison', () => {
    const plan = jouer(creation(T1_ANGLE_DROIT, '12:15', 0), SANS_SECOND_AVIS);
    expect(plan.refus.filter((x) => x.comparaison)).toEqual([]);
  });
});

describe('pairesARegrouper : les distances à lire pour le second avis', () => {
  const t = h('12:15');
  const g = T3_AUTRE_ITINERAIRE;
  const verdicts = new Map([[clePaire('a', 'b'), verdictScene(g)]]);
  const deux = () => [commande('a', g, { prete: plus(t, -60) }), commande('b', g, { prete: t })];
  const paires = (inst: ReturnType<typeof instant>, r = REGLAGES_PLANIFICATION_DEFAUT) =>
    pairesARegrouper(inst, verdicts, r).map(([x, y]) => `${x.id}>${y.id}`);

  it('paire refusée par la direction, distances depuis le restaurant connues : lue, du plus proche vers le plus lointain', () => {
    expect(paires(instant(t, { commandes: deux() }))).toEqual(['a>b']);
  });

  it('interrupteur coupé, restaurant sans coordonnées, ou une distance depuis le restaurant inconnue : aucune', () => {
    expect(paires(instant(t, { commandes: deux() }), { ...REGLAGES_PLANIFICATION_DEFAUT, regroupementTournee: false })).toEqual([]);
    expect(paires(instant(t, { commandes: deux(), position: null }))).toEqual([]);
    const sansRoute = [commande('a', g, { prete: t }), commande('b', g, { prete: t, sansRoute: true })];
    expect(paires(instant(t, { commandes: sansRoute }))).toEqual([]);
  });

  it('deux commandes d’une même course : lues par l’ordre des arrêts, pas ici', () => {
    expect(paires(instant(t, { courses: [crs('k', { commandes: deux() })] }))).toEqual([]);
  });

  it('paire compatible (même zone) : jamais lue', () => {
    const z = T9_MEME_ZONE;
    const inst = instant(t, { commandes: [commande('a', z, { prete: t }), commande('b', z, { prete: t })] });
    expect(pairesARegrouper(inst, new Map(), REGLAGES_PLANIFICATION_DEFAUT)).toEqual([]);
  });

  it('paire perdue d’avance (12 km de part et d’autre) : jamais lue', () => {
    const loin = (id: string, nord: number) => ({ ...cmd(id, { nord, est: 0, ready_at: t }), client: { ...cmd(id, { nord, est: 0 }).client, routeMetres: 15_000 } });
    const inst = instant(t, { commandes: [loin('a', 12_000), loin('b', -12_000)] });
    expect(pairesARegrouper(inst, new Map(), REGLAGES_PLANIFICATION_DEFAUT)).toEqual([]);
  });

  it('au plus 60 paires, la plus ancienne commande prête d’abord ; une commande en cuisine compte à sa fin estimée', () => {
    const autour = Array.from({ length: 16 }, (_, i) => {
      const angle = (i * 2 * Math.PI) / 16;
      const c = cmd(`c${String(i).padStart(2, '0')}`, { nord: 2500 * Math.cos(angle), est: 2500 * Math.sin(angle), ready_at: plus(t, -60 * (16 - i)) });
      return { ...c, client: { ...c.client, routeMetres: 3500 } };
    });
    const enCuisine = enPrep('cuisine', plus(t, 120), { nord: -2500, est: 100 });
    const inst = instant(t, { commandes: [...autour, { ...enCuisine, client: { ...enCuisine.client, routeMetres: 3500 } }] });
    const lues = pairesARegrouper(inst, new Map(), REGLAGES_PLANIFICATION_DEFAUT);
    expect(lues).toHaveLength(regroupement.PAIRES_REGROUPEMENT_LUES_MAX);
    // c00 est la plus ancienne : ses paires passent d'abord.
    expect(lues.slice(0, 3).every(([x, y]) => x.id === 'c00' || y.id === 'c00')).toBe(true);
  });
});

/**
 * T12. Interrupteur coupé (`course.regroupement_tournee` = non) : sur toutes
 * les scènes, le plan de main 3165827, action par action, refus compris.
 * Empreintes relevées sur main, avant la règle.
 */
const EMPREINTES_MAIN: Record<string, string> = {
  'T1 angle droit, Anoumabo / Koumassi, 12:15, Turbo coupé': 'a545845e35512b5e',
  'T1 angle droit, Anoumabo / Koumassi, 12:15, Turbo coupe, deux livreurs': '54d749c00dd6f9bd',
  'T1 angle droit, Anoumabo / Koumassi, 12:15, Turbo 15 min': 'a545845e35512b5e',
  'T1 angle droit, Anoumabo / Koumassi, 12:15, Turbo 15, deux livreurs': '54d749c00dd6f9bd',
  'T1 angle droit, Anoumabo / Koumassi, 12:15, Turbo 0 min': 'a545845e35512b5e',
  'T1 angle droit, Anoumabo / Koumassi, 12:15, Turbo 0, deux livreurs': '54d749c00dd6f9bd',
  'T1 angle droit, Anoumabo / Koumassi, 16:00, Turbo coupé': '28510072ce416307',
  'T1 angle droit, Anoumabo / Koumassi, 16:00, Turbo coupe, deux livreurs': '05ecdbceb0633c64',
  'T1 angle droit, Anoumabo / Koumassi, 16:00, Turbo 15 min': '28510072ce416307',
  'T1 angle droit, Anoumabo / Koumassi, 16:00, Turbo 15, deux livreurs': '05ecdbceb0633c64',
  'T1 angle droit, Anoumabo / Koumassi, 16:00, Turbo 0 min': '28510072ce416307',
  'T1 angle droit, Anoumabo / Koumassi, 16:00, Turbo 0, deux livreurs': '05ecdbceb0633c64',
  'T2 pont HKB, Marcory / Riviera, 12:15, Turbo coupé': '0312c58203bd652b',
  'T2 pont HKB, Marcory / Riviera, 12:15, Turbo coupe, deux livreurs': '39dca45474518d41',
  'T2 pont HKB, Marcory / Riviera, 12:15, Turbo 15 min': '0312c58203bd652b',
  'T2 pont HKB, Marcory / Riviera, 12:15, Turbo 15, deux livreurs': '39dca45474518d41',
  'T2 pont HKB, Marcory / Riviera, 12:15, Turbo 0 min': '0312c58203bd652b',
  'T2 pont HKB, Marcory / Riviera, 12:15, Turbo 0, deux livreurs': '39dca45474518d41',
  'T2 pont HKB, Marcory / Riviera, 16:00, Turbo coupé': '73da81aec1f5c3bb',
  'T2 pont HKB, Marcory / Riviera, 16:00, Turbo coupe, deux livreurs': 'fbb50e302adce74d',
  'T2 pont HKB, Marcory / Riviera, 16:00, Turbo 15 min': '73da81aec1f5c3bb',
  'T2 pont HKB, Marcory / Riviera, 16:00, Turbo 15, deux livreurs': 'fbb50e302adce74d',
  'T2 pont HKB, Marcory / Riviera, 16:00, Turbo 0 min': '73da81aec1f5c3bb',
  'T2 pont HKB, Marcory / Riviera, 16:00, Turbo 0, deux livreurs': 'fbb50e302adce74d',
  'T3 cas du client, autre itinéraire, 12:15, Turbo coupé': '26cfa02a28586dba',
  'T3 cas du client, autre itinéraire, 12:15, Turbo coupe, deux livreurs': 'fa1fd4104be933db',
  'T3 cas du client, autre itinéraire, 12:15, Turbo 15 min': '26cfa02a28586dba',
  'T3 cas du client, autre itinéraire, 12:15, Turbo 15, deux livreurs': 'fa1fd4104be933db',
  'T3 cas du client, autre itinéraire, 12:15, Turbo 0 min': '26cfa02a28586dba',
  'T3 cas du client, autre itinéraire, 12:15, Turbo 0, deux livreurs': 'fa1fd4104be933db',
  'T3 cas du client, autre itinéraire, 16:00, Turbo coupé': '1e64567dcc63436c',
  'T3 cas du client, autre itinéraire, 16:00, Turbo coupe, deux livreurs': '243b90258a8348e9',
  'T3 cas du client, autre itinéraire, 16:00, Turbo 15 min': '1e64567dcc63436c',
  'T3 cas du client, autre itinéraire, 16:00, Turbo 15, deux livreurs': '243b90258a8348e9',
  'T3 cas du client, autre itinéraire, 16:00, Turbo 0 min': '1e64567dcc63436c',
  'T3 cas du client, autre itinéraire, 16:00, Turbo 0, deux livreurs': '243b90258a8348e9',
  'T6 sens opposés, 10 km chacun, 12:15, Turbo coupé': '84f1330101ba0157',
  'T6 sens opposés, 10 km chacun, 12:15, Turbo coupe, deux livreurs': '3227c1be8a26d13e',
  'T6 sens opposés, 10 km chacun, 12:15, Turbo 15 min': '84f1330101ba0157',
  'T6 sens opposés, 10 km chacun, 12:15, Turbo 15, deux livreurs': '3227c1be8a26d13e',
  'T6 sens opposés, 10 km chacun, 12:15, Turbo 0 min': '84f1330101ba0157',
  'T6 sens opposés, 10 km chacun, 12:15, Turbo 0, deux livreurs': '3227c1be8a26d13e',
  'T6 sens opposés, 10 km chacun, 16:00, Turbo coupé': 'dd4d81a3de33cb1f',
  'T6 sens opposés, 10 km chacun, 16:00, Turbo coupe, deux livreurs': '18d3f0306bee4ddb',
  'T6 sens opposés, 10 km chacun, 16:00, Turbo 15 min': 'dd4d81a3de33cb1f',
  'T6 sens opposés, 10 km chacun, 16:00, Turbo 15, deux livreurs': '18d3f0306bee4ddb',
  'T6 sens opposés, 10 km chacun, 16:00, Turbo 0 min': 'dd4d81a3de33cb1f',
  'T6 sens opposés, 10 km chacun, 16:00, Turbo 0, deux livreurs': '18d3f0306bee4ddb',
  'T9 Biétry, même zone, 12:15, Turbo coupé': 'a5d8b9225de28f52',
  'T9 Biétry, même zone, 12:15, Turbo coupe, deux livreurs': 'a5d8b9225de28f52',
  'T9 Biétry, même zone, 12:15, Turbo 15 min': 'a5d8b9225de28f52',
  'T9 Biétry, même zone, 12:15, Turbo 15, deux livreurs': 'a5d8b9225de28f52',
  'T9 Biétry, même zone, 12:15, Turbo 0 min': 'a5d8b9225de28f52',
  'T9 Biétry, même zone, 12:15, Turbo 0, deux livreurs': 'a5d8b9225de28f52',
  'T9 Biétry, même zone, 16:00, Turbo coupé': 'b543004aff3efe48',
  'T9 Biétry, même zone, 16:00, Turbo coupe, deux livreurs': 'b543004aff3efe48',
  'T9 Biétry, même zone, 16:00, Turbo 15 min': 'b543004aff3efe48',
  'T9 Biétry, même zone, 16:00, Turbo 15, deux livreurs': 'b543004aff3efe48',
  'T9 Biétry, même zone, 16:00, Turbo 0 min': 'b543004aff3efe48',
  'T9 Biétry, même zone, 16:00, Turbo 0, deux livreurs': 'b543004aff3efe48',
  'T6 plafond 240, Turbo coupé': '84f1330101ba0157',
  'T6 plafond 240, Turbo 15': '84f1330101ba0157',
  'T5 A_EN_RETARD, Turbo coupe': '0a87cd39d6bab5ed',
  'T5 B_EN_RETARD, Turbo coupe': 'bd495abf229ab91d',
  'T5 AJOUT_AU_COMPTOIR, Turbo coupe': '7f7048d994da7c22',
  'T7 passage 1, Turbo coupe': '72a6025c10bf2858',
  'T7 passage 2, Turbo coupe': 'a2658fd7d81ec1c0',
  'T10 passage 2, offre en attente, Turbo coupe': '1d82366e728d01b3',
  'T10 passage 2, acceptée, Turbo coupe': '5e992af91913e365',
  'T5 A_EN_RETARD, Turbo 15': '0a87cd39d6bab5ed',
  'T5 B_EN_RETARD, Turbo 15': 'bd495abf229ab91d',
  'T5 AJOUT_AU_COMPTOIR, Turbo 15': '7f7048d994da7c22',
  'T7 passage 1, Turbo 15': '72a6025c10bf2858',
  'T7 passage 2, Turbo 15': 'a2658fd7d81ec1c0',
  'T10 passage 2, offre en attente, Turbo 15': '1d82366e728d01b3',
  'T10 passage 2, acceptée, Turbo 15': '5e992af91913e365',
  'T8, Turbo coupe, {}': 'a85aa789c4a4d012',
  'T8, Turbo coupe, {"regroupementGainMin":0}': 'a85aa789c4a4d012',
  'T8, Turbo 15, {}': 'a85aa789c4a4d012',
};

describe('T12. interrupteur coupé : le plan de main, à l’identique', () => {
  const sha = (x: string) => createHash('sha256').update(x).digest('hex').slice(0, 16);
  for (const s of toutesLesScenes()) {
    it(s.nom, () => {
      expect(sha(empreinte(jouer(s, SANS_SECOND_AVIS)))).toBe(EMPREINTES_MAIN[s.nom]);
    });
  }
});
