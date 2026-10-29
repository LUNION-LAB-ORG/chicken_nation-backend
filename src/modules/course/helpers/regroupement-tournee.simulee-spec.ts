/**
 * Scènes du REGROUPEMENT PAR TOURNÉE (retour du client du 28/10 :
 * « s'il prenait un autre itinéraire il pouvait grouper ») : conception
 * `regroupement-tournee.md`, section 9.
 *
 * Fichier de test seulement (nom en « -spec.ts » : ni construit, ni lancé
 * comme une suite). Points réels d'Abidjan, positions des clients
 * hypothétiques (la production n'est pas lue). Distances PAR LA ROUTE fixées
 * ici, comme le cache routier de 30 jours les donnerait : restaurant →
 * client (`routeMetres`) et client → client (`entreCandidats`).
 *
 * Conditions communes : commandes passées 15 min avant d'être prêtes
 * (promesse = passée + 35 min, limite = promesse + 5 min) ; un livreur libre
 * au comptoir ; 12 h 15 = pointe (16 km/h), 16 h 00 = hors pointe (22 km/h).
 */
import { CourseStatut, DeliveryStatut } from '@prisma/client';

import { ClientDirection, evaluerPaire, MesureDetour, REGLAGES_DIRECTION_DEFAUT, VerdictPaire } from './direction.rules';
import { ILatLng } from './geo.helper';
import { cmd, crs, enPrep, h, hms, instant, livr, OptionsLivreur, plus, R } from './monde-planification.simulee-spec';
import {
  clePaire,
  CommandePlanif,
  CoursePlanif,
  InstantanePlanification,
  LivreurPlanif,
  OptionsPlanification,
  planifier,
  PlanRestaurant,
  REGLAGES_PLANIFICATION_DEFAUT,
  ReglagesPlanification,
} from './planification.rules';

export { h, hms, plus };

/** Restaurants : Zone 4 (celui du monde simulé) et Angré. */
export const ZONE_4: ILatLng = R;
export const ANGRE: ILatLng = { lat: 5.3976, lng: -3.9885 };

export interface Geo {
  nom: string;
  restaurant: ILatLng;
  A: ILatLng;
  B: ILatLng;
  /** Par la route : restaurant → A, restaurant → B, A → B (mètres). */
  dRA: number;
  dRB: number;
  dAB: number;
  /** Tracé routier restaurant → B (règle de direction), s'il est connu. */
  traceB?: ILatLng[];
  /** Mesure Google du détour R → P → L (test 5 de la direction), si le service l'a faite. */
  detour?: MesureDetour;
}

/** T1 : Anoumabo (nord) et Koumassi nord (est), à angle droit (écart de cap 88°). */
export const T1_ANGLE_DROIT: Geo = {
  nom: 'T1 angle droit, Anoumabo / Koumassi',
  restaurant: ZONE_4,
  A: { lat: 5.305, lng: -3.979 },
  B: { lat: 5.292, lng: -3.955 },
  dRA: 3000,
  dRB: 2900,
  dAB: 3800,
};

const HKB_SORTIE_MARCORY: ILatLng = { lat: 5.3117011, lng: -3.9797001 };
const HKB_MILIEU: ILatLng = { lat: 5.3183745, lng: -3.9801586 };
const HKB_PEAGE: ILatLng = { lat: 5.3273915, lng: -3.980939 };
const RIVIERA_LAGUNE: ILatLng = { lat: 5.327, lng: -3.981 };

/** T2 : Marcory bord de lagune et Riviera bord de lagune, de part et d'autre du pont HKB. */
export const T2_PONT_HKB: Geo = {
  nom: 'T2 pont HKB, Marcory / Riviera',
  restaurant: ZONE_4,
  A: { lat: 5.306, lng: -3.966 },
  B: RIVIERA_LAGUNE,
  dRA: 3000,
  dRB: 5600,
  dAB: 4200,
  traceB: [ZONE_4, { lat: 5.299, lng: -3.976 }, HKB_SORTIE_MARCORY, HKB_MILIEU, HKB_PEAGE, RIVIERA_LAGUNE],
};

/**
 * T3 : le cas du client, un AUTRE itinéraire. Google : R → B direct 14 min,
 * R → A → B 23 min 24 s, « détour de 9 min, trop long ». La tournée A puis B
 * (40 min en pointe) dessert pourtant les deux.
 */
export const T3_AUTRE_ITINERAIRE: Geo = {
  nom: 'T3 cas du client, autre itinéraire',
  restaurant: ZONE_4,
  A: { lat: 5.3198, lng: -3.9613 },
  B: { lat: 5.3031, lng: -3.9369 },
  dRA: 5600,
  dRB: 6300,
  dAB: 4200,
  detour: { secondesDirect: 840, secondesAvecEtape: 1404 },
};

/** T6 : sens vraiment opposés depuis Angré, 10 km chacun (Abobo Avocatier, Riviera Faya). */
export const T6_SENS_OPPOSES: Geo = {
  nom: 'T6 sens opposés, 10 km chacun',
  restaurant: ANGRE,
  A: { lat: 5.445, lng: -4.035 },
  B: { lat: 5.36, lng: -3.935 },
  dRA: 10_000,
  dRB: 10_000,
  dAB: 20_000,
};

/** T9 : Biétry, deux clients à 300 m l'un de l'autre : même zone, groupés aujourd'hui. */
export const T9_MEME_ZONE: Geo = {
  nom: 'T9 Biétry, même zone',
  restaurant: ZONE_4,
  A: { lat: 5.2765, lng: -3.9605 },
  B: { lat: 5.278, lng: -3.958 },
  dRA: 1900,
  dRB: 2100,
  dAB: 400,
};

export type Id = 'a' | 'b';

/** Client d'une commande de la scène, avec sa distance par la route depuis le restaurant (sauf `sansRoute`). */
export function client(id: Id, g: Geo, sansRoute = false): ClientDirection {
  return {
    id,
    position: id === 'a' ? g.A : g.B,
    routeMetres: sansRoute ? null : id === 'a' ? g.dRA : g.dRB,
    trace: id === 'b' && g.traceB ? g.traceB : null,
  };
}

/**
 * Commande de la scène : prête à `prete` (passée 15 min avant, sauf
 * `creee`), ou en préparation jusqu'à `finCuisine`.
 */
export function commande(
  id: Id,
  g: Geo,
  o: { prete?: Date; creee?: Date; finCuisine?: Date; sansRoute?: boolean },
): CommandePlanif {
  const prete = o.finCuisine ?? o.prete!;
  const creee = o.creee ?? plus(prete, -15 * 60);
  const base = o.finCuisine
    ? enPrep(id, o.finCuisine, { created_at: creee, prepared_at: plus(creee, 60) })
    : cmd(id, { created_at: creee, ready_at: prete });
  return { ...base, client: client(id, g, o.sansRoute) };
}

/** Verdict de direction de la paire, tel que le service le mesure (détour Google compris si la scène en a un). */
export function verdictScene(g: Geo): VerdictPaire {
  return evaluerPaire(g.restaurant, client('a', g), client('b', g), REGLAGES_DIRECTION_DEFAUT, g.detour ?? null) as VerdictPaire;
}

/**
 * Options du passage : verdict de direction mesuré par le service (la scène
 * T3 a une mesure Google) et, sauf `candidats: false`, la distance par la
 * route entre les deux clients (`entreCandidats`, cache des 30 jours).
 */
export function optionsScene(g: Geo, o: { candidats?: boolean } = {}): OptionsPlanification {
  const cle = clePaire('a', 'b');
  const options: Record<string, unknown> = {};
  if (g.detour) options.verdicts = new Map([[cle, verdictScene(g)]]);
  if (o.candidats !== false) options.entreCandidats = new Map([[cle, g.dAB]]);
  return options as OptionsPlanification;
}

/** Turbo : coupé, ou actif avec ce délai de prise en charge (minutes). */
export type Turbo = 'coupe' | number;

/** Réglages de la scène : défauts, Turbo, et réglages du regroupement par tournée. */
export function reglagesScene(turbo: Turbo, autres: Record<string, unknown> = {}): ReglagesPlanification {
  return {
    ...REGLAGES_PLANIFICATION_DEFAUT,
    turboActif: turbo !== 'coupe',
    ...(typeof turbo === 'number' ? { turboPriseEnChargeMin: turbo } : {}),
    ...autres,
  } as ReglagesPlanification;
}

/** Interrupteur coupé : la règle d'aujourd'hui, à l'identique. */
export const SANS_SECOND_AVIS = { regroupementTournee: false };

/** Le livreur `id`, au comptoir du restaurant `ou` (Zone 4 par défaut) et libre (ou dans l'état donné), nouvelle appli. */
export const livreur = (t: Date, id = 'l', o: OptionsLivreur = {}, ou: ILatLng = ZONE_4): LivreurPlanif =>
  livr(id, t, { auComptoir: true, protocole_appli: 4, position: ou, ...o });

/** Une scène jouée par `planifier`. */
export interface Scene {
  nom: string;
  t: Date;
  g: Geo;
  commandes?: CommandePlanif[];
  courses?: CoursePlanif[];
  livreurs?: LivreurPlanif[];
  turbo: Turbo;
  autres?: Record<string, unknown>;
  candidats?: boolean;
}

/** Création à 12 h 15 (ou 16 h 00) : A prête une minute avant B, le seul livreur libre au comptoir. */
export function creation(g: Geo, heure: '12:15' | '16:00', turbo: Turbo, o: Partial<Scene> = {}): Scene {
  const t = h(heure);
  return {
    nom: `${g.nom}, ${heure}, Turbo ${turbo === 'coupe' ? 'coupé' : `${turbo} min`}`,
    t,
    g,
    commandes: [commande('a', g, { prete: plus(t, -60) }), commande('b', g, { prete: t })],
    turbo,
    ...o,
  };
}

export function instantaneScene(s: Scene): InstantanePlanification {
  return instant(s.t, {
    position: s.g.restaurant,
    commandes: s.commandes ?? [],
    courses: s.courses ?? [],
    livreurs: s.livreurs ?? [livreur(s.t, 'l', {}, s.g.restaurant)],
  });
}

export function jouer(s: Scene, autres: Record<string, unknown> = {}): PlanRestaurant {
  return planifier(
    instantaneScene(s),
    reglagesScene(s.turbo, { ...(s.autres ?? {}), ...autres }),
    optionsScene(s.g, { candidats: s.candidats }),
  );
}

/** Course au comptoir (livreur `l` arrivé) avec ces commandes. */
export function auComptoir(id: string, t: Date, commandes: CommandePlanif[], o: Partial<CoursePlanif> = {}): CoursePlanif {
  return crs(id, {
    statut: CourseStatut.AT_RESTAURANT,
    deliverer_id: 'l',
    assigned_at: plus(t, -120),
    at_restaurant_at: plus(t, -60),
    commandes,
    ...o,
  });
}

/** T5 (géographie de T1, 12 h 15) : une commande déjà en retard. */
export function sceneT5(cas: 'A_EN_RETARD' | 'B_EN_RETARD' | 'AJOUT_AU_COMPTOIR', turbo: Turbo): Scene {
  const t = h('12:15');
  const g = T1_ANGLE_DROIT;
  const base = { nom: `T5 ${cas}, Turbo ${turbo}`, t, g, turbo };
  if (cas === 'A_EN_RETARD') {
    return { ...base, commandes: [commande('a', g, { prete: plus(t, -60), creee: h('11:30') }), commande('b', g, { prete: t })] };
  }
  if (cas === 'B_EN_RETARD') {
    return { ...base, commandes: [commande('a', g, { prete: plus(t, -60) }), commande('b', g, { prete: t, creee: h('11:30') })] };
  }
  const a = commande('a', g, { prete: plus(t, -60), creee: h('11:30') });
  return {
    ...base,
    commandes: [commande('b', g, { prete: t, creee: h('11:45') })],
    courses: [auComptoir('k', t, [a])],
    livreurs: [livreur(t, 'l', { etat: { en_course: true } })],
  };
}

/**
 * T7 (géographie de T2) : A prête 12 h 15 dans la course du livreur au
 * comptoir, B en cuisine jusqu'à 12 h 18. Passage 2 : 12 h 18 min 05 s, B
 * prête, la course retenue l'attend.
 */
export function sceneT7(turbo: Turbo, passage: 1 | 2): Scene {
  const g = T2_PONT_HKB;
  const a = commande('a', g, { prete: h('12:15') });
  const t = passage === 1 ? h('12:15') : h('12:18:05');
  const l = livreur(t, 'l', { etat: { en_course: true } });
  if (passage === 1) {
    const b = commande('b', g, { finCuisine: h('12:18'), creee: h('12:03') });
    return { nom: `T7 passage 1, Turbo ${turbo}`, t, g, turbo, commandes: [b], courses: [auComptoir('k', t, [a])], livreurs: [l] };
  }
  const b = commande('b', g, { prete: h('12:18'), creee: h('12:03') });
  const k = auComptoir('k', t, [a], { retenue_jusqua: h('12:18'), commandes_attendues: ['b'] });
  return { nom: `T7 passage 2, Turbo ${turbo}`, t, g, turbo, commandes: [b], courses: [k], livreurs: [l] };
}

/** T8 (géographie de T3) : A prête 12 h 15 au comptoir, B en cuisine jusqu'à 12 h 20 (limite de l'attente courte). */
export function sceneT8(turbo: Turbo, autres: Record<string, unknown> = {}): Scene {
  const t = h('12:15');
  const g = T3_AUTRE_ITINERAIRE;
  return {
    nom: `T8, Turbo ${turbo}, ${JSON.stringify(autres)}`,
    t,
    g,
    turbo,
    autres,
    commandes: [commande('b', g, { finCuisine: h('12:20'), creee: h('12:05') })],
    courses: [auComptoir('k', t, [commande('a', g, { prete: t })])],
    livreurs: [livreur(t, 'l', { etat: { en_course: true } })],
  };
}

/**
 * T10, passage 2 (géographie de T3, 12 h 15 min 10 s) : la course de B
 * proposée au livreur (offre en attente) ou acceptée (au comptoir) ; la
 * course de A seule, sans livreur.
 */
export function sceneT10(turbo: Turbo, acceptee: boolean): Scene {
  const g = T3_AUTRE_ITINERAIRE;
  const t = plus(h('12:15'), 10);
  const a = commande('a', g, { prete: h('12:14') });
  const b = commande('b', g, { prete: h('12:15') });
  const ka = crs('ka', { created_at: t, commandes: [a] });
  const kb = acceptee
    ? auComptoir('kb', t, [b])
    : crs('kb', { created_at: t, commandes: [b], offre: { id: 'o1', deliverer_id: 'l', expires_at: plus(t, 50) } });
  const l = livreur(t, 'l', { etat: acceptee ? { en_course: true } : { offre_en_attente: true } });
  return { nom: `T10 passage 2, ${acceptee ? 'acceptée' : 'offre en attente'}, Turbo ${turbo}`, t, g, turbo, courses: [ka, kb], livreurs: [l] };
}

/** Toutes les scènes de T1 à T8 (et T10) : l'interrupteur coupé doit y rendre le plan de main (T12). */
export function toutesLesScenes(): Scene[] {
  const scenes: Scene[] = [];
  const turbos: Turbo[] = ['coupe', 15, 0];
  for (const g of [T1_ANGLE_DROIT, T2_PONT_HKB, T3_AUTRE_ITINERAIRE, T6_SENS_OPPOSES, T9_MEME_ZONE]) {
    for (const heure of ['12:15', '16:00'] as const) {
      for (const turbo of turbos) {
        scenes.push(creation(g, heure, turbo));
        const t = h(heure);
        scenes.push({
          ...creation(g, heure, turbo),
          nom: `${g.nom}, ${heure}, Turbo ${turbo}, deux livreurs`,
          livreurs: [livreur(t, 'l', {}, g.restaurant), livreur(t, 'm', {}, g.restaurant)],
        });
      }
    }
  }
  scenes.push({ ...creation(T6_SENS_OPPOSES, '12:15', 'coupe'), nom: 'T6 plafond 240, Turbo coupé', autres: { regroupementTourneeMaxMin: 240 } });
  scenes.push({ ...creation(T6_SENS_OPPOSES, '12:15', 15), nom: 'T6 plafond 240, Turbo 15', autres: { regroupementTourneeMaxMin: 240 } });
  for (const turbo of ['coupe', 15] as Turbo[]) {
    for (const cas of ['A_EN_RETARD', 'B_EN_RETARD', 'AJOUT_AU_COMPTOIR'] as const) scenes.push(sceneT5(cas, turbo));
    scenes.push(sceneT7(turbo, 1), sceneT7(turbo, 2), sceneT10(turbo, false), sceneT10(turbo, true));
  }
  scenes.push(sceneT8('coupe'), sceneT8('coupe', { regroupementGainMin: 0 }), sceneT8(15));
  return scenes;
}

/** Livraison en attente d'une commande, au rang donné. */
export const livraison = (c: CommandePlanif, rang: number) => ({
  id: `liv-${c.id}`,
  statut: DeliveryStatut.PENDING,
  sequence_order: rang,
  commande: c,
});

/** Les actions d'un plan, en clair (ordre des arrêts et motif compris). */
export function resume(plan: PlanRestaurant): string[] {
  return plan.actions.map((a) => {
    switch (a.type) {
      case 'CREER_COURSE':
        return `CREER ${a.cle} [${a.sequence.join(',')}]${a.motif ? ` ${a.motif}` : ''}`;
      case 'AJOUTER':
        return `AJOUTER ${a.order_id} -> ${a.course_id}${a.motif ? ` ${a.motif}` : ''}`;
      case 'FUSIONNER':
        return `FUSIONNER ${a.absorbee_id} -> ${a.cible_id}${a.motif ? ` ${a.motif}` : ''}`;
      case 'ORDONNER':
        return `ORDONNER ${a.course_id} [${a.sequence.join(',')}] ${a.motif}`;
      case 'OFFRIR':
        return `OFFRIR ${a.course_cle} -> ${a.deliverer_id}`;
      case 'RETENIR':
        return `RETENIR ${a.course_id} ${hms(a.jusqua)} [${a.attendues.map((x) => x.order_id).join(',')}] ${a.motif}`;
      case 'LIBERER':
        return `LIBERER ${a.course_id} ${a.motif}`;
      case 'CONFIER_TURBO':
        return `TURBO ${a.course_id}`;
      default:
        return a.type;
    }
  });
}

/** Refus du plan pour une commande (ou une course absorbée), « ESSAI:MOTIF ». */
export const refusDe = (plan: PlanRestaurant, id: string) =>
  plan.refus.filter((x) => x.order_id === id || x.source_id === id).map((x) => `${x.essai}:${x.refus}`);

/**
 * Empreinte d'un plan, champs d'aujourd'hui seulement : actions entières, et
 * refus (essai, commande, course essayée, cible, motif, libellé). Ce qui
 * sert à comparer un plan à celui de main (interrupteur coupé, T12).
 */
export function empreinte(plan: PlanRestaurant): string {
  return JSON.stringify({
    actions: plan.actions,
    refus: plan.refus.map((x) => [x.essai, x.order_id, x.source_id, x.course_cle, x.refus, x.libelle]),
  });
}
