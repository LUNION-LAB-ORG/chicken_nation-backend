/**
 * ORDRE DES ARRÊTS PAR LA ROUTE dans le planificateur (demande du client du
 * 27/10 : « bien ordonner les courses du livreur pour éviter qu'il se
 * déplace bêtement »). Scénarios O1 à O12 du contrat `tournee-contrat.md`
 * (A5), coordonnées d'Abidjan, distances routières fixées ici. 15 h 30 : hors
 * pointe (22 km/h).
 */
import { CourseStatut, DeliveryService, DeliveryStatut, OrderStatus } from '@prisma/client';

import { numeroterArrets } from './application-plan.rules';
import { ILatLng } from './geo.helper';
import { actionsDe, cmd, crs, decale, h, instant, livr, plus } from './monde-planification.simulee-spec';
import {
  clePaire,
  CommandePlanif,
  CoursePlanif,
  LivreurPlanif,
  pairesAOrdonner,
  planifier,
  PlanRestaurant,
  REGLAGES_PLANIFICATION_DEFAUT,
} from './planification.rules';

const ZONE4: ILatLng = { lat: 5.2860442, lng: -3.9737121 };
const SOCOCE: ILatLng = { lat: 5.3735398, lng: -3.9990328 };
const YOPOUGON: ILatLng = { lat: 5.331124, lng: -4.103754 };

const T = h('15:30');

/** Commande prête, client à `p`, `routeMetres` depuis le restaurant (cache routier des frais). */
function commande(id: string, p: ILatLng | null, routeMetres: number | null, o: Partial<CommandePlanif> = {}): CommandePlanif {
  return {
    ...cmd(id, { created_at: plus(T, -60), ready_at: plus(T, -30), ...o }),
    client: { id, position: p, routeMetres, trace: null },
  };
}

const LIVREUR = livr('l1', T, { auComptoir: true, etat: { en_course: true } });

/** Course acceptée, livreur au comptoir : départ maintenant. */
function auComptoir(id: string, commandes: CommandePlanif[], o: Partial<CoursePlanif> = {}): CoursePlanif {
  return crs(id, {
    statut: CourseStatut.AT_RESTAURANT,
    deliverer_id: 'l1',
    assigned_at: plus(T, -600),
    at_restaurant_at: plus(T, -60),
    commandes,
    ...o,
  });
}

function passer(
  courses: CoursePlanif[],
  matrice: Map<string, number> | undefined,
  o: { position?: ILatLng; livreurs?: LivreurPlanif[]; commandes?: CommandePlanif[]; maintenant?: Date } = {},
): PlanRestaurant {
  return planifier(
    instant(o.maintenant ?? T, {
      position: o.position ?? ZONE4,
      courses,
      livreurs: o.livreurs ?? [LIVREUR],
      commandes: o.commandes ?? [],
    }),
    REGLAGES_PLANIFICATION_DEFAUT,
    matrice ? { matrice } : {},
  );
}

const ordonner = (plan: PlanRestaurant) => actionsDe(plan, 'ORDONNER');
const paires = (...p: [string, string, number][]) => new Map(p.map(([a, b, m]) => [clePaire(a, b), m]));

// O1 : Zone 4 → Koumassi (2,3 km) et Port-Bouët (4,6 km), 2,6 km entre eux.
const KOUMASSI: ILatLng = { lat: 5.283, lng: -3.955 };
const PORT_BOUET: ILatLng = { lat: 5.26, lng: -3.942 };
const MATRICE_O1 = paires(['k', 'pb', 2600]);

// O2 : Zone 4 → Anoumabo (avant le pont), Riviera bord de lagune, Riviera Golf (après le péage).
const ANOUMABO: ILatLng = { lat: 5.305, lng: -3.979 };
const RIVIERA_LAGUNE: ILatLng = { lat: 5.327, lng: -3.981 };
const RIVIERA_GOLF: ILatLng = { lat: 5.336, lng: -3.962 };
const MATRICE_O2 = paires(['a', 'l', 4700], ['a', 'g', 7300], ['l', 'g', 2600]);
const o2 = () => [
  commande('a', ANOUMABO, 2300),
  commande('l', RIVIERA_LAGUNE, 7000),
  commande('g', RIVIERA_GOLF, 9600),
];

// O3 : Sococé → Blockhauss (5,6 km à vol d'oiseau, 6,5 km par la route) et Riviera lagune (5,5 km, 7,0 km).
const BLOCKHAUSS: ILatLng = { lat: 5.323, lng: -4.0 };
const o3 = (blockhaussMetres = 6500) => [commande('l', RIVIERA_LAGUNE, 7000), commande('b', BLOCKHAUSS, blockhaussMetres)];
const MATRICE_O3 = paires(['b', 'l', 2600]);

describe('O1 : même axe, sans lagune', () => {
  it('Koumassi puis Port-Bouët, même quand Port-Bouët est la plus ancienne (lot, ordre d’avant)', () => {
    const k = auComptoir('k1', [
      commande('pb', PORT_BOUET, 4600, { created_at: plus(T, -12 * 60) }),
      commande('k', KOUMASSI, 2300, { created_at: plus(T, -10 * 60) }),
    ]);
    const plan = passer([k], MATRICE_O1);
    expect(ordonner(plan)).toEqual([
      expect.objectContaining({ type: 'ORDONNER', course_id: 'k1', sequence: ['k', 'pb'], motif: 'MEILLEUR_ORDRE', base: 'route' }),
    ]);
    expect(ordonner(plan)[0].gain_s).toBeGreaterThan(60);
  });
});

describe('O2 : pont HKB, un seul passage', () => {
  it('Anoumabo, Riviera lagune, Riviera Golf ; jamais un ordre qui repasse le pont', () => {
    const [a, l, g] = o2();
    const plan = passer([auComptoir('k1', [l, a, g])], MATRICE_O2);
    expect(ordonner(plan).map((x) => x.sequence)).toEqual([['a', 'l', 'g']]);
  });

  it('déjà dans le bon ordre : rien', () => {
    expect(ordonner(passer([auComptoir('k1', o2())], MATRICE_O2))).toEqual([]);
  });
});

describe('O3 : même zone de Cocody, le vol d’oiseau trompe', () => {
  it('par la route, Blockhauss d’abord (le plus proche voisin à vol d’oiseau prenait Riviera)', () => {
    const plan = passer([auComptoir('k1', o3())], MATRICE_O3, { position: SOCOCE });
    expect(ordonner(plan).map((x) => [x.sequence, x.motif])).toEqual([[['b', 'l'], 'MEILLEUR_ORDRE']]);
  });

  it('sans la matrice, l’ordre d’aujourd’hui reste (Riviera d’abord) : aucun ORDONNER', () => {
    expect(ordonner(passer([auComptoir('k1', o3())], undefined, { position: SOCOCE }))).toEqual([]);
  });
});

describe('O4 : la promesse passe avant la distance', () => {
  it('Port-Bouët commandée il y a 33 min : Port-Bouët d’abord', () => {
    const k = auComptoir('k1', [
      commande('k', KOUMASSI, 2300, { created_at: plus(T, -10 * 60) }),
      commande('pb', PORT_BOUET, 4600, { created_at: plus(T, -33 * 60) }),
    ]);
    expect(ordonner(passer([k], MATRICE_O1)).map((x) => x.sequence)).toEqual([['pb', 'k']]);
  });
});

describe('O5 : repli entier', () => {
  it('sans la paire Koumassi ↔ Port-Bouët : le plan d’aujourd’hui, à l’identique', () => {
    const k = auComptoir('k1', [commande('pb', PORT_BOUET, 4600), commande('k', KOUMASSI, 2300)]);
    expect(passer([k], new Map())).toEqual(passer([k], undefined));
    expect(ordonner(passer([k], new Map()))).toEqual([]);
  });

  it('création : mêmes décisions qu’aujourd’hui quand la paire manque', () => {
    const libre = livr('l2', T, { auComptoir: true });
    const commandes = [commande('pb', PORT_BOUET, 4600, { created_at: plus(T, -12 * 60) }), commande('k', KOUMASSI, 2300)];
    const avec = passer([], paires(['x', 'y', 900]), { livreurs: [libre], commandes });
    const sans = passer([], undefined, { livreurs: [libre], commandes });
    expect(avec).toEqual(sans);
  });

  it('ajout : la matrice des arrêts déjà prévus ne se compare jamais à une estimation sans elle', () => {
    // Même axe vers l'est : course k1 (800 m et 3 km, paire en cache) ; la commande à 1,8 km devient prête.
    const pres = commande('pres', decale(ZONE4, 0, 800), 1100);
    const loin = commande('loin', decale(ZONE4, 0, 3000), 3900);
    const milieu = commande('milieu', decale(ZONE4, 0, 1800), 2400);
    const k = auComptoir('k1', [loin, pres]);
    const avec = passer([k], paires(['pres', 'loin', 2900]), { commandes: [milieu] });
    const sans = passer([k], undefined, { commandes: [milieu] });
    expect(actionsDe(sans, 'AJOUTER').map((x) => x.order_id)).toEqual(['milieu']);
    expect(avec).toEqual(sans);
  });
});

describe('O6 : stabilité (60 s de tolérance)', () => {
  it('gain de 40 s : pas d’ORDONNER ; gain de 3 min : ORDONNER MEILLEUR_ORDRE', () => {
    // Blockhauss à 6 878 m : Blockhauss d'abord gagne 244 m sur la somme des arrivées (40 s à 22 km/h).
    expect(ordonner(passer([auComptoir('k1', o3(6878))], MATRICE_O3, { position: SOCOCE }))).toEqual([]);
    // À 6 450 m : 1,1 km, 3 min.
    const plan = passer([auComptoir('k1', o3(6450))], MATRICE_O3, { position: SOCOCE });
    expect(ordonner(plan)).toEqual([expect.objectContaining({ sequence: ['b', 'l'], motif: 'MEILLEUR_ORDRE' })]);
    expect(Math.round(ordonner(plan)[0].gain_s! / 10)).toBe(18);
  });
});

describe('O7 : course partie', () => {
  it('O2 mal ordonnée, livreur parti : jamais réordonnée', () => {
    const [a, l, g] = o2().map((c) => ({ ...c, statut: OrderStatus.PICKED_UP }));
    const k = auComptoir('k1', [], {
      statut: CourseStatut.IN_DELIVERY,
      picked_up_at: plus(T, -300),
      parti_at: plus(T, -200),
      livraisons: [
        { id: 'liv-l', statut: DeliveryStatut.IN_ROUTE, sequence_order: 1, commande: l },
        { id: 'liv-a', statut: DeliveryStatut.PENDING, sequence_order: 2, commande: a },
        { id: 'liv-g', statut: DeliveryStatut.PENDING, sequence_order: 3, commande: g },
      ],
    });
    expect(ordonner(passer([k], MATRICE_O2))).toEqual([]);
  });

  it('récupérée, livreur encore au comptoir (pas parti) : réordonnée', () => {
    const [a, l, g] = o2().map((c) => ({ ...c, statut: OrderStatus.PICKED_UP }));
    const k = auComptoir('k1', [l, a, g], { statut: CourseStatut.IN_DELIVERY, picked_up_at: plus(T, -30) });
    expect(ordonner(passer([k], MATRICE_O2)).map((x) => x.sequence)).toEqual([['a', 'l', 'g']]);
  });
});

describe('O8 : offre en attente', () => {
  it('en recherche avec une offre PENDING : pas réordonnée ; après l’acceptation : réordonnée', () => {
    const aSococe = { position: SOCOCE, position_at: plus(T, -30) };
    const sollicite = livr('l2', T, { ...aSococe, etat: { offre_en_attente: true } });
    const enRecherche = crs('k1', {
      commandes: o3(),
      offre: { id: 'offre-1', deliverer_id: 'l2', expires_at: plus(T, 40) },
    });
    expect(ordonner(passer([enRecherche], MATRICE_O3, { position: SOCOCE, livreurs: [sollicite] }))).toEqual([]);

    const acceptee = crs('k1', { commandes: o3(), statut: CourseStatut.ACCEPTED, deliverer_id: 'l2', assigned_at: T });
    const livreur = livr('l2', T, { ...aSococe, etat: { en_course: true } });
    expect(ordonner(passer([acceptee], MATRICE_O3, { position: SOCOCE, livreurs: [livreur] }))).toEqual([
      expect.objectContaining({ course_id: 'k1', sequence: ['b', 'l'], motif: 'MEILLEUR_ORDRE' }),
    ]);
  });

  it('Turbo : jamais réordonnée', () => {
    const turbo = crs('k1', {
      commandes: o3().map((c) => ({ ...c, delivery_service: DeliveryService.TURBO })),
    });
    expect(ordonner(passer([turbo], MATRICE_O3, { position: SOCOCE, livreurs: [] }))).toEqual([]);
    const confiee = crs('k2', { commandes: o3(), turbo_escalated_at: plus(T, -60) });
    expect(ordonner(passer([confiee], MATRICE_O3, { position: SOCOCE, livreurs: [] }))).toEqual([]);
  });
});

describe('O9 : retrait d’une commande', () => {
  it('Riviera lagune passée à emporter : au passage suivant, Anoumabo puis Golf, rangs 1 et 2 sans trou', () => {
    const [a, , g] = o2();
    const k = auComptoir('k1', [], {
      livraisons: [
        { id: 'liv-a', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: a },
        { id: 'liv-g', statut: DeliveryStatut.PENDING, sequence_order: 3, commande: g },
      ],
    });
    const plan = passer([k], MATRICE_O2);
    expect(ordonner(plan)).toEqual([expect.objectContaining({ course_id: 'k1', sequence: ['a', 'g'], motif: 'MEILLEUR_ORDRE' })]);
    const rangs = numeroterArrets(
      [
        { id: 'liv-a', order_id: 'a', statut: DeliveryStatut.PENDING, sequence_order: 1 },
        { id: 'liv-g', order_id: 'g', statut: DeliveryStatut.PENDING, sequence_order: 3 },
      ],
      ordonner(plan)[0].sequence,
    );
    expect(rangs && Object.fromEntries(rangs)).toEqual({ 'liv-a': 1, 'liv-g': 2 });
  });
});

describe('O12 : Yopougon, cache chaud', () => {
  // Niangon à l'ouest, Siporex à l'est : sens opposés, 5,5 km entre eux.
  const NIANGON: ILatLng = { lat: 5.32, lng: -4.12 };
  const SIPOREX: ILatLng = { lat: 5.338, lng: -4.085 };
  const matrice = paires(['n', 's', 5500]);
  const n = commande('n', NIANGON, 3000);
  const s = commande('s', SIPOREX, 2600);

  it('même ordre sur 3 passages de suite', () => {
    const premier = passer([auComptoir('k1', [n, s])], matrice, { position: YOPOUGON });
    expect(ordonner(premier).map((x) => x.sequence)).toEqual([['s', 'n']]);
    // Écrit : Siporex 1, Niangon 2. Les deux passages suivants ne changent plus rien.
    for (const secondes of [10, 20]) {
      const plan = passer([auComptoir('k1', [s, n])], matrice, { position: YOPOUGON, maintenant: plus(T, secondes) });
      expect(ordonner(plan)).toEqual([]);
    }
  });

  it('paires à lire dans le cache : une par course à 2 arrêts placés, du plus proche au plus lointain', () => {
    const inst = instant(T, { position: YOPOUGON, courses: [auComptoir('k1', [n, s])], livreurs: [LIVREUR] });
    expect(pairesAOrdonner(inst).map(([x, y]) => [x.id, y.id])).toEqual([['s', 'n']]);
  });
});

describe('pairesAOrdonner : seulement les courses que l’ordre peut encore changer', () => {
  it('ni partie, ni Turbo, ni à un seul arrêt placé ; trois paires pour trois arrêts', () => {
    const [a, l, g] = o2();
    const partie = auComptoir('k-partie', [commande('x', KOUMASSI, 2300), commande('y', PORT_BOUET, 4600)], {
      statut: CourseStatut.IN_DELIVERY,
      picked_up_at: plus(T, -300),
      parti_at: plus(T, -200),
    });
    const turbo = crs('k-turbo', { commandes: [commande('t1', KOUMASSI, 2300), commande('t2', PORT_BOUET, 4600)], turbo_escalated_at: T });
    const seule = crs('k-seule', { commandes: [commande('u', KOUMASSI, 2300), commande('v', null, null)] });
    const inst = instant(T, { position: ZONE4, courses: [auComptoir('k1', [l, g, a]), partie, turbo, seule], livreurs: [LIVREUR] });
    expect(pairesAOrdonner(inst).map(([x, y]) => [x.id, y.id])).toEqual([
      ['a', 'l'],
      ['a', 'g'],
      ['l', 'g'],
    ]);
  });
});

describe('ajout : l’ordre écrit garde son motif', () => {
  it('commande ajoutée : ORDONNER motif AJOUT, le long de l’axe', () => {
    const pres = commande('pres', decale(ZONE4, 0, 800), 1100);
    const loin = commande('loin', decale(ZONE4, 0, 3000), 3900);
    const milieu = commande('milieu', decale(ZONE4, 0, 1800), 2400);
    const plan = passer([auComptoir('k1', [loin, pres])], undefined, { commandes: [milieu] });
    expect(actionsDe(plan, 'AJOUTER').map((x) => x.order_id)).toEqual(['milieu']);
    expect(ordonner(plan)).toEqual([
      expect.objectContaining({ course_id: 'k1', sequence: ['pres', 'milieu', 'loin'], motif: 'AJOUT', gain_s: null }),
    ]);
  });
});
