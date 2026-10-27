/**
 * ORDRE DES ARRÊTS D'UNE TOURNÉE PAR LA ROUTE, règle pure (demande du client
 * du 27/10 : « bien ordonner les courses du livreur pour éviter qu'il se
 * déplace bêtement »).
 *
 * À Abidjan, le vol d'oiseau trompe : la lagune, les ponts et le péage du
 * pont HKB font qu'un client « tout près » est parfois à l'autre bout par la
 * route. Ici, l'ordre se décide sur les distances PAR LA ROUTE entre tous
 * les points de la tournée (matrice), lues dans le cache routier de 30 jours
 * (`road-route`, le même que les frais de livraison). Aucun appel Google
 * n'est fait ici, ni attendu par le planificateur.
 *
 * Objectif, clé lexicographique à la seconde près (plus petite = meilleure) :
 *  1. somme des retards au-delà de la limite (promesse + retard toléré) ;
 *  2. somme des retards au-delà de la promesse ;
 *  3. durée de la boucle restaurant → arrêts → retour au restaurant (le
 *     chaînage est suspendu : le livreur revient prendre la course suivante) ;
 *  4. somme des heures d'arrivée chez les clients (à boucle égale, une boucle
 *     et son inverse ont la même longueur : le client le plus proche est
 *     servi d'abord) ;
 *  5. à égalité, l'ordre de la direction d'aujourd'hui (stabilité).
 *
 * Chaque arrivée : départ + mètres cumulés / vitesse réglée de l'heure + 3 min
 * par client précédent (la formule de `estimer`). Toutes les permutations
 * jusqu'à 5 arrêts placés (120 ordres au plus) ; au-delà, ou s'il manque une
 * seule distance, rien n'est décidé ici et le planificateur garde son calcul
 * d'aujourd'hui (jamais de mélange entre route et vol d'oiseau).
 */
import { ILatLng } from './geo.helper';

/** Toutes les permutations jusqu'à ce nombre d'arrêts placés (120 ordres au plus). */
export const ARRETS_MAX_PERMUTATIONS = 5;
/** Un nouvel ordre doit gagner plus de 60 s sur un critère (tolérance sur chacun, dans l'ordre). */
export const SEUIL_NOUVEL_ORDRE_S = 60;
/** Appels Google pour les distances entre clients : au plus 6 par passage et par restaurant. */
export const APPELS_ORDRE_PAR_PASSAGE = 6;

/** Clé d'une paire de clients, dans un sens comme dans l'autre (même forme que `clePaire`). */
export function clePaireArrets(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Distances par la route entre deux clients, en mètres, clé `clePaireArrets`.
 * La route est supposée symétrique : un seul appel par paire.
 */
export type DistancesEntreClients = ReadonlyMap<string, number>;

/** Un client tel que la règle le lit (identifiant de la commande). */
export interface ClientOrdre {
  id: string;
  position: ILatLng | null;
  /** Restaurant → client par la route (cache des frais), `null` si inconnue. */
  routeMetres?: number | null;
}

/** Toutes les distances d'une tournée : restaurant → client (et retour), client → client. */
export interface MatriceArrets {
  depuisRestaurant: ReadonlyMap<string, number>;
  entreClients: DistancesEntreClients;
}

const distanceValide = (m: number | null | undefined): m is number => typeof m === 'number' && Number.isFinite(m) && m >= 0;

/**
 * Matrice des clients placés (avec coordonnées), ou `null` s'il manque une
 * seule distance : restaurant → client (`routeMetres`, strictement positive)
 * ou client → client (dans un sens ou dans l'autre, 0 pour un même point).
 * Le retour client → restaurant vaut l'aller.
 */
export function matriceComplete(
  arrets: readonly ClientOrdre[],
  distances: DistancesEntreClients | null | undefined,
): MatriceArrets | null {
  if (!distances) return null;
  const places = arrets.filter((a) => a.position);
  const depuisRestaurant = new Map<string, number>();
  for (const a of places) {
    if (!distanceValide(a.routeMetres) || a.routeMetres <= 0) return null;
    depuisRestaurant.set(a.id, a.routeMetres);
  }
  const entreClients = new Map<string, number>();
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      const cle = clePaireArrets(places[i].id, places[j].id);
      const m = distances.get(cle);
      if (!distanceValide(m)) return null;
      entreClients.set(cle, m);
    }
  }
  return { depuisRestaurant, entreClients };
}

/** Un arrêt vu par la règle d'ordre. */
export interface ArretOrdre {
  id: string;
  /** Coordonnées connues ; sinon en fin de liste, arrivée supposée. */
  place: boolean;
  promesseMs: number;
  /** Promesse + retard toléré. */
  limiteMs: number;
}

export interface ParametresOrdre {
  arrets: readonly ArretOrdre[];
  matrice: MatriceArrets;
  departMs: number;
  /** Vitesse réglée de l'heure du départ (pointe ou non). */
  vitesseKmh: number;
  /** Temps passé chez chaque client précédent (3 min). */
  arretClientS: number;
  /** Arrivée supposée d'un client sans coordonnées (comme `estimer`). */
  arriveeSansPositionMs: number;
}

export interface TourneeRoute {
  /** Clients placés dans l'ordre, puis les clients sans coordonnées. */
  ordre: string[];
  arriveesMs: Map<string, number>;
  /** Restaurant → dernier client placé, arrêts compris (secondes). */
  dureeS: number;
  /** Boucle complète, retour au restaurant compris (secondes). */
  boucleS: number;
  cle: number[];
}

/**
 * Clé d'un ordre, à la seconde près : retard au-delà des limites, au-delà des
 * promesses, boucle, somme des arrivées (depuis le départ).
 */
export function cleOrdre(
  arrets: readonly ArretOrdre[],
  arriveesMs: ReadonlyMap<string, number>,
  departMs: number,
  boucleS: number,
): number[] {
  let limite = 0;
  let promesse = 0;
  let somme = 0;
  for (const a of arrets) {
    const arrivee = arriveesMs.get(a.id) ?? departMs;
    limite += Math.max(0, arrivee - a.limiteMs);
    promesse += Math.max(0, arrivee - a.promesseMs);
    somme += arrivee - departMs;
  }
  return [Math.round(limite / 1000), Math.round(promesse / 1000), Math.round(boucleS), Math.round(somme / 1000)];
}

/** Tournée dans l'ordre donné, sur les distances par la route de la matrice. */
export function tourneeParLaRoute(p: ParametresOrdre, ordre: readonly string[]): TourneeRoute {
  const mps = (p.vitesseKmh > 0 ? p.vitesseKmh : 22) / 3.6;
  const parId = new Map(p.arrets.map((a) => [a.id, a]));
  const vus = new Set<string>();
  const suite: ArretOrdre[] = [];
  for (const id of [...ordre, ...p.arrets.map((a) => a.id)]) {
    const a = parId.get(id);
    if (!a || vus.has(id)) continue;
    vus.add(id);
    suite.push(a);
  }
  const places = suite.filter((a) => a.place);
  const sansPosition = suite.filter((a) => !a.place);

  const arriveesMs = new Map<string, number>();
  let metres = 0;
  let precedent: string | null = null;
  places.forEach((a, i) => {
    metres +=
      precedent === null
        ? p.matrice.depuisRestaurant.get(a.id) ?? 0
        : p.matrice.entreClients.get(clePaireArrets(precedent, a.id)) ?? 0;
    arriveesMs.set(a.id, p.departMs + Math.round((metres / mps + i * p.arretClientS) * 1000));
    precedent = a.id;
  });
  for (const a of sansPosition) arriveesMs.set(a.id, p.arriveeSansPositionMs);

  const n = places.length;
  const dureeS = n ? metres / mps + (n - 1) * p.arretClientS : 0;
  const retour = precedent === null ? 0 : p.matrice.depuisRestaurant.get(precedent) ?? 0;
  const boucleS = n ? (metres + retour) / mps + n * p.arretClientS : 0;
  return {
    ordre: [...places, ...sansPosition].map((a) => a.id),
    arriveesMs,
    dureeS,
    boucleS,
    cle: cleOrdre(p.arrets, arriveesMs, p.departMs, boucleS),
  };
}

/** Ordre lexicographique de deux clés. */
function comparer(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function permutations<T>(liste: readonly T[]): T[][] {
  if (liste.length <= 1) return [[...liste]];
  return liste.flatMap((x, i) => permutations([...liste.slice(0, i), ...liste.slice(i + 1)]).map((reste) => [x, ...reste]));
}

/**
 * Meilleur ordre par la route : toutes les permutations des clients placés
 * (2 à 5), la plus petite clé l'emporte ; à égalité, l'ordre de la direction
 * est gardé. Une permutation dont la tournée (sans le retour) dépasse la plus
 * longue de l'ordre de la direction et de la durée de tournée réglée
 * (25 min) est écartée, comme aujourd'hui. `null` hors de 2 à 5 arrêts placés.
 */
export function meilleurOrdre(
  p: ParametresOrdre & { ordreDirection: readonly string[]; dureeTourneeMaxS: number },
): { meilleur: TourneeRoute; direction: TourneeRoute } | null {
  const places = p.arrets.filter((a) => a.place).map((a) => a.id);
  if (places.length < 2 || places.length > ARRETS_MAX_PERMUTATIONS) return null;
  const direction = tourneeParLaRoute(p, p.ordreDirection);
  const dureeMaxS = Math.max(direction.dureeS, p.dureeTourneeMaxS);
  let meilleur = direction;
  for (const ordre of permutations(places)) {
    const essai = tourneeParLaRoute(p, ordre);
    if (essai.dureeS > dureeMaxS + 1e-6) continue;
    if (comparer(essai.cle, meilleur.cle) < 0) meilleur = essai;
  }
  return { meilleur, direction };
}

/**
 * Gain (secondes) du nouvel ordre sur le premier critère qui les sépare de
 * plus de la tolérance ; 0 si aucun, négatif s'il est pire.
 */
export function gainNouvelOrdreS(
  cleActuelle: readonly number[],
  cleNouvelle: readonly number[],
  seuilS = SEUIL_NOUVEL_ORDRE_S,
): number {
  for (let i = 0; i < Math.max(cleActuelle.length, cleNouvelle.length); i++) {
    const gain = (cleActuelle[i] ?? 0) - (cleNouvelle[i] ?? 0);
    if (Math.abs(gain) > seuilS) return gain;
  }
  return 0;
}

/**
 * Le nouvel ordre vaut-il un changement ? Tolérance de 60 s sur chaque
 * critère, dans l'ordre : le premier écart au-delà décide. Sans cela l'ordre
 * basculerait d'un passage à l'autre (10 s) pour quelques secondes.
 */
export function nouvelOrdreUtile(
  cleActuelle: readonly number[],
  cleNouvelle: readonly number[],
  seuilS = SEUIL_NOUVEL_ORDRE_S,
): boolean {
  return gainNouvelOrdreS(cleActuelle, cleNouvelle, seuilS) > 0;
}
