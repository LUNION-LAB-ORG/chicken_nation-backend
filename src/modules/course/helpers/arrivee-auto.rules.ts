/**
 * ARRIVÉES DÉDUITES DE LA POSITION, règles pures (demande du 23/10 :
 * l'automatique d'abord, le livreur n'a rien à toucher).
 *
 * L'appli déclare déjà l'arrivée au restaurant (200 m) et chez le client
 * (100 m), mais seulement au premier plan. Le livreur qui roule avec Google
 * Maps devant elle devait encore toucher « Arrivé ». Le serveur reçoit les
 * positions envoyées en arrière-plan et déclare l'arrivée à sa place, avec
 * la même règle que l'appli (`chicken-nation-deli/features/livraison/utils/arrivee-client.ts`) :
 *  - coordonnées valides des deux côtés (jamais 0,0) ;
 *  - position assez précise (80 m au plus quand l'appli donne la précision) ;
 *  - distance au plus égale au rayon.
 */
import { haversineMeters, ILatLng } from './geo.helper';

/** Rayon autour de l'adresse du client (mètres), comme l'appli. */
export const RAYON_ARRIVEE_CLIENT_M = 100;

/** Rayon autour du restaurant (mètres), comme l'appli et `deliverer.au_restaurant_rayon_m`. */
export const RAYON_ARRIVEE_RESTAURANT_M = 200;

/** Une position moins précise que cela ne décide rien seule (mètres). */
export const PRECISION_MAX_M = 80;

/** Coordonnées utilisables : nombres finis, dans les bornes, pas le 0,0 d'une adresse vide. */
export function coordonneesUtilisables(p: Partial<ILatLng> | null | undefined): p is ILatLng {
  if (!p) return false;
  const { lat, lng } = p;
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return !(lat === 0 && lng === 0);
}

/** Position assez précise pour décider seule (précision inconnue : acceptée, comme aujourd'hui). */
export function positionAssezPrecise(precisionM: number | null | undefined): boolean {
  if (precisionM === null || precisionM === undefined) return true;
  if (!Number.isFinite(precisionM)) return false;
  return precisionM <= PRECISION_MAX_M;
}

/**
 * Le livreur est-il arrivé ? `cible` = restaurant ou adresse du client.
 * Faux dès qu'une donnée manque : on ne déclare jamais une arrivée au hasard.
 */
export function estArrive(p: {
  position: Partial<ILatLng> | null | undefined;
  precisionM?: number | null;
  cible: Partial<ILatLng> | null | undefined;
  rayonM: number;
}): boolean {
  if (!coordonneesUtilisables(p.position) || !coordonneesUtilisables(p.cible)) return false;
  if (!positionAssezPrecise(p.precisionM)) return false;
  if (!Number.isFinite(p.rayonM) || p.rayonM <= 0) return false;
  return haversineMeters(p.position, p.cible) <= p.rayonM;
}
