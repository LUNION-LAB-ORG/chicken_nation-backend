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

import { CourseStatut } from '@prisma/client';

import { libelleDirection } from './direction.rules';
import { ILatLng } from './geo.helper';
import { cmd, crs, decale, enPrep, instant, livr, R } from './monde-planification.simulee-spec';
import {
  clePaire,
  CommandePlanif,
  InstantanePlanification,
  OptionsPlanification,
  pairesAOrdonner,
  pairesARegrouper,
  planifier,
  PlanRestaurant,
  REGLAGES_PLANIFICATION_DEFAUT,
} from './planification.rules';
import * as regroupement from './regroupement-tournee.rules';

import {
  auComptoir,
  client,
  commande,
  creation,
  empreinte,
  Geo,
  h,
  jouer,
  livreur,
  plus,
  refusDe,
  reglagesScene,
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

  it('paire compatible (même zone) : lue aussi, après les paires que la direction refuse (relecture du 28/10)', () => {
    const z = T9_MEME_ZONE;
    const inst = instant(t, { commandes: [commande('a', z, { prete: t }), commande('b', z, { prete: t })] });
    expect(pairesARegrouper(inst, new Map(), REGLAGES_PLANIFICATION_DEFAUT).map(([x, y]) => `${x.id}>${y.id}`)).toEqual(['a>b']);
    // Avec une paire refusée par la direction (celle de T3), prête plus tard : elle passe d'abord.
    const c3 = (id: string, de: 'a' | 'b') => ({ ...commande(de, g, { prete: plus(t, 60) }), id, client: { ...client(de, g), id } });
    const deux = instant(t, { commandes: [commande('a', z, { prete: plus(t, -300) }), commande('b', z, { prete: plus(t, -300) }), c3('x', 'a'), c3('y', 'b')] });
    const lues = pairesARegrouper(deux, new Map([[clePaire('x', 'y'), verdictScene(g)]]), REGLAGES_PLANIFICATION_DEFAUT).map(([x, y]) => clePaire(x.id, y.id));
    expect(lues.indexOf(clePaire('x', 'y'))).toBeGreaterThanOrEqual(0);
    expect(lues.indexOf(clePaire('a', 'b'))).toBeGreaterThan(lues.indexOf(clePaire('x', 'y')));
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

/**
 * RELECTURE DU 28/10 : le second avis ne passe jamais devant la règle
 * d'aujourd'hui (porte par porte), voit le livreur sollicité d'une fusion,
 * n'épargne pas un livreur libre au comptoir, lit les paires compatibles, et
 * l'ordre d'une tournée groupée garde sa borne au passage suivant.
 */
describe('relecture du 28/10', () => {
  /** Commande prête à `prete` (passée `avantMin` minutes plus tôt), au point donné, à `route` mètres par la route. */
  const commandeEn = (id: string, position: ILatLng, route: number, prete: Date, o: { avantMin?: number; trace?: ILatLng[] } = {}): CommandePlanif => ({
    ...cmd(id, { created_at: plus(prete, -(o.avantMin ?? 15) * 60), ready_at: prete }),
    client: { id, position, routeMetres: route, trace: o.trace ?? null },
  });
  /** Distances par la route lues comme le service : ordre des arrêts (même course) et paires à regrouper. */
  const commeLeService = (inst: InstantanePlanification, distances: Record<string, number>, r = reglagesScene('coupe')): OptionsPlanification => {
    const d = (x: string, y: string) => distances[clePaire(x, y)];
    const matrice = new Map<string, number>();
    for (const [x, y] of pairesAOrdonner(inst)) if (d(x.id, y.id) !== undefined) matrice.set(clePaire(x.id, y.id), d(x.id, y.id));
    const entreCandidats = new Map<string, number>();
    for (const [x, y] of pairesARegrouper(inst, new Map(), r)) if (d(x.id, y.id) !== undefined) entreCandidats.set(clePaire(x.id, y.id), d(x.id, y.id));
    return { matrice, entreCandidats };
  };
  const jouerInst = (inst: InstantanePlanification, o: OptionsPlanification, turbo: Turbo, autres: Record<string, unknown> = {}) =>
    resume(planifier(inst, reglagesScene(turbo, autres), o));
  const auComptoirAvec = (t: Date, id = 'l') => livreur(t, id, { etat: { en_course: true } });

  const t = h('12:15');
  // Géographie de T2 : A Marcory, B Riviera ; C à 600 m de A (même zone) ; X à 250 m de B.
  const g = T2_PONT_HKB;
  const C: ILatLng = { lat: 5.3105, lng: -3.9635 };
  const X: ILatLng = { lat: 5.3285, lng: -3.9792 };
  const DIST_T2 = { [clePaire('a', 'b')]: 4200, [clePaire('a', 'c')]: 800, [clePaire('b', 'c')]: 4400, [clePaire('b', 'x')]: 300, [clePaire('a', 'x')]: 4400, [clePaire('c', 'x')]: 4500 };

  describe('la règle d’aujourd’hui d’abord, à chaque porte', () => {
    it.each(['coupe', 15] as Turbo[])(
      'création, un livreur (Turbo %s) : A et C (même zone) restent ensemble, B (Riviera) s’y ajoute ensuite',
      (turbo) => {
        const inst = instant(t, {
          position: g.restaurant,
          commandes: [commande('a', g, { prete: plus(t, -120) }), commande('b', g, { prete: plus(t, -60) }), commandeEn('c', C, 3500, t)],
          livreurs: [livreur(t)],
        });
        const o = commeLeService(inst, DIST_T2);
        expect(jouerInst(inst, o, turbo, SANS_SECOND_AVIS)).toEqual(['CREER nouvelle-1 [a,c] MEME_ZONE', 'CREER nouvelle-2 [b]', 'OFFRIR nouvelle-1 -> l']);
        // Avant la relecture : CREER [a,b] TOURNEE_ROUTE, C seule au retour du livreur.
        expect(jouerInst(inst, o, turbo)).toEqual(['CREER nouvelle-1 [a,c,b] TOURNEE_ROUTE', 'OFFRIR nouvelle-1 -> l']);
      },
    );

    it.each(['coupe', 15] as Turbo[])(
      'ajout (Turbo %s) : la course de la même zone (livreur en route) passe devant une tournée avec la course au comptoir',
      (turbo) => {
        const k1 = crs('k1', { statut: CourseStatut.ACCEPTED, deliverer_id: 'm', assigned_at: plus(t, -60), commandes: [commande('a', g, { prete: plus(t, -120) })] });
        const k2 = auComptoir('k2', t, [commande('b', g, { prete: plus(t, -60) })]);
        const inst = instant(t, {
          position: g.restaurant,
          commandes: [commandeEn('c', C, 3500, t)],
          courses: [k1, k2],
          livreurs: [auComptoirAvec(t), livr('m', t, { aEst: 1500, protocole_appli: 4, etat: { en_course: true } })],
        });
        const o = commeLeService(inst, DIST_T2);
        // Avant la relecture, Turbo coupé : AJOUTER c -> k2 TOURNEE_ROUTE (c vers 12 h 55 au lieu de 12 h 40).
        expect(jouerInst(inst, o, turbo)).toEqual(['AJOUTER c -> k1 MEME_ZONE', 'ORDONNER k1 [a,c] AJOUT']);
        expect(jouerInst(inst, o, turbo)).toEqual(jouerInst(inst, o, turbo, SANS_SECOND_AVIS));
      },
    );

    it.each(['coupe', 15] as Turbo[])(
      'ajout puis fusion (Turbo %s) : B rejoint la course compatible sans livreur, qui n’est pas fusionnée dans la course au comptoir',
      (turbo) => {
        const g1 = T1_ANGLE_DROIT;
        const PRES_DE_B: ILatLng = { lat: 5.2935, lng: -3.9552 };
        const k1 = auComptoir('k1', t, [commande('a', g1, { prete: plus(t, -60) })]);
        const k3 = crs('k3', { created_at: plus(t, -20), commandes: [commandeEn('c', PRES_DE_B, 3000, plus(t, -30))], offre: { id: 'o3', deliverer_id: 'm', expires_at: plus(t, 40) } });
        const inst = instant(t, {
          position: g1.restaurant,
          commandes: [commande('b', g1, { prete: t })],
          courses: [k1, k3],
          livreurs: [auComptoirAvec(t), livreur(t, 'm', { etat: { offre_en_attente: true } })],
        });
        const o = commeLeService(inst, { [clePaire('a', 'b')]: 3800, [clePaire('a', 'c')]: 3900, [clePaire('b', 'c')]: 300 });
        // Avant la relecture : AJOUTER b -> k1 puis FUSIONNER k3 -> k1 (B et C au-delà de leur limite, offre de m retirée).
        expect(jouerInst(inst, o, turbo)).toEqual(['AJOUTER b -> k3 MEME_ZONE', 'ORDONNER k3 [b,c] AJOUT']);
      },
    );

    it.each(['coupe', 15] as Turbo[])(
      'ajout puis création (Turbo %s) : deux commandes du même côté du pont gardent leur groupe ; la fusion suit au passage suivant',
      (turbo) => {
        const a = commande('a', g, { prete: plus(t, -60) });
        const b = commande('b', g, { prete: plus(t, -30) });
        const x = commandeEn('x', X, 5800, t, { trace: g.traceB });
        const inst = instant(t, { position: g.restaurant, commandes: [b, x], courses: [auComptoir('k', t, [a])], livreurs: [auComptoirAvec(t)] });
        const o = commeLeService(inst, DIST_T2);
        // Avant la relecture : B puis X ajoutées une à une à la course au comptoir par le second avis.
        const plan = jouerInst(inst, o, turbo);
        expect(plan).toEqual(jouerInst(inst, o, turbo, SANS_SECOND_AVIS));
        expect(plan).toEqual([expect.stringMatching(/^CREER nouvelle-1 \[(x,b|b,x)\] /)]);

        const t2 = plus(t, 10);
        const n1 = crs('n1', { created_at: t, commandes: [b, x] });
        const inst2 = instant(t2, { position: g.restaurant, courses: [auComptoir('k', t2, [a]), n1], livreurs: [auComptoirAvec(t2)] });
        expect(jouerInst(inst2, commeLeService(inst2, DIST_T2), turbo)).toEqual(['FUSIONNER n1 -> k TOURNEE_ROUTE', 'ORDONNER k [a,b,x] FUSION']);
      },
    );

    it.each(['coupe', 15] as Turbo[])(
      'retenue (Turbo %s) : C en cuisine est attendue par la course qui va du même côté, pas par une tournée avec l’autre',
      (turbo) => {
        const c: CommandePlanif = {
          ...enPrep('c', h('12:18'), { created_at: h('12:03'), prepared_at: h('12:04') }),
          client: { ...client('b', g), id: 'c' },
        };
        const k1 = auComptoir('k1', t, [commande('a', g, { prete: t })]);
        const k2 = auComptoir('k2', t, [commandeEn('x', X, 5800, t, { trace: g.traceB })], { deliverer_id: 'm' });
        const inst = instant(t, { position: g.restaurant, commandes: [c], courses: [k1, k2], livreurs: [auComptoirAvec(t), auComptoirAvec(t, 'm')] });
        const o = commeLeService(inst, DIST_T2);
        // Avant la relecture : RETENIR k1 [c] (second avis), alors que la règle d'aujourd'hui retenait k2.
        expect(jouerInst(inst, o, turbo)).toEqual(['RETENIR k2 12:18:00 [c] ATTENTE_COURTE']);
        // Seule course au comptoir : la tournée du second avis l'attend (T7).
        const seule = instant(t, { position: g.restaurant, commandes: [c], courses: [k1], livreurs: [auComptoirAvec(t)] });
        expect(jouerInst(seule, commeLeService(seule, DIST_T2), turbo)).toEqual(['RETENIR k1 12:18:00 [c] ATTENTE_COURTE']);
      },
    );
  });

  describe('fusion : le livreur sollicité par la course absorbée compte dans le plan séparé', () => {
    for (const geo of [T1_ANGLE_DROIT, T2_PONT_HKB, T3_AUTRE_ITINERAIRE]) {
      for (const turbo of ['coupe', 15] as Turbo[]) {
        const t2 = plus(h('12:15'), 10);
        const ka = () => crs('ka', { created_at: t2, commandes: [commande('a', geo, { prete: h('12:14') })], offre: { id: 'o1', deliverer_id: 'l', expires_at: plus(t2, 50) } });
        const b = () => commande('b', geo, { prete: h('12:15') });
        const enAttente = (id: string) => livreur(t2, id, { etat: { offre_en_attente: true } }, geo.restaurant);

        it(`T4 au passage suivant, deux offres en attente : aucune fusion (${geo.nom}, Turbo ${turbo})`, () => {
          const kb = crs('kb', { created_at: t2, commandes: [b()], offre: { id: 'o2', deliverer_id: 'm', expires_at: plus(t2, 50) } });
          const s: Scene = { nom: 'x', t: t2, g: geo, turbo, courses: [ka(), kb], livreurs: [enAttente('l'), enAttente('m')] };
          expect(resume(jouer(s))).toEqual([]);
        });

        it(`T4 au passage suivant, B acceptée par l’autre livreur : aucune fusion (${geo.nom}, Turbo ${turbo})`, () => {
          const kb = auComptoir('kb', t2, [b()], { deliverer_id: 'm' });
          const s: Scene = { nom: 'x', t: t2, g: geo, turbo, courses: [ka(), kb], livreurs: [enAttente('l'), livreur(t2, 'm', { etat: { en_course: true } }, geo.restaurant)] };
          expect(resume(jouer(s))).toEqual([]);
        });
      }
    }
  });

  describe('à retard égal, un livreur libre au comptoir n’est épargné de rien', () => {
    for (const geo of [T1_ANGLE_DROIT, T2_PONT_HKB, T3_AUTRE_ITINERAIRE]) {
      it(`16 h 00, deux livreurs libres, commandes passées 10 min avant d’être prêtes : deux courses (${geo.nom})`, () => {
        const t16 = h('16:00');
        const s = creation(geo, '16:00', 'coupe', {
          commandes: [commande('a', geo, { prete: plus(t16, -60), creee: plus(t16, -660) }), commande('b', geo, { prete: t16, creee: plus(t16, -600) })],
          livreurs: [livreur(t16), livreur(t16, 'm')],
        });
        const plan = commeAujourdhui(s);
        expect(creees(plan)).toHaveLength(2);
        expect(plan.actions.filter((x) => x.type === 'OFFRIR')).toHaveLength(2);
      });
    }
  });

  describe('paires compatibles : leur distance par la route est lue', () => {
    it.each(['coupe', 15] as Turbo[])('C à 600 m de A rejoint la tournée groupée A, B au comptoir (Turbo %s)', (turbo) => {
      const k = auComptoir('k', t, [commande('a', g, { prete: plus(t, -120) }), commande('b', g, { prete: plus(t, -60) })], {
        motif_regroupement: 'tournée groupée plus rapide',
      });
      const inst = instant(t, { position: g.restaurant, commandes: [commandeEn('c', C, 3500, t)], courses: [k], livreurs: [auComptoirAvec(t)] });
      expect(pairesARegrouper(inst, new Map(), reglagesScene(turbo)).map(([x, y]) => clePaire(x.id, y.id))).toEqual(
        expect.arrayContaining([clePaire('a', 'c'), clePaire('b', 'c')]),
      );
      const o = commeLeService(inst, DIST_T2);
      // Avant la relecture : a|c jamais lue, refus DIRECTION, C seule.
      expect(jouerInst(inst, o, turbo, SANS_SECOND_AVIS)).toEqual(['CREER nouvelle-1 [c]']);
      expect(jouerInst(inst, o, turbo)).toEqual(['AJOUTER c -> k TOURNEE_ROUTE', 'ORDONNER k [a,c,b] AJOUT']);
    });

    it.each(['coupe', 15] as Turbo[])(
      'même direction, refusée pour la durée estimée à vol d’oiseau : le second avis la relit par la route (Turbo %s)',
      (turbo) => {
        const A = decale(R, 0, 3000);
        const B = decale(R, 600, 3600);
        // A au comptoir, juste à l'heure (limite à 12 h 28) ; B prête, un seul livreur.
        const a = commandeEn('a', A, 3300, plus(t, -120), { avantMin: 25 });
        const inst = instant(t, { commandes: [commandeEn('b', B, 3700, t)], courses: [auComptoir('k', t, [a])], livreurs: [auComptoirAvec(t)] });
        const o = commeLeService(inst, { [clePaire('a', 'b')]: 1400 }, reglagesScene(turbo));
        expect(o.entreCandidats!.get(clePaire('a', 'b'))).toBe(1400);
        const sans = planifier(inst, reglagesScene(turbo, SANS_SECOND_AVIS), o);
        expect(resume(sans)).toEqual(['CREER nouvelle-1 [b]']);
        expect(refusDe(sans, 'b')).toEqual(['AJOUT:DUREE_TOURNEE']);
        expect(jouerInst(inst, o, turbo)).toEqual(['AJOUTER b -> k TOURNEE_ROUTE', 'ORDONNER k [a,b] AJOUT']);
      },
    );
  });
});

/**
 * Relecture du 28/10 : l'ordre d'une tournée groupée par le second avis,
 * recalculé au passage suivant (meilleur ordre par la route, 27/10), garde
 * la borne de 8 min qui protégeait la commande déjà prévue.
 */
describe('ordre d’une tournée groupée au passage suivant : la borne de 8 min tient', () => {
  const t = h('12:15');
  const auComptoirAvec = (quand: Date) => livreur(quand, 'l', { etat: { en_course: true } });

  it.each([
    ['R-A 3 000 m, R-B 2 000 m, A-B 3 000 m, B passée 11 h 45', 3000, 2000, 3000, '11:45'],
    ['R-A 5 000 m, R-B 4 000 m, A-B 3 000 m, B passée 11 h 40', 5000, 4000, 3000, '11:40'],
  ] as [string, number, number, number, string][])('%s', (_nom, dRA, dRB, dAB, passeeB) => {
    const geo: Geo = { ...T1_ANGLE_DROIT, dRA, dRB, dAB };
    const a = commande('a', geo, { prete: plus(t, -60), creee: h('11:30') });
    const b = commande('b', geo, { prete: t, creee: h(passeeB) });
    const o = (matrice: boolean): OptionsPlanification => ({
      entreCandidats: new Map([[clePaire('a', 'b'), dAB]]),
      ...(matrice ? { matrice: new Map([[clePaire('a', 'b'), dAB]]) } : {}),
    });
    // Passage 1 : B ajoutée, A (déjà en retard) gardée en tête par la borne.
    const p1 = planifier(instant(t, { commandes: [b], courses: [auComptoir('k', t, [a])], livreurs: [auComptoirAvec(t)] }), reglagesScene('coupe'), o(false));
    expect(resume(p1)).toEqual(['AJOUTER b -> k TOURNEE_ROUTE', 'ORDONNER k [a,b] AJOUT']);
    // Passage 2, 10 s plus tard, la course écrite « tournée groupée plus rapide » : pas réordonnée.
    const t2 = plus(t, 10);
    const k2 = (motif: string | null) => auComptoir('k', t2, [a, b], { motif_regroupement: motif });
    const passage2 = (motif: string | null) =>
      resume(planifier(instant(t2, { courses: [k2(motif)], livreurs: [auComptoirAvec(t2)] }), reglagesScene('coupe'), o(true)));
    expect(passage2(libelleDirection('TOURNEE_ROUTE'))).toEqual([]);
    // Une course d'aujourd'hui (autre motif) : le meilleur ordre du 27/10, inchangé.
    expect(passage2('même zone')).toEqual(['ORDONNER k [b,a] MEILLEUR_ORDRE']);
  });
});
