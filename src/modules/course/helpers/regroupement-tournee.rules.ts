/**
 * REGROUPEMENT PAR TOURNÉE, règle pure (retour du client du 28/10) :
 *
 *   « le système ne les groupe pas car il choisit l'itinéraire le plus
 *   rapide (…) alors que s'il prenait un autre itinéraire il pouvait
 *   grouper d'autres malgré le long trajet »
 *
 * SECOND AVIS du planificateur, jamais un remplacement : la règle
 * d'aujourd'hui (direction, durée de tournée, détour, retard) juge d'abord.
 * Quand elle refuse un groupe, on compare DEUX PLANS, par la route :
 *
 *  - GROUPÉ (G) : toutes les commandes partent ensemble, dans le meilleur
 *    ordre par la route (toutes les permutations, 6 au plus), quel que soit
 *    l'itinéraire, même plus long. Une permutation est écartée si la tournée
 *    (restaurant → dernier client, arrêts compris) dépasse le plafond (50 min)
 *    ou si une commande déjà prévue arrive plus de 8 min plus tard que dans
 *    le plan séparé, attente au comptoir mise à part. Parmi les autres, la
 *    plus petite clé de `cleOrdre` (retards, boucle, somme des arrivées).
 *  - SÉPARÉ (S), avec les livreurs VRAIMENT disponibles : la première partie
 *    part avec son livreur ; la seconde part avec un AUTRE livreur s'il y en
 *    a un (libre, ou de retour avant Turbo), sinon avec le même à son retour
 *    (boucle par la route), s'il revient au plus tard 10 min après qu'elle
 *    est prête (6 min de Turbo + 4 min d'attente d'un retour) ou si Turbo
 *    est coupé, sinon chez Turbo (une course par commande, prête + 6 min +
 *    délai de prise en charge, 15 min par défaut). Quand E a déjà son
 *    livreur, E part d'abord ; sinon le meilleur des deux ordres de service.
 *
 * DÉCISION (une commande est TENUE si elle arrive au plus tard à sa limite,
 * promesse + retard toléré) :
 *  1. aucune permutation dans les bornes : séparé (TOURNEE_MAX, DETOUR_PREMIER) ;
 *  2. une commande tenue dans S et pas dans G n'y perd pas plus de 20 min
 *     (PERTE_MAX) ;
 *  3. moins de commandes tenues dans G : groupé seulement si le retard total
 *     au-delà des limites baisse d'au moins 10 min (RETARD_TOTAL_MOINDRE),
 *     sinon séparé (PROMESSE_CASSEE) ; réglé à 0 : jamais ;
 *  4. autant ou plus : retards comparés critère par critère (au-delà des
 *     limites, puis des promesses), 60 s de tolérance : G meilleur, groupé
 *     (MEILLEUR) ; pire, séparé (PIRE) ; à égalité, groupé si S passe par
 *     Turbo (TURBO_EVITE) ou par un autre livreur qui REVIENT d'une course
 *     (LIVREUR_EPARGNE ; un livreur disponible maintenant n'est épargné de
 *     rien), ou si le livreur revient au moins 5 min plus tôt
 *     (LIVREUR_PLUS_TOT), sinon séparé (EGAL).
 *
 * Arrivées : départ + mètres par la route cumulés / vitesse de l'heure du
 * départ + 3 min par client précédent (la formule de `estimer`). Aucun appel
 * Google ici : les distances viennent du cache routier de 30 jours.
 */
import {
  ArretOrdre,
  DistancesEntreClients,
  MatriceArrets,
  ParametresOrdre,
  SEUIL_NOUVEL_ORDRE_S,
  TourneeRoute,
  tourneeParLaRoute,
} from './ordre-arrets.rules';

/** Au-delà de 3 commandes, la règle d'aujourd'hui seule. */
export const ARRETS_MAX_SECOND_AVIS = 3;
/** À retard égal, le livreur revient au moins ce délai plus tôt avec la tournée groupée (minutes). */
export const GAIN_RETOUR_LIVREUR_MIN = 5;
/** Appels Google pour les distances entre candidats : au plus 6 par passage et par restaurant. */
export const APPELS_REGROUPEMENT_PAR_PASSAGE = 6;
/** Paires de candidats lues dans le cache : au plus 60 par passage. */
export const PAIRES_REGROUPEMENT_LUES_MAX = 60;

/** Une commande vue par le second avis : toutes ont des coordonnées et une distance par la route. */
export interface ArretTournee {
  id: string;
  promesseMs: number;
  /** Promesse + retard toléré. */
  limiteMs: number;
  /** Prête (`ready_at`, ou fin estimée d'une commande attendue par une retenue). */
  preteMs: number;
  /** Restaurant → client par la route, en mètres (strictement positive). */
  routeMetres: number;
}

export interface LimitesRegroupement {
  /** `course.regroupement_tournee_max_min` : plafond de la tournée groupée. */
  tourneeMaxMin: number;
  /** `course.detour_max_ajout_min` : retard maximal d'une commande déjà prévue face au plan séparé. */
  detourMaxMin: number;
  /** `course.regroupement_gain_min` : baisse du retard total exigée pour tenir une promesse de moins (0 = jamais). */
  gainMin: number;
  /** `course.regroupement_perte_max_min` : perte maximale d'une commande tenue qui passe en retard. */
  perteMaxMin: number;
  /** `course.turbo_fallback_enabled`. */
  turboActif: boolean;
  /** `course.turbo_fallback_after_min_v2` : bascule vers Turbo depuis la plus ancienne commande prête. */
  turboApresMin: number;
  /** `course.turbo_attente_retour_max_min` : Turbo attend un livreur qui revient dans ce délai. */
  turboAttenteRetourMin: number;
  /** `course.turbo_prise_en_charge_min` : délai supposé du coursier Turbo (comparaison seulement). */
  turboPriseEnChargeMin: number;
  /** Remise chez chaque client précédent (secondes). */
  arretClientS: number;
}

export interface SituationRegroupement {
  /** E : commandes déjà prévues (la course cible, la graine). */
  existants: readonly ArretTournee[];
  /** N : commandes à ajouter. */
  nouveaux: readonly ArretTournee[];
  /** Distances par la route entre les clients, pour toutes les paires de E + N. */
  entreClients: DistancesEntreClients;
  /**
   * E a déjà son livreur (course affectée, retenue) : dans le plan séparé, E
   * part d'abord. Sinon (création, course sans livreur) : le meilleur des
   * deux ordres de service avec le livreur qui prendrait le groupe.
   */
  eAvecLivreur: boolean;
  /** Départ de E dans le plan séparé quand E a son livreur. */
  departAvantMs: number;
  /** Départ de la tournée groupée (attente au comptoir comprise) ; aussi celui du livreur sans E affecté. */
  departApresMs: number;
  /** Départ d'un AUTRE livreur que celui de E pour N (libre, ou de retour avant Turbo) ; `null` : aucun. */
  autrePourNMs: number | null;
  /**
   * Cet autre livreur REVIENT d'une course (retour estimé). Faux ou absent :
   * il est disponible maintenant (libre, ou sollicité par la course de N) ;
   * à retard égal, le groupe ne l'épargne alors de rien (relecture du 28/10).
   */
  autrePourNRevient?: boolean;
  /** Départ d'un autre livreur pour E quand N passerait d'abord (E sans livreur) ; `null` : aucun. */
  autrePourEMs: number | null;
  /** Cet autre livreur pour E revient d'une course (voir `autrePourNRevient`). */
  autrePourERevient?: boolean;
  /** Vitesse réglée à l'heure d'un départ (pointe ou non), km/h. */
  vitesseKmh: (departMs: number) => number;
}

/** Comment part la seconde partie du plan séparé. */
export type DepartSecond = 'AUTRE_LIVREUR' | 'RETOUR' | 'TURBO';

export interface PlanSepare {
  /** Partie servie d'abord par le livreur du groupe. */
  premier: 'E' | 'N';
  arriveesMs: Map<string, number>;
  /** Départ du restaurant du véhicule qui porte chaque commande. */
  departsMs: Map<string, number>;
  departSecond: DepartSecond;
  /** `AUTRE_LIVREUR` : cet autre livreur revient d'une course (sinon il est disponible maintenant). */
  autreRevient: boolean;
  /** Retour au restaurant du livreur de la première partie (après la seconde s'il la prend aussi). */
  retourLivreurMs: number;
  /** Tournée de E seule, dans son meilleur ordre (secondes, restaurant → dernier client). */
  dureeES: number;
}

export type MotifComparaison =
  | 'MEILLEUR'
  | 'TURBO_EVITE'
  | 'LIVREUR_EPARGNE'
  | 'LIVREUR_PLUS_TOT'
  | 'RETARD_TOTAL_MOINDRE'
  | 'EGAL'
  | 'PIRE'
  | 'PROMESSE_CASSEE'
  | 'PERTE_MAX'
  | 'TOURNEE_MAX'
  | 'DETOUR_PREMIER';

export interface DecisionRegroupement {
  grouper: boolean;
  motif: MotifComparaison;
  /** Tournée groupée retenue, `null` si aucune permutation n'est dans les bornes. */
  groupe: TourneeRoute | null;
  separe: PlanSepare;
  /** Clés [retard au-delà des limites, au-delà des promesses] en secondes, groupé puis séparé. */
  cleG: [number, number] | null;
  cleS: [number, number];
  /** Retour au restaurant du livreur de la tournée groupée. */
  retourGMs: number | null;
  /** Allongement de la tournée de E par le groupe (secondes, ≥ 0). */
  detourS: number;
}

/** Ce que le journal garde d'une comparaison (refus maintenu, PLAN_REFUS). Minutes au dixième. */
export interface ComparaisonRegroupement {
  decision: MotifComparaison;
  /** [retard au-delà des limites, au-delà des promesses] de la tournée groupée, minutes ; `null` : aucune dans les bornes. */
  groupe_min: [number, number] | null;
  separe_min: [number, number];
  /** Partie servie d'abord dans le plan séparé. */
  premier: 'E' | 'N';
  /** Départ de la seconde partie dans le plan séparé. */
  depart_second: DepartSecond;
}

const minutes = (s: number) => Math.round(s / 6) / 10;

export function resumeComparaison(d: DecisionRegroupement): ComparaisonRegroupement {
  return {
    decision: d.motif,
    groupe_min: d.cleG ? [minutes(d.cleG[0]), minutes(d.cleG[1])] : null,
    separe_min: [minutes(d.cleS[0]), minutes(d.cleS[1])],
    premier: d.separe.premier,
    depart_second: d.separe.departSecond,
  };
}

function permutations<T>(liste: readonly T[]): T[][] {
  if (liste.length <= 1) return [[...liste]];
  return liste.flatMap((x, i) => permutations([...liste.slice(0, i), ...liste.slice(i + 1)]).map((reste) => [x, ...reste]));
}

function comparer(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function matrice(arrets: readonly ArretTournee[], entreClients: DistancesEntreClients): MatriceArrets {
  return { depuisRestaurant: new Map(arrets.map((a) => [a.id, a.routeMetres])), entreClients };
}

function parametres(s: SituationRegroupement, lim: LimitesRegroupement, arrets: readonly ArretTournee[], departMs: number): ParametresOrdre {
  const ordre: ArretOrdre[] = arrets.map((a) => ({ id: a.id, place: true, promesseMs: a.promesseMs, limiteMs: a.limiteMs }));
  return {
    arrets: ordre,
    matrice: matrice(arrets, s.entreClients),
    departMs,
    vitesseKmh: s.vitesseKmh(departMs),
    arretClientS: lim.arretClientS,
    arriveeSansPositionMs: departMs,
  };
}

/** Meilleure tournée de ces arrêts partant à `departMs` (plus petite clé de `cleOrdre`, à égalité l'ordre donné). */
export function meilleureTournee(
  s: SituationRegroupement,
  lim: LimitesRegroupement,
  arrets: readonly ArretTournee[],
  departMs: number,
): TourneeRoute {
  const p = parametres(s, lim, arrets, departMs);
  let meilleur: TourneeRoute | null = null;
  for (const ordre of permutations(arrets.map((a) => a.id))) {
    const t = tourneeParLaRoute(p, ordre);
    if (!meilleur || comparer(t.cle, meilleur.cle) < 0) meilleur = t;
  }
  return meilleur!;
}

const plusTard = (arrets: readonly ArretTournee[]) => Math.max(...arrets.map((a) => a.preteMs));
const plusTot = (arrets: readonly ArretTournee[]) => Math.min(...arrets.map((a) => a.preteMs));

/**
 * Plan séparé, la partie `premier` servie d'abord par le livreur du groupe ;
 * la seconde avec un autre livreur, au retour du même, ou chez Turbo.
 */
export function planSepare(s: SituationRegroupement, lim: LimitesRegroupement, premier: 'E' | 'N'): PlanSepare {
  const [P, Q] = premier === 'E' ? [s.existants, s.nouveaux] : [s.nouveaux, s.existants];
  const autre = premier === 'E' ? s.autrePourNMs : s.autrePourEMs;
  const autreRevient = !!(premier === 'E' ? s.autrePourNRevient : s.autrePourERevient);
  const depart =premier === 'E' && s.eAvecLivreur ? s.departAvantMs : s.departApresMs;
  const arriveesMs = new Map<string, number>();
  const departsMs = new Map<string, number>();

  const d1 = Math.max(depart, plusTard(P));
  const t1 = meilleureTournee(s, lim, P, d1);
  for (const a of P) {
    arriveesMs.set(a.id, t1.arriveesMs.get(a.id)!);
    departsMs.set(a.id, d1);
  }
  const retour1 = d1 + Math.round(t1.boucleS * 1000);

  const preteQ = plusTard(Q);
  const bascule = plusTot(Q) + lim.turboApresMin * 60_000;
  const retourAdmis = !lim.turboActif || retour1 <= bascule + lim.turboAttenteRetourMin * 60_000;
  const parAutre = autre === null ? null : Math.max(autre, preteQ);
  const parRetour = retourAdmis ? Math.max(retour1, preteQ) : null;

  let departSecond: DepartSecond;
  let retourLivreurMs = retour1;
  if (parAutre !== null && (parRetour === null || parAutre <= parRetour)) {
    departSecond = 'AUTRE_LIVREUR';
    const t2 = meilleureTournee(s, lim, Q, parAutre);
    for (const a of Q) {
      arriveesMs.set(a.id, t2.arriveesMs.get(a.id)!);
      departsMs.set(a.id, parAutre);
    }
  } else if (parRetour !== null) {
    departSecond = 'RETOUR';
    const t2 = meilleureTournee(s, lim, Q, parRetour);
    for (const a of Q) {
      arriveesMs.set(a.id, t2.arriveesMs.get(a.id)!);
      departsMs.set(a.id, parRetour);
    }
    retourLivreurMs = parRetour + Math.round(t2.boucleS * 1000);
  } else {
    // Turbo dégroupe : une course par commande, coursier au restaurant après la bascule.
    departSecond = 'TURBO';
    const dTurbo = bascule + lim.turboPriseEnChargeMin * 60_000;
    for (const a of Q) {
      const dq = Math.max(dTurbo, a.preteMs);
      arriveesMs.set(a.id, meilleureTournee(s, lim, [a], dq).arriveesMs.get(a.id)!);
      departsMs.set(a.id, dq);
    }
  }
  const dureeES = premier === 'E' ? t1.dureeS : meilleureTournee(s, lim, s.existants, d1).dureeS;
  return { premier, arriveesMs, departsMs, departSecond, autreRevient: departSecond === 'AUTRE_LIVREUR' && autreRevient, retourLivreurMs, dureeES };
}

/** Clé d'un plan : [retard au-delà des limites, au-delà des promesses], secondes. */
function cleDe(arrets: readonly ArretTournee[], arriveesMs: ReadonlyMap<string, number>): [number, number] {
  let limite = 0;
  let promesse = 0;
  for (const a of arrets) {
    const arrivee = arriveesMs.get(a.id)!;
    limite += Math.max(0, arrivee - a.limiteMs);
    promesse += Math.max(0, arrivee - a.promesseMs);
  }
  return [Math.round(limite / 1000), Math.round(promesse / 1000)];
}

const tenues = (arrets: readonly ArretTournee[], arriveesMs: ReadonlyMap<string, number>) =>
  arrets.filter((a) => arriveesMs.get(a.id)! <= a.limiteMs).length;

/** Le plan séparé de référence : E d'abord s'il a son livreur, sinon le meilleur des deux ordres de service. */
export function separeDeReference(s: SituationRegroupement, lim: LimitesRegroupement): PlanSepare {
  const eDabord = planSepare(s, lim, 'E');
  if (s.eAvecLivreur) return eDabord;
  const nDabord = planSepare(s, lim, 'N');
  const tous = [...s.existants, ...s.nouveaux];
  const c = comparer(cleDe(tous, eDabord.arriveesMs), cleDe(tous, nDabord.arriveesMs));
  if (c !== 0) return c < 0 ? eDabord : nDabord;
  return nDabord.retourLivreurMs < eDabord.retourLivreurMs ? nDabord : eDabord;
}

/**
 * Tournée groupée : meilleure permutation par la route dans les bornes
 * (plafond de la tournée, détour des commandes déjà prévues face au plan
 * séparé, attente au comptoir mise à part).
 */
export function planGroupe(
  s: SituationRegroupement,
  lim: LimitesRegroupement,
  S: PlanSepare,
): { tournee: TourneeRoute | null; depart: number; refus: 'TOURNEE_MAX' | 'DETOUR_PREMIER' | null } {
  const tous = [...s.existants, ...s.nouveaux];
  const depart = Math.max(s.departApresMs, plusTard(tous));
  const p = parametres(s, lim, tous, depart);
  let meilleur: TourneeRoute | null = null;
  let dansLePlafond = false;
  for (const ordre of permutations(tous.map((a) => a.id))) {
    const t = tourneeParLaRoute(p, ordre);
    if (t.dureeS > lim.tourneeMaxMin * 60 + 1e-6) continue;
    dansLePlafond = true;
    const retarde = s.existants.some((e) => {
      const attente = Math.max(0, depart - S.departsMs.get(e.id)!);
      return t.arriveesMs.get(e.id)! - S.arriveesMs.get(e.id)! - attente > lim.detourMaxMin * 60_000;
    });
    if (retarde) continue;
    if (!meilleur || comparer(t.cle, meilleur.cle) < 0) meilleur = t;
  }
  return { tournee: meilleur, depart, refus: meilleur ? null : dansLePlafond ? 'DETOUR_PREMIER' : 'TOURNEE_MAX' };
}

/** Le second avis : la tournée groupée est-elle meilleure pour les clients que les livraisons séparées ? */
export function comparerPlans(s: SituationRegroupement, lim: LimitesRegroupement): DecisionRegroupement {
  const tous = [...s.existants, ...s.nouveaux];
  const S = separeDeReference(s, lim);
  const cleS = cleDe(tous, S.arriveesMs);
  const G = planGroupe(s, lim, S);
  const base = { separe: S, cleS };
  if (!G.tournee) {
    return { ...base, grouper: false, motif: G.refus!, groupe: null, cleG: null, retourGMs: null, detourS: 0 };
  }
  const g = G.tournee;
  const cleG = cleDe(tous, g.arriveesMs);
  const retourGMs = G.depart + Math.round(g.boucleS * 1000);
  const res = (grouper: boolean, motif: MotifComparaison): DecisionRegroupement => ({
    ...base,
    grouper,
    motif,
    groupe: g,
    cleG,
    retourGMs,
    detourS: Math.max(0, g.dureeS - S.dureeES),
  });

  // 2. Perte bornée : une commande tenue dans S et pas dans G.
  const perteMaxMs = lim.perteMaxMin * 60_000;
  const perdue = tous.some(
    (a) => S.arriveesMs.get(a.id)! <= a.limiteMs && g.arriveesMs.get(a.id)! > a.limiteMs && g.arriveesMs.get(a.id)! - S.arriveesMs.get(a.id)! > perteMaxMs,
  );
  if (perdue) return res(false, 'PERTE_MAX');

  // 3. Moins de promesses tenues : seulement pour un gain de retard total suffisant.
  if (tenues(tous, g.arriveesMs) < tenues(tous, S.arriveesMs)) {
    const gainS = cleS[0] - cleG[0];
    return lim.gainMin > 0 && gainS >= lim.gainMin * 60 ? res(true, 'RETARD_TOTAL_MOINDRE') : res(false, 'PROMESSE_CASSEE');
  }

  // 4. Autant ou plus : critère par critère, 60 s de tolérance.
  for (let i = 0; i < cleG.length; i++) {
    const gain = cleS[i] - cleG[i];
    if (gain > SEUIL_NOUVEL_ORDRE_S) return res(true, 'MEILLEUR');
    if (gain < -SEUIL_NOUVEL_ORDRE_S) return res(false, 'PIRE');
  }
  if (S.departSecond === 'TURBO') return res(true, 'TURBO_EVITE');
  // Un autre livreur disponible MAINTENANT (libre, ou sollicité par la course
  // de N) : le groupe ne l'épargne de rien, la seconde commande arriverait
  // plus tard pendant qu'il attend au comptoir (relecture du 28/10 : deux
  // livreurs libres, deux directions, une seule course). Seul un livreur qui
  // REVIENT d'une course est épargné.
  if (S.departSecond === 'AUTRE_LIVREUR' && S.autreRevient) return res(true, 'LIVREUR_EPARGNE');
  if (S.retourLivreurMs - retourGMs >= GAIN_RETOUR_LIVREUR_MIN * 60_000) return res(true, 'LIVREUR_PLUS_TOT');
  return res(false, 'EGAL');
}
