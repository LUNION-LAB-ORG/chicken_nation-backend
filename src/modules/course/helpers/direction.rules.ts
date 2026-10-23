/**
 * MÊME DIRECTION : deux clients d'un même restaurant peuvent-ils partir dans
 * la même course ? (conception du regroupement, section 2)
 *
 * ⚠️ Règle PURE, sans base ni Google : elle reçoit les coordonnées, les
 * distances et tracés routiers déjà connus, et, au besoin, une fonction qui
 * mesure un détour. C'est elle qu'on teste.
 *
 * Le client l'a dit : « même direction » veut dire MÊME TRAJET ou MÊME ZONE,
 * pas même rayon. L'ancien critère (1 500 m entre clients, à vol d'oiseau)
 * acceptait deux clients à 700 m de part et d'autre du restaurant et refusait
 * le même axe à 2 et 4 km.
 *
 * Deux clients A et B d'un restaurant R vont dans la même direction si l'un
 * est sur le trajet de l'autre (le plus proche, P, est près de la route qui
 * mène au plus lointain, L, et avant lui), ou s'ils sont dans la même zone.
 * Sept tests, dans l'ordre ; le premier qui conclut l'emporte et donne le
 * MOTIF, journalisé et affiché :
 *
 *  1. A et B à moins de 150 m à vol d'oiseau            → compatibles, « même adresse »
 *  2. caps depuis R écartés de plus de 100°, les deux
 *     à plus de 1 200 m de R                            → incompatibles, « sens opposés »
 *  3. tracé R → L connu, P à moins du couloir du tracé
 *     et pas plus de 300 m au-delà de L                 → compatibles, « sur le trajet »
 *  4. A et B à moins du rayon de zone, caps écartés
 *     de 60° au plus                                    → « même zone », à confirmer par le
 *                                                         test 5 quand Google répond
 *  5. caps écartés de 60° au plus, tracé absent ou P
 *     juste hors du couloir (moins de deux couloirs) :
 *     détour réel t(R→P→L) − t(R→L) borné en minutes
 *     et en pourcentage                                 → compatibles, « détour de 4 min »
 *  6. sans carte (ni tracé ni détour) : caps écartés
 *     de l'angle maximal au plus, P à moins du couloir
 *     de la droite R → L                                → compatibles, « même direction (sans carte) »
 *  7. sinon                                             → incompatibles, « direction différente »
 *
 * Pourquoi le couloir le long du TRACÉ plutôt que l'angle seul : depuis
 * Zone 4 ou Marcory, deux clients dans le même angle peuvent être sur deux
 * rives de la lagune. Le tracé routier passe par le pont réel ; un client de
 * l'autre rive en est loin. Quand le tracé est connu et dit « loin », aucun
 * angle ne le contredit (le test 6 ne joue que sans tracé).
 *
 * ⚠️ On ne mélange JAMAIS des mètres routiers et des mètres à vol d'oiseau
 * dans une même comparaison (même règle que l'acheminement, 14/10) : P et L
 * sont départagés par la route si les DEUX distances routières sont connues,
 * sinon à vol d'oiseau pour les deux. Google muet, lent ou plafonné : on
 * passe au repli sans carte, jamais de blocage d'une commande.
 */

import { haversineMeters, ILatLng } from './geo.helper';
import { projeterSurTrace, ProjectionSurTrace } from './polyligne';

// ─── Seuils fixes (conception 2.3) ───────────────────────────────────────────

/** Test 1 : au-dessous, c'est la même adresse. */
export const MEME_ADRESSE_M = 150;
/** Test 2 : écart de cap au-delà duquel deux clients partent en sens opposés. */
export const SENS_OPPOSES_ECART_DEG = 100;
/** Test 2 : ne joue que si les deux clients sont à plus de cette distance du restaurant. */
export const SENS_OPPOSES_DISTANCE_M = 1200;
/** Test 3 : P peut dépasser L de cette longueur le long du tracé (imprécision des adresses). */
export const MARGE_APRES_LOINTAIN_M = 300;
/** Tests 4 et 5 : écart de cap maximal. */
export const ECART_CAP_ZONE_DEG = 60;
/** Test 5 : « négatif de peu » = P à moins de ce nombre de couloirs du tracé. */
export const COULOIR_PROCHE_FACTEUR = 2;
/** Durées sans carte : la route fait environ 1,4 fois le vol d'oiseau (conception 2.4). */
export const FACTEUR_ROUTE_VOL_OISEAU = 1.4;

// ─── Réglages (Paramètres > Livraison) ───────────────────────────────────────

export interface ReglagesDirection {
  /** `course.direction_couloir_m` : largeur du couloir le long du trajet. */
  couloirM: number;
  /** `course.direction_zone_rayon_m` : rayon d'une même zone. */
  zoneRayonM: number;
  /** `course.direction_angle_max_deg` : écart d'angle sans carte. */
  angleMaxDeg: number;
  /** `course.direction_detour_max_min` : détour maximal, en minutes. */
  detourMaxMin: number;
  /** `course.direction_detour_max_pct` : détour maximal, en pour cent du trajet direct. */
  detourMaxPct: number;
}

export const REGLAGES_DIRECTION_DEFAUT: Readonly<ReglagesDirection> = Object.freeze({
  couloirM: 600,
  zoneRayonM: 800,
  angleMaxDeg: 35,
  detourMaxMin: 6,
  detourMaxPct: 40,
});

/** Clés des réglages de direction, dans l'ordre de l'écran. */
export const CLES_REGLAGES_DIRECTION = {
  couloirM: 'course.direction_couloir_m',
  zoneRayonM: 'course.direction_zone_rayon_m',
  angleMaxDeg: 'course.direction_angle_max_deg',
  detourMaxMin: 'course.direction_detour_max_min',
  detourMaxPct: 'course.direction_detour_max_pct',
  google: 'course.direction_google',
} as const;

export interface ReglagesDirectionLus {
  reglages: ReglagesDirection;
  /** `course.direction_google` : utiliser les trajets Google (tracés et détours). */
  google: boolean;
  /** Clés dont la valeur a été refusée et remplacée par le défaut, avec la valeur refusée. */
  refusees: { cle: string; valeur: string }[];
}

/**
 * Lit les réglages de direction depuis les valeurs brutes de la table des
 * réglages. Contrairement au `toNumber` historique du module course, 0 est
 * accepté : chaque 0 coupe le test qu'il règle (couloir 0 = jamais « sur le
 * trajet », zone 0 = jamais « même zone », angle 0 = jamais « sans carte »,
 * détour 0 = aucun détour toléré). Une valeur négative, illisible ou un angle
 * de plus de 180° est refusé, remplacé par le défaut et SIGNALÉ.
 */
export function lireReglagesDirection(valeurs: Record<string, string | null | undefined>): ReglagesDirectionLus {
  const refusees: { cle: string; valeur: string }[] = [];
  const nombre = (champ: keyof ReglagesDirection, max = Number.POSITIVE_INFINITY): number => {
    const cle = CLES_REGLAGES_DIRECTION[champ];
    const brut = valeurs[cle];
    if (brut === undefined || brut === null || brut.trim() === '') return REGLAGES_DIRECTION_DEFAUT[champ];
    const n = Number(brut.trim().replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > max) {
      refusees.push({ cle, valeur: brut });
      return REGLAGES_DIRECTION_DEFAUT[champ];
    }
    return n;
  };

  const reglages: ReglagesDirection = {
    couloirM: nombre('couloirM'),
    zoneRayonM: nombre('zoneRayonM'),
    angleMaxDeg: nombre('angleMaxDeg', 180),
    detourMaxMin: nombre('detourMaxMin'),
    detourMaxPct: nombre('detourMaxPct'),
  };

  let google = true;
  const brutGoogle = valeurs[CLES_REGLAGES_DIRECTION.google];
  if (brutGoogle !== undefined && brutGoogle !== null && brutGoogle.trim() !== '') {
    const v = brutGoogle.trim().toLowerCase();
    if (['1', 'true', 'on', 'oui'].includes(v)) google = true;
    else if (['0', 'false', 'off', 'non'].includes(v)) google = false;
    else refusees.push({ cle: CLES_REGLAGES_DIRECTION.google, valeur: brutGoogle });
  }

  return { reglages, google, refusees };
}

// ─── Données d'entrée ────────────────────────────────────────────────────────

/** Un client (une commande à livrer), vu par la règle de direction. */
export interface ClientDirection {
  /** Identifiant de la commande. */
  id: string;
  /** Coordonnées de livraison ; `null` (HubRise 0,0, call center v1) = la commande part seule. */
  position: ILatLng | null;
  /**
   * Distance PAR LA ROUTE depuis le restaurant (mètres), donnée par Google
   * (`itineraireRoutier`), ou `null`. Jamais une distance à vol d'oiseau
   * redressée : `Order.delivery_distance_km` peut en être une (repli des
   * frais quand Google est muet) et n'est donc pas utilisable ici.
   */
  routeMetres?: number | null;
  /** Tracé routier restaurant → client (décodé), ou `null`. */
  trace?: readonly ILatLng[] | null;
}

/** Durées Google SANS trafic : trajet direct R → L, et avec l'étape R → P → L. */
export interface MesureDetour {
  secondesDirect: number;
  secondesAvecEtape: number;
}

/**
 * Mesure du détour réel (Google, sans trafic, cache 30 jours, délai 2,5 s).
 * Rend `null` si Google est coupé, muet, lent ou plafonné : on passe alors
 * au repli sans carte.
 */
export type MesurerDetour = (
  restaurant: ILatLng,
  proche: ILatLng,
  lointain: ILatLng,
) => Promise<MesureDetour | null>;

// ─── Verdict d'une paire ─────────────────────────────────────────────────────

export type MotifDirection =
  | 'MEME_ADRESSE'
  | 'SENS_OPPOSES'
  | 'SUR_LE_TRAJET'
  | 'MEME_ZONE'
  | 'DETOUR'
  | 'DETOUR_TROP_LONG'
  | 'SANS_CARTE'
  | 'DIRECTION_DIFFERENTE'
  | 'SANS_COORDONNEES';

/** Numéro du test qui a conclu (conception 2.3) ; 0 = coordonnées manquantes. */
export type TestDirection = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Comment le proche et le lointain ont été départagés : jamais un mélange des deux. */
export type ClassementDistance = 'route' | 'vol_oiseau';

export interface VerdictPaire {
  compatible: boolean;
  motif: MotifDirection;
  /** Test qui a conclu. */
  test: TestDirection;
  /** Texte court, pour le journal et les écrans (« sur le trajet », « détour de 4 min »). */
  libelle: string;
  /** P : le client le plus proche du restaurant. */
  procheId: string;
  /** L : le client le plus lointain. */
  lointainId: string;
  classement: ClassementDistance;
  /** Écart des caps depuis le restaurant, en degrés (0 à 180). */
  ecartCapDeg: number | null;
  /** Distance de P au tracé de L, si le tracé est connu. */
  distanceAuTraceM: number | null;
  /** Détour mesuré par Google, en secondes, si le test 5 a été mené. */
  detourSecondes: number | null;
  /**
   * Accepté comme « compatible avec le plus lointain » dans un groupe : tests
   * 1, 3, 5 ou 6 (conception 2.4). Une « même zone » non confirmée par Google
   * (test 4 seul) ne l'est que si le test 6 l'aurait aussi acceptée.
   */
  versLointain: boolean;
  /** Les deux clients sont dans la même zone (ou à la même adresse), sans démenti de Google. */
  memeZone: boolean;
}

/** Le test 5 doit être mené : la paire attend la mesure du détour R → P → L. */
export interface DetourAMesurer {
  aMesurer: true;
  procheId: string;
  lointainId: string;
  proche: ILatLng;
  lointain: ILatLng;
}

export function estDetourAMesurer(v: VerdictPaire | DetourAMesurer): v is DetourAMesurer {
  return (v as DetourAMesurer).aMesurer === true;
}

/** Texte d'un motif, sans valeur d'énumération brute. */
export function libelleDirection(motif: MotifDirection, detourSecondes?: number | null): string {
  const minutes = detourSecondes == null ? null : Math.max(0, Math.round(detourSecondes / 60));
  const detour = minutes === null ? 'détour' : minutes === 0 ? 'détour de moins d’une minute' : `détour de ${minutes} min`;
  switch (motif) {
    case 'MEME_ADRESSE':
      return 'même adresse';
    case 'SENS_OPPOSES':
      return 'sens opposés';
    case 'SUR_LE_TRAJET':
      return 'sur le trajet';
    case 'MEME_ZONE':
      return 'même zone';
    case 'DETOUR':
      return detour;
    case 'DETOUR_TROP_LONG':
      return `${detour}, trop long`;
    case 'SANS_CARTE':
      return 'même direction (sans carte)';
    case 'DIRECTION_DIFFERENTE':
      return 'direction différente';
    case 'SANS_COORDONNEES':
      return 'adresse sans coordonnées';
  }
}

// ─── Géométrie depuis le restaurant ──────────────────────────────────────────

/** Cap (0 à 360°, 0 = nord, 90 = est) du restaurant vers un point. */
export function capDepuis(origine: ILatLng, point: ILatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const phi1 = rad(origine.lat);
  const phi2 = rad(point.lat);
  const dLambda = rad(point.lng - origine.lng);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Écart entre deux caps, de 0 à 180°. */
export function ecartCap(capA: number, capB: number): number {
  const d = Math.abs(capA - capB) % 360;
  return d > 180 ? 360 - d : d;
}

const routeConnue = (c: ClientDirection): boolean =>
  typeof c.routeMetres === 'number' && Number.isFinite(c.routeMetres) && c.routeMetres > 0;

const traceUtilisable = (c: ClientDirection): readonly ILatLng[] | null =>
  c.trace && c.trace.length >= 2 ? c.trace : null;

/**
 * Le plus lointain d'un ensemble de clients (avec coordonnées) : par la route
 * si TOUTES les distances routières sont connues, sinon à vol d'oiseau pour
 * tous. À égalité, l'ordre d'entrée.
 */
export function choisirLointain(
  restaurant: ILatLng,
  clients: readonly ClientDirection[],
): { lointain: ClientDirection; classement: ClassementDistance } | null {
  const places = clients.filter((c) => c.position);
  if (places.length === 0) return null;
  const classement: ClassementDistance = places.every(routeConnue) ? 'route' : 'vol_oiseau';
  const mesure = (c: ClientDirection) =>
    classement === 'route' ? (c.routeMetres as number) : haversineMeters(restaurant, c.position!);
  let lointain = places[0];
  for (const c of places.slice(1)) {
    if (mesure(c) > mesure(lointain)) lointain = c;
  }
  return { lointain, classement };
}

/** Tracé de référence vers L : le tracé routier s'il est connu, sinon la droite R → L. */
function referenceVers(restaurant: ILatLng, lointain: ClientDirection): {
  trace: readonly ILatLng[];
  base: 'trace' | 'droite';
} {
  const trace = traceUtilisable(lointain);
  return trace ? { trace, base: 'trace' } : { trace: [restaurant, lointain.position!], base: 'droite' };
}

/** P est-il dans le couloir de la référence, et pas au-delà de L de plus de la marge ? */
function dansLeCouloir(projection: ProjectionSurTrace | null, couloirM: number): boolean {
  return (
    projection !== null &&
    projection.distanceMetres <= couloirM &&
    projection.positionMetres <= projection.longueurMetres + MARGE_APRES_LOINTAIN_M
  );
}

// ─── Règle d'une paire ───────────────────────────────────────────────────────

/**
 * Compatibilité de deux clients d'un même restaurant (tests 1 à 7).
 *
 * `detour` : mesure du test 5.
 *  - `undefined` : pas encore demandée. Si le test 5 doit être mené, la
 *    fonction rend `DetourAMesurer` au lieu d'un verdict ; l'appelant mesure
 *    puis rappelle avec la mesure (ou `null`). `compatibilitePaire` le fait.
 *  - `null` : Google coupé, muet, lent ou plafonné : repli sans carte.
 *  - une mesure : le test 5 tranche.
 *
 * Pour ne jamais rien demander à Google, passer `null`.
 */
export function evaluerPaire(
  restaurant: ILatLng | null,
  a: ClientDirection,
  b: ClientDirection,
  reglages: ReglagesDirection = REGLAGES_DIRECTION_DEFAUT,
  detour?: MesureDetour | null,
): VerdictPaire | DetourAMesurer {
  // ── 0. Coordonnées manquantes : la commande part seule (conception 2.2).
  if (!restaurant || !a.position || !b.position) {
    return verdict({
      compatible: false,
      motif: 'SANS_COORDONNEES',
      test: 0,
      procheId: a.id,
      lointainId: b.id,
      classement: 'vol_oiseau',
    });
  }

  const choix = choisirLointain(restaurant, [a, b])!;
  const L = choix.lointain;
  const P = L === a ? b : a;
  const pP = P.position!;
  const pL = L.position!;
  const base = { procheId: P.id, lointainId: L.id, classement: choix.classement };

  const entreClients = haversineMeters(pP, pL);
  const ecart = ecartCap(capDepuis(restaurant, pP), capDepuis(restaurant, pL));

  // ── 1. Même adresse.
  if (entreClients <= MEME_ADRESSE_M) {
    return verdict({ ...base, compatible: true, motif: 'MEME_ADRESSE', test: 1, ecartCapDeg: ecart, versLointain: true, memeZone: true });
  }

  // ── 2. Sens opposés (vol d'oiseau pour les deux distances au restaurant).
  if (
    ecart > SENS_OPPOSES_ECART_DEG &&
    haversineMeters(restaurant, pP) > SENS_OPPOSES_DISTANCE_M &&
    haversineMeters(restaurant, pL) > SENS_OPPOSES_DISTANCE_M
  ) {
    return verdict({ ...base, compatible: false, motif: 'SENS_OPPOSES', test: 2, ecartCapDeg: ecart });
  }

  // ── 3. Sur le trajet : couloir le long du tracé routier R → L.
  const traceL = traceUtilisable(L);
  const projection = traceL ? projeterSurTrace(pP, traceL) : null;
  const distanceAuTraceM = projection?.distanceMetres ?? null;
  if (traceL && dansLeCouloir(projection, reglages.couloirM)) {
    return verdict({
      ...base,
      compatible: true,
      motif: 'SUR_LE_TRAJET',
      test: 3,
      ecartCapDeg: ecart,
      distanceAuTraceM,
      versLointain: true,
      memeZone: entreClients <= reglages.zoneRayonM && ecart <= ECART_CAP_ZONE_DEG,
    });
  }

  // ── 4. Même zone : à confirmer par le détour quand Google répond.
  const zone = entreClients <= reglages.zoneRayonM && ecart <= ECART_CAP_ZONE_DEG;

  // Test 6 (géométrie sans carte), utile au test 4 non confirmé et au repli.
  const sansCarteAccepte =
    ecart <= reglages.angleMaxDeg &&
    dansLeCouloir(projeterSurTrace(pP, [restaurant, pL]), reglages.couloirM);

  // ── 5. Détour réel, seulement s'il peut trancher.
  const test5 =
    ecart <= ECART_CAP_ZONE_DEG &&
    (zone || !traceL || (distanceAuTraceM !== null && distanceAuTraceM <= reglages.couloirM * COULOIR_PROCHE_FACTEUR));

  if (test5 && detour === undefined) {
    return { aMesurer: true, procheId: P.id, lointainId: L.id, proche: pP, lointain: pL };
  }

  const mesure = test5 ? mesureValide(detour) : null;
  if (mesure) {
    const detourSecondes = Math.max(0, mesure.secondesAvecEtape - mesure.secondesDirect);
    const accepte =
      detourSecondes <= reglages.detourMaxMin * 60 &&
      detourSecondes <= (reglages.detourMaxPct / 100) * mesure.secondesDirect;
    if (accepte) {
      return verdict({
        ...base,
        compatible: true,
        motif: zone ? 'MEME_ZONE' : 'DETOUR',
        test: 5,
        ecartCapDeg: ecart,
        distanceAuTraceM,
        detourSecondes,
        versLointain: true,
        memeZone: zone,
      });
    }
    // Google dément : ni même trajet ni même zone.
    return verdict({
      ...base,
      compatible: false,
      motif: 'DETOUR_TROP_LONG',
      test: 5,
      ecartCapDeg: ecart,
      distanceAuTraceM,
      detourSecondes,
    });
  }

  // Pas de détour (Google coupé, muet, lent, plafonné) : la même zone vaut seule.
  if (zone) {
    return verdict({
      ...base,
      compatible: true,
      motif: 'MEME_ZONE',
      test: 4,
      ecartCapDeg: ecart,
      distanceAuTraceM,
      versLointain: !traceL && sansCarteAccepte,
      memeZone: true,
    });
  }

  // ── 6. Repli sans carte : seulement sans tracé (un tracé qui dit « loin » l'emporte sur l'angle).
  if (!traceL && sansCarteAccepte) {
    return verdict({ ...base, compatible: true, motif: 'SANS_CARTE', test: 6, ecartCapDeg: ecart, versLointain: true });
  }

  // ── 7. Direction différente.
  return verdict({ ...base, compatible: false, motif: 'DIRECTION_DIFFERENTE', test: 7, ecartCapDeg: ecart, distanceAuTraceM });
}

function mesureValide(detour: MesureDetour | null | undefined): MesureDetour | null {
  if (!detour) return null;
  const { secondesDirect, secondesAvecEtape } = detour;
  if (!Number.isFinite(secondesDirect) || !Number.isFinite(secondesAvecEtape)) return null;
  if (secondesDirect <= 0 || secondesAvecEtape <= 0) return null;
  return detour;
}

function verdict(
  v: Pick<VerdictPaire, 'compatible' | 'motif' | 'test' | 'procheId' | 'lointainId' | 'classement'> &
    Partial<Pick<VerdictPaire, 'ecartCapDeg' | 'distanceAuTraceM' | 'detourSecondes' | 'versLointain' | 'memeZone'>>,
): VerdictPaire {
  return {
    compatible: v.compatible,
    motif: v.motif,
    test: v.test,
    libelle: libelleDirection(v.motif, v.detourSecondes),
    procheId: v.procheId,
    lointainId: v.lointainId,
    classement: v.classement,
    ecartCapDeg: v.ecartCapDeg ?? null,
    distanceAuTraceM: v.distanceAuTraceM ?? null,
    detourSecondes: v.detourSecondes ?? null,
    versLointain: v.compatible ? v.versLointain ?? false : false,
    memeZone: v.compatible ? v.memeZone ?? false : false,
  };
}

/**
 * Compatibilité d'une paire, en menant le test 5 si besoin : `mesurerDetour`
 * est appelée au plus une fois, et jamais quand les tests 1 à 3 ont conclu.
 * Sans `mesurerDetour`, ou si elle échoue ou lève, repli sans carte.
 */
export async function compatibilitePaire(
  restaurant: ILatLng | null,
  a: ClientDirection,
  b: ClientDirection,
  reglages: ReglagesDirection = REGLAGES_DIRECTION_DEFAUT,
  mesurerDetour?: MesurerDetour,
): Promise<VerdictPaire> {
  const premier = evaluerPaire(restaurant, a, b, reglages, mesurerDetour ? undefined : null);
  if (!estDetourAMesurer(premier)) return premier;

  let mesure: MesureDetour | null = null;
  try {
    mesure = await mesurerDetour!(restaurant!, premier.proche, premier.lointain);
  } catch {
    mesure = null;
  }
  return evaluerPaire(restaurant, a, b, reglages, mesure) as VerdictPaire;
}

// ─── Groupes et ordre des arrêts (conception 2.4) ────────────────────────────

/**
 * - `seul` : un seul client ;
 * - `trajet` : chaque client est compatible avec le plus lointain (tests 1,
 *   3, 5 ou 6) ; arrêts dans l'ordre de la route vers le plus lointain ;
 * - `zone` : tous deux à deux dans la même zone ; arrêts au plus proche
 *   voisin en partant du restaurant.
 */
export type ModeGroupe = 'seul' | 'trajet' | 'zone';

export interface VerdictGroupe {
  valide: boolean;
  mode: ModeGroupe | null;
  lointainId: string | null;
  classement: ClassementDistance;
  /** Motif du groupe (champ `motif_regroupement` de la course), le moins favorable de ses paires. */
  motif: MotifDirection | null;
  libelle: string;
  /** Ordre des arrêts (identifiants), vide si le groupe n'est pas valide. */
  ordre: string[];
  /** Paires examinées. */
  verdicts: VerdictPaire[];
  /** Première paire qui empêche le groupe, s'il n'est pas valide. */
  refus: VerdictPaire | null;
}

/** Du plus favorable au moins favorable : le motif d'un groupe est le dernier présent. */
const RANG_MOTIF: MotifDirection[] = ['MEME_ADRESSE', 'SUR_LE_TRAJET', 'MEME_ZONE', 'DETOUR', 'SANS_CARTE'];

/**
 * Validité d'un groupe de clients (2 ou 3 en pratique) et ordre de ses
 * arrêts, à partir des verdicts de paires fournis par `verdictDe` (calculés
 * d'avance, ou par `compatibiliteGroupe`). Les contrôles de taille, de durée
 * de tournée et de retard sont ceux du planificateur, pas d'ici.
 *
 * Un groupe est valide si chaque client est compatible avec le plus lointain
 * (« sur le trajet »), ou si tous sont deux à deux dans la même zone. Un
 * client sans coordonnées n'est jamais groupé.
 */
export function evaluerGroupe(
  restaurant: ILatLng | null,
  clients: readonly ClientDirection[],
  verdictDe: (a: ClientDirection, b: ClientDirection) => VerdictPaire,
): VerdictGroupe {
  const vide: VerdictGroupe = {
    valide: false,
    mode: null,
    lointainId: null,
    classement: 'vol_oiseau',
    motif: null,
    libelle: '',
    ordre: [],
    verdicts: [],
    refus: null,
  };
  if (clients.length === 0) return vide;
  if (clients.length === 1) {
    return { ...vide, valide: true, mode: 'seul', lointainId: clients[0].id, ordre: [clients[0].id] };
  }
  if (!restaurant || clients.some((c) => !c.position)) {
    const sans = clients.find((c) => !c.position) ?? clients[0];
    const autre = clients.find((c) => c !== sans) ?? clients[0];
    const refus = verdictDe(sans, autre);
    return { ...vide, verdicts: [refus], refus, libelle: refus.libelle, motif: refus.motif };
  }

  const { lointain, classement } = choisirLointain(restaurant, clients)!;
  const autres = clients.filter((c) => c !== lointain);

  // Mode « sur le trajet » : chaque client face au plus lointain.
  const versL = autres.map((c) => verdictDe(c, lointain));
  const verdicts = [...versL];
  if (versL.every((v) => v.compatible && v.versLointain)) {
    const motif = motifLeMoinsFavorable(versL);
    const detourMax = Math.max(0, ...versL.map((v) => v.detourSecondes ?? 0));
    return {
      valide: true,
      mode: 'trajet',
      lointainId: lointain.id,
      classement,
      motif,
      libelle: libelleDirection(motif, motif === 'DETOUR' ? detourMax : null),
      ordre: ordonnerArrets(restaurant, clients, { mode: 'trajet', lointainId: lointain.id }),
      verdicts,
      refus: null,
    };
  }

  // Mode « même zone » : toutes les paires (celles avec le plus lointain sont déjà connues).
  const avecLointain = new Map(autres.map((c, i) => [c.id, versL[i]]));
  const paire = (x: ClientDirection, y: ClientDirection): VerdictPaire => {
    if (x === lointain) return avecLointain.get(y.id)!;
    if (y === lointain) return avecLointain.get(x.id)!;
    const v = verdictDe(x, y);
    verdicts.push(v);
    return v;
  };
  let refusZone: VerdictPaire | null = null;
  toutesLesPaires: for (let i = 0; i < clients.length; i++) {
    for (let j = i + 1; j < clients.length; j++) {
      const v = paire(clients[i], clients[j]);
      if (!(v.compatible && v.memeZone)) {
        refusZone = v;
        break toutesLesPaires;
      }
    }
  }
  if (!refusZone) {
    const toutesMemeAdresse = verdicts.every((v) => v.motif === 'MEME_ADRESSE');
    const motif: MotifDirection = toutesMemeAdresse ? 'MEME_ADRESSE' : 'MEME_ZONE';
    return {
      valide: true,
      mode: 'zone',
      lointainId: lointain.id,
      classement,
      motif,
      libelle: libelleDirection(motif),
      ordre: ordonnerArrets(restaurant, clients, { mode: 'zone', lointainId: lointain.id }),
      verdicts,
      refus: null,
    };
  }

  // Refus : la première paire « vers le lointain » qui coince, sinon celle de la zone.
  const refus = versL.find((v) => !(v.compatible && v.versLointain)) ?? refusZone;
  return { ...vide, lointainId: lointain.id, classement, verdicts, refus, motif: refus.motif, libelle: refus.libelle };
}

function motifLeMoinsFavorable(verdicts: readonly VerdictPaire[]): MotifDirection {
  let rang = 0;
  for (const v of verdicts) rang = Math.max(rang, RANG_MOTIF.indexOf(v.motif));
  return RANG_MOTIF[rang];
}

/**
 * Validité d'un groupe en calculant ses paires (`compatibilitePaire`, détour
 * mesuré au besoin). Les paires sont calculées une seule fois chacune.
 */
export async function compatibiliteGroupe(
  restaurant: ILatLng | null,
  clients: readonly ClientDirection[],
  reglages: ReglagesDirection = REGLAGES_DIRECTION_DEFAUT,
  mesurerDetour?: MesurerDetour,
): Promise<VerdictGroupe> {
  const memo = new Map<string, VerdictPaire>();
  const cle = (a: ClientDirection, b: ClientDirection) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  const evaluer = () =>
    evaluerGroupe(restaurant, clients, (a, b) => {
      const connu = memo.get(cle(a, b));
      return connu ?? (evaluerPaire(restaurant, a, b, reglages, null) as VerdictPaire);
    });

  if (!restaurant || clients.length < 2 || clients.some((c) => !c.position)) return evaluer();

  // Les paires avec le plus lointain d'abord : le plus souvent elles suffisent,
  // et les autres paires (mode « même zone ») ne coûtent alors aucun détour.
  const { lointain } = choisirLointain(restaurant, clients)!;
  for (const c of clients) {
    if (c !== lointain) memo.set(cle(c, lointain), await compatibilitePaire(restaurant, c, lointain, reglages, mesurerDetour));
  }
  const parLeTrajet = clients.every((c) => c === lointain || memo.get(cle(c, lointain))!.versLointain);
  if (!parLeTrajet) {
    for (let i = 0; i < clients.length; i++) {
      for (let j = i + 1; j < clients.length; j++) {
        const [a, b] = [clients[i], clients[j]];
        if (!memo.has(cle(a, b))) memo.set(cle(a, b), await compatibilitePaire(restaurant, a, b, reglages, mesurerDetour));
      }
    }
  }
  return evaluer();
}

/**
 * Ordre des arrêts d'une course.
 *
 * - `trajet` : par position le long du tracé du plus lointain (la droite
 *   R → L sans tracé), le plus lointain en général dernier ;
 * - `zone` : plus proche voisin en partant du restaurant (et non plus de la
 *   commande la plus ancienne) ;
 * - `fixes` : livraisons déjà en route, arrivées ou terminées, qui gardent
 *   leur rang en tête dans l'ordre donné ; en zone, le voisinage repart du
 *   dernier client fixe.
 *
 * Un client sans coordonnées va en fin de liste.
 */
export function ordonnerArrets(
  restaurant: ILatLng,
  clients: readonly ClientDirection[],
  options: { mode: ModeGroupe; lointainId?: string | null; fixes?: readonly string[] },
): string[] {
  const fixes = (options.fixes ?? []).filter((id) => clients.some((c) => c.id === id));
  const aOrdonner = clients.filter((c) => !fixes.includes(c.id));
  const sansPosition = aOrdonner.filter((c) => !c.position).map((c) => c.id);
  const places = aOrdonner.filter((c) => c.position);

  let ordre: string[];
  if (places.length <= 1 || options.mode === 'seul') {
    ordre = places.map((c) => c.id);
  } else if (options.mode === 'trajet') {
    const lointain =
      clients.find((c) => c.id === options.lointainId && c.position) ?? choisirLointain(restaurant, places)!.lointain;
    const { trace } = referenceVers(restaurant, lointain);
    // Le plus lointain est au bout du tracé ; un client au-delà de lui passe après.
    const longueur = projeterSurTrace(lointain.position!, trace)?.longueurMetres ?? 0;
    const position = new Map(
      places.map((c) => [c.id, c === lointain ? longueur : projeterSurTrace(c.position!, trace)?.positionMetres ?? 0]),
    );
    ordre = [...places]
      .sort((x, y) => position.get(x.id)! - position.get(y.id)! || (x === lointain ? 1 : y === lointain ? -1 : 0))
      .map((c) => c.id);
  } else {
    const dernierFixe = [...fixes].reverse().map((id) => clients.find((c) => c.id === id)).find((c) => c?.position);
    let courant: ILatLng = dernierFixe?.position ?? restaurant;
    const restants = [...places];
    ordre = [];
    while (restants.length) {
      let meilleur = 0;
      for (let i = 1; i < restants.length; i++) {
        if (haversineMeters(courant, restants[i].position!) < haversineMeters(courant, restants[meilleur].position!)) meilleur = i;
      }
      const [suivant] = restants.splice(meilleur, 1);
      ordre.push(suivant.id);
      courant = suivant.position!;
    }
  }
  return [...fixes, ...ordre, ...sansPosition];
}

// ─── Durées des trajets, sans appel Google (conception 2.4) ──────────────────

export interface EstimationTrajets {
  /**
   * `route` : approche par le tracé routier (ou la distance routière) de
   * Google ; `vol_oiseau` : vol d'oiseau redressé de 1,4. Pour comparer deux
   * estimations entre elles, elles doivent avoir la même base.
   */
  base: ClassementDistance;
  /** Mètres depuis le restaurant jusqu'à chaque arrêt, cumulés, dans l'ordre donné. */
  metresCumules: number[];
  /** Secondes de conduite cumulées (sans les arrêts chez les clients). */
  secondesCumulees: number[];
  metresTotal: number;
  secondesTotal: number;
}

/**
 * Durées de conduite d'une tournée déjà ordonnée, sans appel Google.
 *
 * - `trajet` : différence des positions le long du tracé du plus lointain,
 *   plus l'écart de chaque client au tracé (aller et retour) ; sans tracé,
 *   le long de la droite R → L redressée de 1,4 ;
 * - `zone` : approche du premier arrêt par le tracé du plus lointain s'il est
 *   connu, puis vol d'oiseau × 1,4 entre clients ;
 * - `seul` : tracé, sinon distance routière, sinon vol d'oiseau × 1,4.
 *
 * Divisé par la vitesse moyenne réglée (km/h). Les arrêts chez les clients
 * (3 min par arrêt précédent) sont ajoutés par le planificateur.
 */
export function estimerTrajets(
  restaurant: ILatLng,
  arretsOrdonnes: readonly ClientDirection[],
  options: { mode: ModeGroupe; lointain?: ClientDirection | null; vitesseKmh: number },
): EstimationTrajets {
  const metresParSeconde = (options.vitesseKmh > 0 ? options.vitesseKmh : 22) / 3.6;
  const places = arretsOrdonnes.filter((c) => c.position);
  const cumules: number[] = [];
  let base: ClassementDistance = 'vol_oiseau';

  const fin = (): EstimationTrajets => {
    const total = cumules.length ? cumules[cumules.length - 1] : 0;
    return {
      base,
      metresCumules: cumules,
      secondesCumulees: cumules.map((m) => m / metresParSeconde),
      metresTotal: total,
      secondesTotal: total / metresParSeconde,
    };
  };
  if (places.length === 0) return fin();

  const lointain =
    (options.lointain?.position ? options.lointain : null) ?? choisirLointain(restaurant, places)!.lointain;
  const reference = referenceVers(restaurant, lointain);
  const facteur = reference.base === 'trace' ? 1 : FACTEUR_ROUTE_VOL_OISEAU;

  if (options.mode === 'seul' || places.length === 1) {
    const c = places[0];
    const trace = traceUtilisable(c);
    if (trace) {
      base = 'route';
      const p = projeterSurTrace(c.position!, trace)!;
      cumules.push(Math.max(0, p.positionMetres) + p.distanceMetres);
    } else if (routeConnue(c)) {
      base = 'route';
      cumules.push(c.routeMetres as number);
    } else {
      cumules.push(haversineMeters(restaurant, c.position!) * FACTEUR_ROUTE_VOL_OISEAU);
    }
    return fin();
  }

  if (options.mode === 'trajet') {
    base = reference.base === 'trace' ? 'route' : 'vol_oiseau';
    let positionPrec = 0;
    let ecartPrec = 0;
    let total = 0;
    for (const c of places) {
      const p = projeterSurTrace(c.position!, reference.trace)!;
      const ecart = c === lointain ? 0 : p.distanceMetres;
      const position = c === lointain ? p.longueurMetres : p.positionMetres;
      total += (Math.abs(position - positionPrec) + ecartPrec + ecart) * facteur;
      cumules.push(total);
      positionPrec = position;
      ecartPrec = ecart;
    }
    return fin();
  }

  // Zone : approche du premier arrêt, puis vol d'oiseau redressé.
  const premier = places[0];
  let total: number;
  if (reference.base === 'trace') {
    base = 'route';
    const p = projeterSurTrace(premier.position!, reference.trace)!;
    total = Math.max(0, p.positionMetres) + p.distanceMetres;
  } else {
    total = haversineMeters(restaurant, premier.position!) * FACTEUR_ROUTE_VOL_OISEAU;
  }
  cumules.push(total);
  for (let i = 1; i < places.length; i++) {
    total += haversineMeters(places[i - 1].position!, places[i].position!) * FACTEUR_ROUTE_VOL_OISEAU;
    cumules.push(total);
  }
  return fin();
}
