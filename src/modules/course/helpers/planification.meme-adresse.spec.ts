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
  const monde = (r: ReglagesPlanification = REG) =>
    new Monde(h('15:59:50'), r).livreur('l', { libreDepuis: h('15:30'), delaiDepartS: 15 * 60, protocole_appli: 4 });

  for (const [nom, ecartS, annoncee] of [
    ['prêtes ensemble', 0, true],
    ['B prête 20 s après A', 20, true],
    ['B prête 8 min après A, annoncée par la cuisine', 8 * 60, true],
    ['B prête 3 min après A, jamais annoncée (traitée à la main)', 3 * 60, false],
  ] as [string, number, boolean][]) {
    it(nom, () => {
      const finB = plus(h('16:00'), ecartS);
      const m = monde()
        .commande('a', { est: 7830, creee: h('15:40'), enPreparation: h('15:42'), prete: h('16:00') })
        .commande('b', {
          est: 7834,
          nord: 3,
          creee: h('15:40'),
          enPreparation: annoncee ? h('15:42') : finB,
          prete: finB,
          finCuisine: annoncee ? finB : null,
        })
        .jusqua(h('16:30'));
      expect(m.courseDe('a')!.id).toBe(m.courseDe('b')!.id);
      expect(m.toutes('CONFIER_TURBO')).toEqual([]);
      expect(m.violations).toEqual([]);
    });
  }
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
    const r = { ...REG, detourMaxAjoutMin: 2 };
    expect(refusDe(scene({ etatK: 'AU_COMPTOIR', ecartMin: 1, reglages: r }), 'b')).toEqual(['AJOUT:DUREE_TOURNEE']);
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
