/**
 * ACHEMINEMENT D'UNE COMMANDE : quel restaurant la prépare.
 *
 * ⚠️ Règle PURE, sans base ni Google : elle reçoit les candidats et une
 * fonction de distance routière, et rend son choix. C'est elle qu'on teste.
 *
 * Le choix se faisait au plus proche À VOL D'OISEAU. À Abidjan c'est faux dès
 * qu'il y a la lagune : pour une adresse de Cocody en bord d'eau, Marcory
 * Zone 4 gagne à 4,5 km alors que Sococé est à 5,5 km — mais l'oiseau ne paie
 * pas le péage du pont HKB, le livreur si. Mesuré sur les vraies coordonnées
 * des restaurants : trois adresses de Riviera et Blockhauss partaient à
 * Marcory.
 *
 * On départage donc PAR LA ROUTE, parmi les candidats déjà filtrés (ouverts,
 * plats disponibles). Pour contenir le coût Google, seuls les plus proches à
 * vol d'oiseau sont interrogés : un restaurant à quinze kilomètres ne gagnera
 * jamais au kilomètre routier.
 *
 * ⚠️ Google peut manquer (clé absente, délai, panne) : la fonction de distance
 * rend alors `null`. On ne mélange JAMAIS des mètres routiers et des
 * kilomètres à vol d'oiseau dans une même comparaison : à la moindre valeur
 * manquante, tout le choix retombe sur le vol d'oiseau. Une commande ne doit
 * jamais être bloquée par une API tierce.
 */

export interface Candidat {
  id: string;
  latitude: number | null;
  longitude: number | null;
}

export interface Point {
  latitude: number;
  longitude: number;
}

/** Combien de restaurants, parmi les plus proches à vol d'oiseau, on interroge par la route. */
export const CANDIDATS_INTERROGES = 3;

export type MethodeChoix = 'route' | 'vol_oiseau' | 'seul';

export interface Choix<C extends Candidat> {
  restaurant: C;
  methode: MethodeChoix;
  /** Vrai quand la route a renversé le classement à vol d'oiseau : c'est le cas de la lagune. */
  renverse: boolean;
}

export function volOiseauKm(a: Point, b: Point): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Choisit le restaurant parmi des candidats déjà filtrés.
 *
 * `distanceRoutiere` : mètres par la route entre un candidat et l'adresse,
 * ou `null` si Google n'a pas répondu. Appelée au plus CANDIDATS_INTERROGES
 * fois, jamais pour un candidat unique.
 */
export async function choisirRestaurant<C extends Candidat>(
  candidats: C[],
  adresse: Point,
  distanceRoutiere: (restaurant: C) => Promise<number | null>,
): Promise<Choix<C> | null> {
  const places = candidats.filter((c) => c.latitude != null && c.longitude != null);
  if (places.length === 0) return null;
  if (places.length === 1) return { restaurant: places[0], methode: 'seul', renverse: false };

  const parOiseau = places
    .map((c) => ({ c, km: volOiseauKm(adresse, { latitude: c.latitude!, longitude: c.longitude! }) }))
    .sort((a, b) => a.km - b.km);
  const plusProcheOiseau = parOiseau[0].c;

  const interroges = parOiseau.slice(0, CANDIDATS_INTERROGES);
  const routes = await Promise.all(interroges.map(({ c }) => distanceRoutiere(c)));

  // Une seule valeur manquante et on ne compare plus rien : repli entier.
  if (routes.some((m) => m == null || !Number.isFinite(m) || m <= 0)) {
    return { restaurant: plusProcheOiseau, methode: 'vol_oiseau', renverse: false };
  }

  let meilleur = 0;
  for (let i = 1; i < routes.length; i++) {
    if ((routes[i] as number) < (routes[meilleur] as number)) meilleur = i;
  }
  const choisi = interroges[meilleur].c;
  return { restaurant: choisi, methode: 'route', renverse: choisi.id !== plusProcheOiseau.id };
}
