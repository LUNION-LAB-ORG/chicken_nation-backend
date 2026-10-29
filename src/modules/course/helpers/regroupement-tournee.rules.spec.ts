/**
 * SECOND AVIS du regroupement, règle pure (`regroupement-tournee.rules.ts`) :
 * les heures des deux plans de chaque scène de la conception
 * (`regroupement-tournee.md`, section 9), à une minute près, et chaque
 * motif de la décision.
 *
 * Arrivées : mètres par la route / vitesse de l'heure (16 km/h en pointe,
 * 22 km/h hors pointe) + 3 min chez chaque client précédent. Commandes
 * passées 15 min avant d'être prêtes : promesse = passée + 35 min, limite =
 * promesse + 5 min.
 */
import { h } from './monde-planification.simulee-spec';
import { clePaireArrets } from './ordre-arrets.rules';
import { ARRET_CLIENT_S, REGLAGES_PLANIFICATION_DEFAUT, vitesseKmh } from './planification.rules';
import {
  ArretTournee,
  comparerPlans,
  DecisionRegroupement,
  LimitesRegroupement,
  resumeComparaison,
  SituationRegroupement,
} from './regroupement-tournee.rules';

const MIN = 60_000;

/** Commande : prête à `prete` (« HH:MM »), passée `avantMin` minutes plus tôt, à `metres` du restaurant par la route. */
function arret(id: string, prete: string, metres: number, o: { passee?: string; promesse?: string } = {}): ArretTournee {
  const preteMs = h(prete).getTime();
  const passee = o.passee ? h(o.passee).getTime() : preteMs - 15 * MIN;
  const promesseMs = o.promesse ? h(o.promesse).getTime() : passee + 35 * MIN;
  return { id, promesseMs, limiteMs: promesseMs + 5 * MIN, preteMs, routeMetres: metres };
}

/** Turbo coupé, ou actif avec ce délai de prise en charge. */
function limites(turbo: 'coupe' | number, autres: Partial<LimitesRegroupement> = {}): LimitesRegroupement {
  return {
    tourneeMaxMin: 50,
    detourMaxMin: 8,
    gainMin: 10,
    perteMaxMin: 20,
    turboActif: turbo !== 'coupe',
    turboApresMin: 6,
    turboAttenteRetourMin: 4,
    turboPriseEnChargeMin: typeof turbo === 'number' ? turbo : 15,
    arretClientS: ARRET_CLIENT_S,
    ...autres,
  };
}

function situation(
  E: ArretTournee[],
  N: ArretTournee[],
  entre: [string, string, number][],
  o: { eAvecLivreur?: boolean; depart: string; departApres?: string; autreN?: string; autreE?: string; autreRevient?: boolean },
): SituationRegroupement {
  return {
    existants: E,
    nouveaux: N,
    entreClients: new Map(entre.map(([a, b, m]) => [clePaireArrets(a, b), m])),
    eAvecLivreur: o.eAvecLivreur ?? false,
    departAvantMs: h(o.depart).getTime(),
    departApresMs: h(o.departApres ?? o.depart).getTime(),
    autrePourNMs: o.autreN ? h(o.autreN).getTime() : null,
    autrePourEMs: o.autreE ? h(o.autreE).getTime() : null,
    autrePourNRevient: o.autreRevient,
    autrePourERevient: o.autreRevient,
    vitesseKmh: (d) => vitesseKmh(new Date(d), REGLAGES_PLANIFICATION_DEFAUT),
  };
}

/** L'heure est-elle celle attendue, à une minute près ? */
function aLaMinute(ms: number | undefined, attendu: string) {
  expect(ms).toBeDefined();
  const ecart = Math.abs(ms! - h(attendu).getTime());
  if (ecart > MIN) throw new Error(`${new Date(ms!).toISOString().slice(11, 19)} au lieu de ${attendu}`);
}

const G = (d: DecisionRegroupement, id: string) => d.groupe?.arriveesMs.get(id);
const S = (d: DecisionRegroupement, id: string) => d.separe.arriveesMs.get(id);

// Géographies (Zone 4 ; Angré pour T6), distances par la route.
const T1 = (pretA = '12:14', pretB = '12:15', o: { passeeA?: string; passeeB?: string } = {}) => ({
  A: arret('a', pretA, 3000, { passee: o.passeeA }),
  B: arret('b', pretB, 2900, { passee: o.passeeB }),
  entre: [['a', 'b', 3800]] as [string, string, number][],
});
const T2 = (pretA = '12:14', pretB = '12:15') => ({
  A: arret('a', pretA, 3000),
  B: arret('b', pretB, 5600),
  entre: [['a', 'b', 4200]] as [string, string, number][],
});
const T3 = (pretA = '12:14', pretB = '12:15') => ({
  A: arret('a', pretA, 5600),
  B: arret('b', pretB, 6300),
  entre: [['a', 'b', 4200]] as [string, string, number][],
});

describe('T1. un seul livreur, angle droit (création : la graine A, puis B)', () => {
  it('12 h 15, Turbo coupé : groupé A 12 h 26, B 12 h 44 ; séparé B 12 h 51 au retour', () => {
    const { A, B, entre } = T1();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites('coupe'));
    expect([d.grouper, d.motif, d.groupe!.ordre]).toEqual([true, 'MEILLEUR', ['a', 'b']]);
    aLaMinute(G(d, 'a'), '12:26');
    aLaMinute(G(d, 'b'), '12:44');
    expect([d.separe.premier, d.separe.departSecond]).toEqual(['E', 'RETOUR']);
    aLaMinute(S(d, 'a'), '12:26');
    aLaMinute(S(d, 'b'), '12:51');
  });

  it('12 h 15, Turbo en 15 min : groupé, Turbo évité (séparé : B 12 h 47 par Turbo)', () => {
    const { A, B, entre } = T1();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites(15));
    expect([d.grouper, d.motif, d.separe.departSecond]).toEqual([true, 'MEILLEUR', 'TURBO']);
    aLaMinute(S(d, 'b'), '12:47');
    aLaMinute(G(d, 'b'), '12:44');
  });

  it('12 h 15, Turbo en 0 min : séparé, les deux à l’heure (B 12 h 26, A 12 h 31 par Turbo), PROMESSE_CASSEE', () => {
    const { A, B, entre } = T1();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites(0));
    expect([d.grouper, d.motif]).toEqual([false, 'PROMESSE_CASSEE']);
    expect(d.cleS).toEqual([0, 0]);
    // À retard égal, l'ordre de service qui rend le livreur le plus tôt.
    expect([d.separe.premier, d.separe.departSecond]).toEqual(['N', 'TURBO']);
    aLaMinute(S(d, 'b'), '12:26');
    aLaMinute(S(d, 'a'), '12:31');
  });

  it('16 h 00, Turbo coupé : groupé A 16 h 08, B 16 h 22, tous à l’heure ; séparé B 16 h 27', () => {
    const { A, B, entre } = T1('15:59', '16:00');
    const d = comparerPlans(situation([A], [B], entre, { depart: '16:00' }), limites('coupe'));
    expect([d.grouper, d.motif]).toEqual([true, 'MEILLEUR']);
    aLaMinute(G(d, 'a'), '16:08');
    aLaMinute(G(d, 'b'), '16:22');
    aLaMinute(S(d, 'b'), '16:27');
    expect(d.cleG![0]).toBe(0);
  });

  it('servir B d’abord retarderait la graine de 17 min sur le plan séparé : permutation écartée (borne de 8 min)', () => {
    const { A, B, entre } = T1();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites('coupe'));
    expect(d.groupe!.ordre).toEqual(['a', 'b']);
  });
});

describe('T2. pont HKB', () => {
  it('12 h 15, Turbo coupé : groupé A 12 h 26, B 12 h 45 ; séparé B 13 h 02 au retour', () => {
    const { A, B, entre } = T2();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites('coupe'));
    expect([d.grouper, d.motif]).toEqual([true, 'MEILLEUR']);
    aLaMinute(G(d, 'a'), '12:26');
    aLaMinute(G(d, 'b'), '12:45');
    aLaMinute(S(d, 'b'), '13:02');
  });

  it('12 h 15, Turbo en 15 min : échange, B perd 9 min, retard total 5,0 min contre 7,3', () => {
    const { A, B, entre } = T2();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites(15));
    expect([d.grouper, d.motif, d.separe.premier, d.separe.departSecond]).toEqual([true, 'MEILLEUR', 'N', 'TURBO']);
    aLaMinute(S(d, 'b'), '12:36');
    aLaMinute(S(d, 'a'), '12:46');
    expect(resumeComparaison(d)).toMatchObject({ groupe_min: [5, 10], separe_min: [7.3, 13.3] });
  });

  it('même échange, perte maximale réglée à 5 min : séparé, PERTE_MAX', () => {
    const { A, B, entre } = T2();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites(15, { perteMaxMin: 5 }));
    expect([d.grouper, d.motif]).toEqual([false, 'PERTE_MAX']);
  });

  it('16 h 00, Turbo coupé : groupé B 16 h 23 ; séparé B 16 h 35', () => {
    const { A, B, entre } = T2('15:59', '16:00');
    const d = comparerPlans(situation([A], [B], entre, { depart: '16:00' }), limites('coupe'));
    expect([d.grouper, d.motif]).toEqual([true, 'MEILLEUR']);
    aLaMinute(G(d, 'b'), '16:23');
    aLaMinute(S(d, 'b'), '16:35');
  });
});

describe('T3. cas du client, un autre itinéraire', () => {
  it('12 h 15, Turbo coupé : groupé A 12 h 36, B 12 h 55, tournée de 40 min ; séparé B 13 h 24 au retour', () => {
    const { A, B, entre } = T3();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites('coupe'));
    expect([d.grouper, d.motif, d.groupe!.ordre]).toEqual([true, 'MEILLEUR', ['a', 'b']]);
    aLaMinute(G(d, 'a'), '12:36');
    aLaMinute(G(d, 'b'), '12:55');
    expect(Math.round(d.groupe!.dureeS / 60)).toBe(40);
    aLaMinute(S(d, 'b'), '13:24');
  });

  it('12 h 15, Turbo en 15 min : échange, 14,8 min de retard total contre 17,0', () => {
    const { A, B, entre } = T3();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites(15));
    expect([d.grouper, d.motif]).toEqual([true, 'MEILLEUR']);
    aLaMinute(S(d, 'b'), '12:39');
    aLaMinute(S(d, 'a'), '12:56');
    expect(resumeComparaison(d)).toMatchObject({ decision: 'MEILLEUR', groupe_min: [14.8, 21.8], separe_min: [17, 25.6], premier: 'N' });
  });

  it('12 h 15, Turbo en 0 min : séparé, PIRE (A 12 h 41 par Turbo)', () => {
    const { A, B, entre } = T3();
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites(0));
    expect([d.grouper, d.motif]).toEqual([false, 'PIRE']);
    aLaMinute(S(d, 'a'), '12:41');
  });

  it('16 h 00, Turbo en 15 min : groupé A 16 h 15, B 16 h 30 ; séparé B 16 h 17, A 16 h 35', () => {
    const { A, B, entre } = T3('15:59', '16:00');
    const d = comparerPlans(situation([A], [B], entre, { depart: '16:00' }), limites(15));
    expect([d.grouper, d.motif]).toEqual([true, 'MEILLEUR']);
    aLaMinute(G(d, 'a'), '16:15');
    aLaMinute(G(d, 'b'), '16:30');
    aLaMinute(S(d, 'b'), '16:17');
    aLaMinute(S(d, 'a'), '16:35');
  });
});

describe('T4. un autre livreur libre : la seconde part tout de suite avec lui', () => {
  it.each([
    ['T1', T1()],
    ['T2', T2()],
    ['T3', T3()],
  ] as const)('%s, 12 h 15 : séparé', (_nom, g) => {
    const d = comparerPlans(situation([g.A], [g.B], g.entre, { depart: '12:15', autreN: '12:15', autreE: '12:15' }), limites(15));
    expect(d.grouper).toBe(false);
    expect(['PROMESSE_CASSEE', 'PIRE']).toContain(d.motif);
    expect(d.separe.departSecond).toBe('AUTRE_LIVREUR');
  });
});

describe('T5. commande déjà en retard (géographie de T1)', () => {
  it('A (graine) passée 11 h 30 : groupé, A d’abord', () => {
    const { A, B, entre } = T1('12:14', '12:15', { passeeA: '11:30' });
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites('coupe'));
    expect([d.grouper, d.motif, d.groupe!.ordre]).toEqual([true, 'MEILLEUR', ['a', 'b']]);
    aLaMinute(G(d, 'b'), '12:44');
  });

  it('B passée 11 h 30, A (graine) à l’heure : groupé, B d’abord', () => {
    const { A, B, entre } = T1('12:14', '12:15', { passeeB: '11:30' });
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites('coupe'));
    expect([d.grouper, d.motif, d.groupe!.ordre]).toEqual([true, 'MEILLEUR', ['b', 'a']]);
    aLaMinute(G(d, 'b'), '12:26');
    aLaMinute(G(d, 'a'), '12:43');
  });

  it('A en retard dans une course avec son livreur, B passée 11 h 45 : B d’abord écarté (A 17 min plus tard), A d’abord', () => {
    const { A, B, entre } = T1('12:14', '12:15', { passeeA: '11:30', passeeB: '11:45' });
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15', eAvecLivreur: true }), limites('coupe'));
    expect([d.grouper, d.motif, d.groupe!.ordre]).toEqual([true, 'MEILLEUR', ['a', 'b']]);
    aLaMinute(S(d, 'b'), '12:51');
  });
});

describe('T6. sens opposés, 10 km chacun', () => {
  const A = arret('a', '12:14', 10_000);
  const B = arret('b', '12:15', 10_000);
  const entre: [string, string, number][] = [['a', 'b', 20_000]];

  it('réglages par défaut : séparé, TOURNEE_MAX (115 min en pointe)', () => {
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites('coupe'));
    expect([d.grouper, d.motif, d.groupe]).toEqual([false, 'TOURNEE_MAX', null]);
  });

  it('plafond porté à 240 min, Turbo coupé : égalité (B à la même heure, le livreur aussi), EGAL', () => {
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites('coupe', { tourneeMaxMin: 240 }));
    expect([d.grouper, d.motif]).toEqual([false, 'EGAL']);
    aLaMinute(G(d, 'b'), '14:11');
    aLaMinute(S(d, 'b'), '14:11');
  });

  it('plafond porté à 240 min, Turbo en 15 min : PIRE (la seconde par Turbo vers 13 h 13, contre 14 h 11 groupée)', () => {
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15' }), limites(15, { tourneeMaxMin: 240 }));
    expect([d.grouper, d.motif, d.separe.departSecond]).toEqual([false, 'PIRE', 'TURBO']);
    aLaMinute(S(d, 'a'), '13:13');
    aLaMinute(G(d, 'b'), '14:11');
  });
});

describe('T7. retenue au comptoir (géographie de T2) : la course attend B', () => {
  const A = arret('a', '12:15', 3000);
  const B = arret('b', '12:18', 5600, { passee: '12:03' });
  const entre: [string, string, number][] = [['a', 'b', 4200]];

  it.each([
    [15, 'TURBO', '13:00'],
    ['coupe', 'RETOUR', '13:02'],
  ] as const)('Turbo %s : groupé A 12 h 29, B 12 h 48 ; séparé A 12 h 26, B par %s', (turbo, depart, heureB) => {
    const d = comparerPlans(situation([A], [B], entre, { depart: '12:15', departApres: '12:18', eAvecLivreur: true }), limites(turbo));
    expect([d.grouper, d.motif, d.separe.departSecond]).toEqual([true, 'MEILLEUR', depart]);
    aLaMinute(G(d, 'a'), '12:29');
    aLaMinute(G(d, 'b'), '12:48');
    aLaMinute(S(d, 'a'), '12:26');
    aLaMinute(S(d, 'b'), heureB);
  });
});

describe('T8. promesse tenue cassée (géographie de T3) : A à l’heure seule, 1 min au-delà groupée', () => {
  const A = arret('a', '12:15', 5600);
  const B = arret('b', '12:20', 6300, { passee: '12:05' });
  const entre: [string, string, number][] = [['a', 'b', 4200]];
  const s = situation([A], [B], entre, { depart: '12:15', departApres: '12:20', eAvecLivreur: true });

  it('Turbo coupé : groupé, 23 min de retard total en moins, RETARD_TOTAL_MOINDRE', () => {
    const d = comparerPlans(s, limites('coupe'));
    expect([d.grouper, d.motif]).toEqual([true, 'RETARD_TOTAL_MOINDRE']);
    aLaMinute(G(d, 'a'), '12:41');
    aLaMinute(G(d, 'b'), '13:00');
    aLaMinute(S(d, 'a'), '12:36');
    aLaMinute(S(d, 'b'), '13:24');
    expect(Math.round((d.cleS[0] - d.cleG![0]) / 60)).toBe(23);
  });

  it('gain exigé réglé à 0 : séparé, PROMESSE_CASSEE', () => {
    expect(comparerPlans(s, limites('coupe', { gainMin: 0 })).motif).toBe('PROMESSE_CASSEE');
  });

  it('Turbo en 15 min : 4 min de gain seulement, PROMESSE_CASSEE', () => {
    const d = comparerPlans(s, limites(15));
    expect([d.grouper, d.motif]).toEqual([false, 'PROMESSE_CASSEE']);
    aLaMinute(S(d, 'b'), '13:05');
  });
});

describe('égalité et bornes', () => {
  // Deux clients proches, hors pointe, promesses larges : tout le monde à l'heure dans les deux plans.
  const A = arret('a', '16:00', 1000);
  const B = arret('b', '16:00', 1200);
  const entre: [string, string, number][] = [['a', 'b', 1500]];

  it('à retard égal, la seconde partirait chez Turbo : groupé, TURBO_EVITE', () => {
    const d = comparerPlans(
      situation([A], [B], entre, { depart: '16:00' }),
      limites(2, { turboApresMin: 0, turboAttenteRetourMin: 0 }),
    );
    expect([d.grouper, d.motif, d.separe.departSecond]).toEqual([true, 'TURBO_EVITE', 'TURBO']);
  });

  it('à retard égal, un autre livreur qui revient d’une course la prendrait : groupé, LIVREUR_EPARGNE', () => {
    const d = comparerPlans(
      situation([A], [B], entre, { depart: '16:00', autreN: '16:05', autreE: '16:05', autreRevient: true }),
      limites('coupe'),
    );
    expect([d.grouper, d.motif, d.separe.autreRevient]).toEqual([true, 'LIVREUR_EPARGNE', true]);
  });

  it('à retard égal, un autre livreur LIBRE maintenant la prendrait : séparé, EGAL (relecture du 28/10)', () => {
    const d = comparerPlans(situation([A], [B], entre, { depart: '16:00', autreN: '16:00', autreE: '16:00' }), limites('coupe'));
    expect([d.grouper, d.motif, d.separe.departSecond, d.separe.autreRevient]).toEqual([false, 'EGAL', 'AUTRE_LIVREUR', false]);
  });

  it('à retard égal, le livreur revient 21 min plus tôt : groupé, LIVREUR_PLUS_TOT', () => {
    const loinA = arret('a', '16:00', 4000, { promesse: '16:45' });
    const loinB = arret('b', '16:00', 4200, { promesse: '16:45' });
    const d = comparerPlans(situation([loinA], [loinB], [['a', 'b', 400]], { depart: '16:00' }), limites('coupe'));
    expect([d.grouper, d.motif]).toEqual([true, 'LIVREUR_PLUS_TOT']);
    expect((d.separe.retourLivreurMs - d.retourGMs!) / MIN).toBeGreaterThan(20);
  });

  it('seule la tournée qui sert d’abord la nouvelle tient le plafond, et elle retarde la commande déjà prévue : DETOUR_PREMIER', () => {
    const loin = arret('a', '12:15', 9000);
    const pres = arret('b', '12:15', 1000);
    const d = comparerPlans(situation([loin], [pres], [['a', 'b', 9500]], { depart: '12:15', eAvecLivreur: true }), limites('coupe'));
    expect([d.grouper, d.motif]).toEqual([false, 'DETOUR_PREMIER']);
  });

  it('comparaison résumée pour le journal : minutes au dixième, partie servie d’abord, départ de la seconde', () => {
    const { A: a, B: b, entre: e } = T1();
    const d = comparerPlans(situation([a], [b], e, { depart: '12:15' }), limites(0));
    expect(resumeComparaison(d)).toEqual({
      decision: 'PROMESSE_CASSEE',
      groupe_min: [3.5, 8.5],
      separe_min: [0, 0],
      premier: 'N',
      depart_second: 'TURBO',
    });
  });
});
