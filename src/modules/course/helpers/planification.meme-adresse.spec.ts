/**
 * Essai du client du 28/10 : deux commandes à la MÊME adresse, à 11,1 km
 * par la route du restaurant de Sococé, parties en deux courses alors que le
 * livreur était encore au restaurant (prêtes ensemble, ou l'une après
 * l'autre).
 *
 * Cause : la durée maximale d'une tournée (25 min, restaurant → dernier
 * client, arrêts compris) refusait tout groupe dès que le trajet SEUL vers le
 * client en prenait déjà presque autant (11,1 km : 30 min hors pointe, 42 min
 * en pointe), alors qu'une commande seule n'a aucun plafond. Toutes les
 * entrées du regroupement (création, ajout, fusion, retenue) passaient par ce
 * refus. Règle : au-delà de la durée réglée, un groupe n'est refusé que s'il
 * allonge le plus long trajet seul de ses commandes de plus du détour maximal
 * d'un ajout (8 min). Les autres limites ne changent pas.
 *
 * Relecture du correctif : deux commandes encore À L'HEURE (passées 7 à 9 min
 * avant d'être prêtes) partaient toujours en deux courses. La seconde arrive
 * 3 min après la première (remise), au-delà de sa promesse + 5 min ; la
 * création la croyait capable de partir seule avec le livreur qui prenait la
 * première (seule, elle partait en fait chez Turbo), et l'ajout ou la fusion
 * ne gardaient que l'ordre qui mettait en retard la commande déjà prévue.
 * L'ordre des arrêts écartait aussi, à 25 min, l'ordre qui tenait la promesse
 * loin du restaurant.
 *
 * Restaurant de Sococé (5.3735398, -3.9990328), client à Riviera Faya
 * (5.3830, -3.9290) : 7,83 km à vol d'oiseau, 11 km estimés sans Google,
 * tracé « Google » de 11,1 km. Livreur au comptoir, appli protocole 4.
 */
import { CourseStatut, OrderStatus } from '@prisma/client';

import { haversineMeters, ILatLng } from './geo.helper';
import { actionsDe, cmd, crs, decale, h, instant, livr, Monde, plus } from './monde-planification.simulee-spec';
import {
  CommandePlanif,
  CoursePlanif,
  LivreurPlanif,
  planifier,
  PlanRestaurant,
  REGLAGES_PLANIFICATION_DEFAUT,
  ReglagesPlanification,
} from './planification.rules';

const REG = REGLAGES_PLANIFICATION_DEFAUT;
const SOCOCE: ILatLng = { lat: 5.3735398, lng: -3.9990328 };
const FAYA: ILatLng = { lat: 5.383, lng: -3.929 };
/** La même adresse saisie deux fois : 5 m ou 18 m plus loin. */
const FAYA_5M = decale(FAYA, 3, 4);
const FAYA_18M = decale(FAYA, 15, 10);
/** Sens opposé : le symétrique de Faya par rapport au restaurant (11 km à l'ouest). */
const OPPOSE: ILatLng = { lat: 2 * SOCOCE.lat - FAYA.lat, lng: 2 * SOCOCE.lng - FAYA.lng };
const ROUTE_M = 11_100;

/** Tracé R → W → C de `metres` de long (W écarté de la droite), comme un tracé Google. */
function trace(arrivee: ILatLng, metres: number): ILatLng[] {
  const parDegre = (Math.PI / 180) * 6_371_000;
  const dn = (arrivee.lat - SOCOCE.lat) * parDegre;
  const de = (arrivee.lng - SOCOCE.lng) * parDegre * Math.cos((SOCOCE.lat * Math.PI) / 180);
  const n = Math.hypot(dn, de);
  const milieu = decale(SOCOCE, dn / 2, de / 2);
  let bas = 0;
  let haut = metres;
  let w = milieu;
  for (let i = 0; i < 80; i++) {
    const m = (bas + haut) / 2;
    w = decale(milieu, (de / n) * m, (-dn / n) * m);
    if (haversineMeters(SOCOCE, w) + haversineMeters(w, arrivee) < metres) bas = m;
    else haut = m;
  }
  return [SOCOCE, w, arrivee];
}

interface OptionsCommande {
  creee: Date;
  prete: Date | null;
  google: boolean;
  statut?: OrderStatus;
  /** En préparation : fin annoncée par la cuisine. */
  finCuisine?: Date;
}

function commande(id: string, position: ILatLng, o: OptionsCommande): CommandePlanif {
  const base = o.finCuisine
    ? cmd(id, {
        statut: OrderStatus.IN_PROGRESS,
        created_at: o.creee,
        ready_at: null,
        prepared_at: plus(o.creee, 60),
        preparation: { debut: plus(o.creee, 60), finMediane: o.finCuisine, finDecision: o.finCuisine, source: 'CUISINE', enRetard: false },
      })
    : cmd(id, { statut: o.statut ?? OrderStatus.READY, created_at: o.creee, ready_at: o.prete });
  const routeMetres = ROUTE_M + Math.round(haversineMeters(FAYA, position));
  return {
    ...base,
    client: o.google
      ? { id, position, routeMetres, trace: trace(position, routeMetres) }
      : { id, position, routeMetres: null, trace: null },
  };
}

/** Livreur au comptoir de Sococé (position précise et fraîche), appli de l'essai. */
const livreur = (id: string, t: Date, etat: Record<string, unknown> = {}): LivreurPlanif =>
  livr(id, t, { etat, position: SOCOCE, position_at: plus(t, -20), protocole_appli: 4 });

function passage(
  t: Date,
  o: { commandes?: CommandePlanif[]; courses?: CoursePlanif[]; livreurs?: LivreurPlanif[]; reglages?: ReglagesPlanification },
): PlanRestaurant {
  return planifier(
    instant(t, { commandes: o.commandes ?? [], courses: o.courses ?? [], livreurs: o.livreurs ?? [livreur('l', t)], position: SOCOCE }),
    o.reglages ?? REG,
  );
}

const refusDe = (plan: PlanRestaurant, id: string) =>
  plan.refus.filter((x) => x.order_id === id || x.source_id === id).map((x) => `${x.essai}:${x.refus}`);

const HEURES: [string, string][] = [
  ['16:00', 'hors pointe'],
  ['12:30', 'pointe du midi'],
  ['19:30', 'pointe du soir'],
];
const SECONDES: [string, ILatLng][] = [
  ['coordonnées identiques', FAYA],
  ['même adresse à 5 m', FAYA_5M],
];

describe('géographie de l’essai', () => {
  it('Faya : 7,8 km à vol d’oiseau de Sococé, sens opposé à la même distance', () => {
    expect(haversineMeters(SOCOCE, FAYA)).toBeGreaterThan(7700);
    expect(haversineMeters(SOCOCE, FAYA)).toBeLessThan(7950);
    expect(Math.abs(haversineMeters(SOCOCE, OPPOSE) - haversineMeters(SOCOCE, FAYA))).toBeLessThan(10);
  });
});

describe('prêtes au même passage, livreur libre au comptoir : UNE course', () => {
  for (const [nomAdresse, posB] of SECONDES) {
    for (const google of [false, true]) {
      for (const [heure, nomHeure] of HEURES) {
        it(`${nomAdresse}, ${google ? 'tracé de 11,1 km' : 'sans Google'}, ${heure} (${nomHeure})`, () => {
          // Commandes passées 20 min avant (cuisine) ou 60 min avant (centre d'appel, déjà en retard).
          for (const creeeAvantMin of [20, 60]) {
            const creee = plus(h(heure), -creeeAvantMin * 60);
            const plan = passage(plus(h(heure), 5), {
              commandes: [
                commande('a', FAYA, { creee, prete: h(heure), google }),
                commande('b', posB, { creee, prete: h(heure), google }),
              ],
            });
            const creees = actionsDe(plan, 'CREER_COURSE');
            expect(creees.map((c) => [...c.order_ids].sort())).toEqual([['a', 'b']]);
            expect(creees[0].motif).toBe('MEME_ADRESSE');
            expect(actionsDe(plan, 'OFFRIR').map((o) => [o.course_cle, o.deliverer_id])).toEqual([[creees[0].cle, 'l']]);
            expect(plan.refus).toEqual([]);
          }
        });
      }
    }
  }
});

type EtatK = 'OFFERTE' | 'ACCEPTEE' | 'AU_COMPTOIR' | 'RECUPEREE';
const ETATS: EtatK[] = ['OFFERTE', 'ACCEPTEE', 'AU_COMPTOIR', 'RECUPEREE'];

/**
 * K contient A (prête à `pretA`), son livreur L est au restaurant. Maintenant
 * = B tout juste prête `ecartMin` après A ; ou, B encore en préparation, A
 * prête + 10 s avec la cuisine qui annonce B pour A + `ecartMin`.
 */
function scene(o: {
  etatK: EtatK;
  ecartMin: number;
  posB?: ILatLng;
  google?: boolean;
  pretA?: string;
  aCreeeAvantMin?: number;
  bEnPreparation?: boolean;
  autres?: (t: Date) => LivreurPlanif[];
  reglages?: ReglagesPlanification;
}): PlanRestaurant {
  const T0 = h(o.pretA ?? '16:00');
  const t = o.bEnPreparation ? plus(T0, 10) : plus(T0, o.ecartMin * 60);
  const google = o.google ?? true;
  const aCreee = plus(T0, -(o.aCreeeAvantMin ?? 25) * 60);
  const recuperee = o.etatK === 'RECUPEREE';
  const a = commande('a', FAYA, { creee: aCreee, prete: T0, google, statut: recuperee ? OrderStatus.PICKED_UP : OrderStatus.READY });
  const b = commande('b', o.posB ?? FAYA, {
    creee: plus(aCreee, 60),
    prete: o.bEnPreparation ? null : t,
    google,
    finCuisine: o.bEnPreparation ? plus(T0, o.ecartMin * 60) : undefined,
  });
  const base = { commandes: [a], created_at: T0, reference: 'CRS-K' };
  const k =
    o.etatK === 'OFFERTE'
      ? crs('k', { ...base, offre: { id: 'offre-1', deliverer_id: 'l', expires_at: plus(t, 30) } })
      : o.etatK === 'ACCEPTEE'
        ? crs('k', { ...base, statut: CourseStatut.ACCEPTED, deliverer_id: 'l', assigned_at: plus(T0, 10) })
        : o.etatK === 'AU_COMPTOIR'
          ? crs('k', { ...base, statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'l', assigned_at: plus(T0, 10), at_restaurant_at: plus(T0, 10) })
          : crs('k', {
              ...base,
              statut: CourseStatut.IN_DELIVERY,
              deliverer_id: 'l',
              assigned_at: plus(T0, 5),
              at_restaurant_at: plus(T0, 5),
              // A remise il y a 30 s (B prête) ou 5 s (B en préparation) : fenêtre d'ajout ouverte.
              picked_up_at: plus(t, o.bEnPreparation ? -5 : -30),
            });
  const l = livreur('l', t, o.etatK === 'OFFERTE' ? { offre_en_attente: true } : { en_course: true, last_available_at: null });
  return passage(t, { commandes: [b], courses: [k], livreurs: [l, ...(o.autres?.(t) ?? [])], reglages: o.reglages });
}

describe('l’une après l’autre, livreur encore au restaurant : B rejoint la course de A', () => {
  it('B prête 1, 3 ou 8 min après A : ajoutée dans les 4 états de la course, identique ou à 18 m, avec ou sans Google, pointe ou non, à l’heure ou en retard', () => {
    let n = 0;
    for (const etatK of ETATS) {
      for (const ecartMin of [1, 3, 8]) {
        for (const posB of [FAYA, FAYA_18M]) {
          for (const google of [true, false]) {
            for (const pretA of ['12:30', '16:00']) {
              for (const aCreeeAvantMin of [25, 50]) {
                const plan = scene({ etatK, ecartMin, posB, google, pretA, aCreeeAvantMin });
                const ajouts = actionsDe(plan, 'AJOUTER');
                expect(ajouts.map((a) => [a.course_id, a.order_id, a.motif])).toEqual([['k', 'b', 'MEME_ADRESSE']]);
                expect(ajouts[0].apres_retrait).toBe(etatK === 'RECUPEREE');
                expect(actionsDe(plan, 'CREER_COURSE')).toEqual([]);
                expect(refusDe(plan, 'b')).toEqual([]);
                n++;
              }
            }
          }
        }
      }
    }
    expect(n).toBe(192);
  });

  it('B encore en préparation, annoncée 1, 3 ou 8 min après A : la course de A l’attend', () => {
    for (const etatK of ['AU_COMPTOIR', 'RECUPEREE'] as const) {
      for (const ecartMin of [1, 3, 8]) {
        for (const pretA of ['12:30', '16:00']) {
          const plan = scene({ etatK, ecartMin, pretA, bEnPreparation: true });
          const retenues = actionsDe(plan, 'RETENIR');
          expect(retenues.map((r) => [r.course_id, r.motif, r.attendues.map((x) => x.order_id)])).toEqual([
            ['k', ecartMin <= 3 ? 'ATTENTE_COURTE' : 'TRAJET_LONG', ['b']],
          ]);
          expect(refusDe(plan, 'b')).toEqual([]);
        }
      }
    }
  });

  it('B déjà dans sa propre course : fusionnée dans celle de A (acceptée ou seulement offerte)', () => {
    for (const [heure, google] of [
      ['16:00', true],
      ['12:30', false],
    ] as [string, boolean][]) {
      const T0 = h(heure);
      const t = plus(T0, 30);
      const a = commande('a', FAYA, { creee: plus(T0, -20 * 60), prete: T0, google });
      const b = commande('b', FAYA_5M, { creee: plus(T0, -19 * 60), prete: plus(T0, 20), google });
      const kb = crs('kb', { commandes: [b], created_at: plus(T0, 20) });

      const acceptee = crs('ka', { commandes: [a], statut: CourseStatut.ACCEPTED, deliverer_id: 'l', assigned_at: plus(T0, 10), created_at: T0 });
      const p1 = passage(t, { courses: [acceptee, kb], livreurs: [livreur('l', t, { en_course: true, last_available_at: null })] });
      expect(actionsDe(p1, 'FUSIONNER').map((f) => [f.cible_id, f.absorbee_id, f.motif])).toEqual([['ka', 'kb', 'MEME_ADRESSE']]);
      expect(p1.refus).toEqual([]);

      const offerte = crs('ka', { commandes: [a], created_at: T0, offre: { id: 'o1', deliverer_id: 'l', expires_at: plus(t, 60) } });
      const p2 = passage(t, { courses: [offerte, kb], livreurs: [livreur('l', t, { offre_en_attente: true })] });
      const fusions = actionsDe(p2, 'FUSIONNER');
      expect(fusions).toHaveLength(1);
      expect([fusions[0].cible_id, fusions[0].absorbee_id].sort()).toEqual(['ka', 'kb']);
      expect(actionsDe(p2, 'CONFIER_TURBO')).toEqual([]);
    }
  });
});

describe('déroulé dans le monde simulé (7,83 km à vol d’oiseau, 11 km estimés) : une course, pas de Turbo', () => {
  /** Le livreur part 60 s après la remise (défaut du monde), ou reste `delaiDepartS` au comptoir. */
  const monde = (delaiDepartS?: number) =>
    new Monde(h('15:59:50'), REG).livreur('l', { libreDepuis: h('15:30'), delaiDepartS, protocole_appli: 4 });
  const deroule = (o: { ecartS: number; annoncee: boolean; creee?: string; delaiDepartS?: number }) => {
    const finB = plus(h('16:00'), o.ecartS);
    const creee = h(o.creee ?? '15:40');
    return monde(o.delaiDepartS)
      .commande('a', { est: 7830, creee, enPreparation: h('15:42'), prete: h('16:00') })
      .commande('b', {
        est: 7834,
        nord: 3,
        creee,
        enPreparation: o.annoncee ? h('15:42') : finB,
        prete: finB,
        finCuisine: o.annoncee ? finB : null,
      })
      .jusqua(h('16:30'));
  };

  for (const [nom, ecartS, creee] of [
    ['prêtes ensemble, passées 20 min avant (déjà en retard)', 0, '15:40'],
    ['prêtes ensemble, passées 8 min avant (à l’heure)', 0, '15:52'],
    ['B prête 20 s après A', 20, '15:40'],
    ['B prête 8 min après A, annoncée par la cuisine', 8 * 60, '15:40'],
  ] as [string, number, string][]) {
    it(`${nom} : livreur qui part 60 s après la remise`, () => {
      const m = deroule({ ecartS, annoncee: true, creee });
      expect(m.courseDe('a')!.id).toBe(m.courseDe('b')!.id);
      expect(m.toutes('CONFIER_TURBO')).toEqual([]);
      expect(m.violations).toEqual([]);
    });
  }

  it('B prête 3 min après A, jamais annoncée (traitée à la main) : deux courses si le livreur part 60 s après la remise (fenêtre d’ajout à trancher avec le client), une s’il reste au comptoir', () => {
    const part = deroule({ ecartS: 3 * 60, annoncee: false });
    expect(part.courseDe('a')!.id).not.toBe(part.courseDe('b')!.id);
    expect(part.violations).toEqual([]);
    const reste = deroule({ ecartS: 3 * 60, annoncee: false, delaiDepartS: 15 * 60 });
    expect(reste.courseDe('a')!.id).toBe(reste.courseDe('b')!.id);
    expect(reste.toutes('CONFIER_TURBO')).toEqual([]);
  });
});

/**
 * Commandes À L'HEURE (relecture du correctif) : passées 7 à 9 min avant
 * d'être prêtes à 16 h, la seconde arrivait 3 min après la première, au-delà
 * de sa promesse + 5 min. La création la croyait capable de partir seule avec
 * le livreur qui prenait la première (elle partait en fait chez Turbo), et
 * l'ajout ou la fusion ne gardaient que l'ordre qui mettait en retard la
 * commande déjà prévue.
 */
describe('commandes à l’heure à la même adresse, un seul livreur au comptoir : UNE course, la première à l’heure', () => {
  it('prêtes ensemble, passées 5 à 12 min avant : une course, proposée au livreur du comptoir', () => {
    for (const [, posB] of SECONDES) {
      for (const google of [false, true]) {
        for (const creeeAvantMin of [5, 7, 8, 9, 10, 12]) {
          const creee = plus(h('16:00'), -creeeAvantMin * 60);
          const plan = passage(plus(h('16:00'), 5), {
            commandes: [commande('a', FAYA, { creee, prete: h('16:00'), google }), commande('b', posB, { creee, prete: h('16:00'), google })],
          });
          const creees = actionsDe(plan, 'CREER_COURSE');
          expect(creees.map((c) => [...c.order_ids].sort())).toEqual([['a', 'b']]);
          expect(actionsDe(plan, 'OFFRIR').map((o) => o.deliverer_id)).toEqual(['l']);
          expect(plan.refus).toEqual([]);
        }
      }
    }
  });

  it('trois commandes passées à 15 h 52 : une course, la première prête d’abord, à l’heure', () => {
    for (const google of [false, true]) {
      const plan = passage(plus(h('16:00'), 5), {
        commandes: ['a', 'b', 'c'].map((id) => commande(id, FAYA, { creee: h('15:52'), prete: h('16:00'), google })),
      });
      expect(actionsDe(plan, 'CREER_COURSE').map((c) => c.sequence)).toEqual([['a', 'b', 'c']]);
    }
  });

  it('deux livreurs libres au comptoir : deux courses, toutes deux à l’heure (la promesse tient ; à confirmer avec le client)', () => {
    const t = plus(h('16:00'), 5);
    const plan = passage(t, {
      commandes: [
        commande('a', FAYA, { creee: h('15:52'), prete: h('16:00'), google: true }),
        commande('b', FAYA, { creee: h('15:52'), prete: h('16:00'), google: true }),
      ],
      livreurs: [livreur('l', t), livreur('l2', t)],
    });
    expect(actionsDe(plan, 'CREER_COURSE').map((c) => c.order_ids)).toEqual([['a'], ['b']]);
    expect(actionsDe(plan, 'OFFRIR')).toHaveLength(2);
    expect(plan.refus.map((x) => `${x.essai}:${x.refus}`)).toEqual(['CREATION:RETARD_CLIENT']);
  });

  it('B plus pressée que A (passée 1 min avant), prête 2 min après : ajoutée APRÈS A, qui garde sa promesse', () => {
    for (const posB of [FAYA, FAYA_5M]) {
      for (const google of [false, true]) {
        const T0 = h('16:00');
        const t = plus(T0, 120);
        const a = commande('a', FAYA, { creee: h('15:52'), prete: T0, google });
        const b = commande('b', posB, { creee: h('15:51'), prete: t, google });
        const k = crs('k', { commandes: [a], created_at: T0, statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'l', assigned_at: plus(T0, 10) });
        const plan = passage(t, { commandes: [b], courses: [k], livreurs: [livreur('l', t, { en_course: true, last_available_at: null })] });
        expect(actionsDe(plan, 'AJOUTER').map((x) => [x.course_id, x.order_id])).toEqual([['k', 'b']]);
        expect(actionsDe(plan, 'CREER_COURSE')).toEqual([]);
        expect(refusDe(plan, 'b')).toEqual([]);
        // Sans Google, A seule arrive à 16 h 32 pile (sa limite) : B passe après elle.
        if (posB === FAYA && !google) expect(actionsDe(plan, 'ORDONNER').map((x) => x.sequence)).toEqual([['a', 'b']]);
      }
    }
  });

  it('B dans sa propre course, la course de A acceptée : fusionnée tout de suite, sans attendre que A soit en retard', () => {
    const T0 = h('16:00');
    for (const s of [10, 60, 120]) {
      const t = plus(T0, s);
      const a = commande('a', FAYA, { creee: h('15:52'), prete: T0, google: true });
      const b = commande('b', FAYA, { creee: h('15:52'), prete: plus(T0, 5), google: true });
      const k1 = crs('k1', { commandes: [a], statut: CourseStatut.ACCEPTED, deliverer_id: 'l', assigned_at: plus(T0, 5), created_at: T0 });
      const k2 = crs('k2', { commandes: [b], created_at: plus(T0, 5) });
      const plan = passage(t, { courses: [k1, k2], livreurs: [livreur('l', t, { en_course: true, last_available_at: null })] });
      expect(actionsDe(plan, 'FUSIONNER').map((f) => [f.cible_id, f.absorbee_id])).toEqual([['k1', 'k2']]);
    }
  });
});

describe('plus loin sur la même route : l’ordre qui tient la promesse n’est plus écarté à 25 min', () => {
  /** B sur la route de Faya, à 10 km par la route (9/10 du chemin à vol d'oiseau), programmée pour 17 h 30. */
  const SUR_LA_ROUTE: ILatLng = { lat: SOCOCE.lat + (FAYA.lat - SOCOCE.lat) * 0.9, lng: SOCOCE.lng + (FAYA.lng - SOCOCE.lng) * 0.9 };
  const scenario = (reglages: ReglagesPlanification, google: boolean) => {
    const T0 = h('16:00');
    const t = plus(T0, 20);
    // A passée à 15 h 51 : à l'heure de justesse, seule (limite 16 h 31).
    const a = commande('a', FAYA, { creee: h('15:51'), prete: T0, google });
    const bBase = commande('b', SUR_LA_ROUTE, { creee: h('15:59'), prete: t, google: false });
    const b: CommandePlanif = {
      ...bBase,
      heure_programmee: h('17:30'),
      client: google ? { ...bBase.client, routeMetres: 10_000, trace: trace(SUR_LA_ROUTE, 10_000) } : bBase.client,
    };
    const k = crs('k', { commandes: [a], created_at: T0, statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'l', assigned_at: plus(T0, 5) });
    return passage(t, { commandes: [b], courses: [k], livreurs: [livreur('l', t, { en_course: true, last_available_at: null })], reglages });
  };

  it('25 min réglées : B ajoutée après A (A d’abord, à l’heure), comme avec 40 min', () => {
    for (const google of [false, true]) {
      for (const duree of [25, 40]) {
        const plan = scenario({ ...REG, dureeTourneeMaxMin: duree }, google);
        expect(actionsDe(plan, 'AJOUTER').map((x) => x.order_id)).toEqual(['b']);
        expect(actionsDe(plan, 'ORDONNER').map((x) => x.sequence)).toEqual([['a', 'b']]);
        expect(refusDe(plan, 'b')).toEqual([]);
      }
    }
  });

  it('course de B (à 10,5 km sur la même route) au comptoir, A ajoutée, pressée : A passe d’abord, à l’heure (avant : derrière B, en retard)', () => {
    const PRES: ILatLng = { lat: SOCOCE.lat + (FAYA.lat - SOCOCE.lat) * 0.946, lng: SOCOCE.lng + (FAYA.lng - SOCOCE.lng) * 0.946 };
    const T0 = h('16:00');
    const t = plus(T0, 20);
    const b: CommandePlanif = { ...commande('b', PRES, { creee: h('15:59'), prete: T0, google: false }), heure_programmee: h('17:30') };
    const a = commande('a', FAYA, { creee: h('15:51'), prete: t, google: false });
    const k = crs('k', { commandes: [b], created_at: T0, statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'l', assigned_at: plus(T0, 5) });
    const essai = (reglages: ReglagesPlanification) =>
      passage(t, { commandes: [a], courses: [k], livreurs: [livreur('l', t, { en_course: true, last_available_at: null })], reglages });
    const plan = essai(REG);
    expect(actionsDe(plan, 'AJOUTER').map((x) => x.order_id)).toEqual(['a']);
    expect(actionsDe(plan, 'ORDONNER').map((x) => x.sequence)).toEqual([['a', 'b']]);
    // Détour maximal de 2 min : A d'abord retarderait B de 6 min ; l'ordre du trajet reste.
    expect(actionsDe(essai({ ...REG, detourMaxAjoutMin: 2 }), 'AJOUTER')).toEqual([]);
  });
});

describe('effet à connaître : la retenue « trajet long » atteint les courses lointaines', () => {
  it('A déjà en retard à 11 km, B en cuisine annoncée 12, 15 ou 19 min plus tard : la course l’attend jusqu’à sa fin (20 min au plus, règle du 24/10)', () => {
    for (const ecartMin of [12, 15, 19]) {
      const plan = scene({ etatK: 'AU_COMPTOIR', ecartMin, bEnPreparation: true, aCreeeAvantMin: 25 });
      const retenues = actionsDe(plan, 'RETENIR');
      expect(retenues.map((r) => [r.motif, r.jusqua])).toEqual([['TRAJET_LONG', plus(h('16:00'), ecartMin * 60)]]);
    }
    // Au-delà de 20 min depuis que A est prête : pas d'attente.
    expect(actionsDe(scene({ etatK: 'AU_COMPTOIR', ecartMin: 21, bEnPreparation: true }), 'RETENIR')).toEqual([]);
  });
});

describe('les autres limites ne changent pas', () => {
  it('sens opposés à 11 km : deux courses (DIRECTION)', () => {
    const t = plus(h('16:00'), 5);
    const plan = passage(t, {
      commandes: [
        commande('a', FAYA, { creee: h('15:40'), prete: h('16:00'), google: false }),
        commande('b', OPPOSE, { creee: h('15:40'), prete: h('16:00'), google: false }),
      ],
    });
    expect(actionsDe(plan, 'CREER_COURSE').map((c) => c.order_ids)).toEqual([['a'], ['b']]);
    expect(plan.refus.map((x) => x.refus)).toEqual(['DIRECTION']);
  });

  it('la borne tient : détour maximal réglé à 2 min, la même adresse à 11 km reste refusée (3 min de remise de plus)', () => {
    // Règle d'aujourd'hui seule (second avis du 28/10 coupé).
    const r = { ...REG, detourMaxAjoutMin: 2, regroupementTournee: false };
    expect(refusDe(scene({ etatK: 'AU_COMPTOIR', ecartMin: 1, reglages: r }), 'b')).toEqual(['AJOUT:DUREE_TOURNEE']);
    // Second avis (28/10), distances par la route connues : partie seule, B attendrait
    // l'aller-retour de 11 km ou Turbo ; la tournée groupée (moins de 50 min) passe.
    const avecSecondAvis = scene({ etatK: 'AU_COMPTOIR', ecartMin: 1, reglages: { ...r, regroupementTournee: true } });
    expect(actionsDe(avecSecondAvis, 'AJOUTER').map((a) => [a.course_id, a.motif])).toEqual([['k', 'TOURNEE_ROUTE']]);
    const t = plus(h('16:00'), 5);
    const plan = passage(t, {
      commandes: [
        commande('a', FAYA, { creee: h('15:40'), prete: h('16:00'), google: false }),
        commande('b', FAYA, { creee: h('15:40'), prete: h('16:00'), google: false }),
      ],
      reglages: r,
    });
    expect(actionsDe(plan, 'CREER_COURSE').map((c) => c.order_ids)).toEqual([['a'], ['b']]);
    expect(plan.refus.map((x) => x.refus)).toEqual(['DUREE_TOURNEE']);
  });

  it('second livreur libre, B annoncée dans 8 min (trajet long) : pas d’attente, comme avant (question ouverte au client)', () => {
    const l2 = (t: Date) => [livreur('l2', t)];
    expect(actionsDe(scene({ etatK: 'AU_COMPTOIR', ecartMin: 3, autres: l2 }), 'AJOUTER').map((a) => a.course_id)).toEqual(['k']);
    expect(refusDe(scene({ etatK: 'AU_COMPTOIR', ecartMin: 8, bEnPreparation: true, autres: l2 }), 'b')).toEqual([
      'RETENUE:AUTRE_LIVREUR_LIBRE',
    ]);
  });
});
