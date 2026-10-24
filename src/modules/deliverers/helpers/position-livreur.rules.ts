/**
 * POSITION DU LIVREUR GARDÉE EN BASE (`Deliverer.last_location`, JSON),
 * règle pure : la dernière position reçue, sa précision annoncée, et la
 * dernière position ASSEZ PRÉCISE pour décider (80 m au plus,
 * `positionAssezPrecise`).
 *
 * Une position imprécise (relevé « Balanced » dans le restaurant, précision
 * de 150 m) reste sur la carte et compte comme signe de vie, mais ne décide
 * rien : ni le départ du restaurant, ni la présence au comptoir, ni le sac
 * attendu. L'écouteur des positions l'écartait déjà ; le planificateur, qui
 * relit la position en base au passage suivant, la prenait pour un départ
 * (relecture du 24/10 : course partie au comptoir, commande ajoutée retirée
 * au livreur qui attendait son sac). Un relevé imprécis ne remplace donc pas
 * la dernière position précise : elle est gardée à côté (`sure`), dans la
 * même colonne JSON (aucune migration). Les lecteurs qui ne lisent que
 * `lat` et `lng` ne voient aucun changement.
 */
import { positionAssezPrecise } from 'src/modules/course/helpers/arrivee-auto.rules';
import { ILatLng } from 'src/modules/course/helpers/geo.helper';

/** Contenu de `Deliverer.last_location`. */
export interface PositionEnregistree {
  lat: number;
  lng: number;
  /** Précision annoncée par le GPS (mètres) ; `null` : l'appli ne l'envoie pas. */
  precision_m: number | null;
  /** Relevé imprécis seulement : dernière position assez précise et son heure (ISO). */
  sure?: { lat: number; lng: number; at: string } | null;
}

/** Position qui peut décider (départ, comptoir, sac attendu), avec son heure. */
export interface PositionSure {
  position: ILatLng;
  position_at: Date;
}

export interface PositionLue {
  /** Dernière position reçue (carte, temps de trajet). */
  position: ILatLng | null;
  position_at: Date | null;
  precision_m: number | null;
  /** Dernière position assez précise pour décider ; `null` : aucune connue. */
  sure: PositionSure | null;
}

const nombre = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const date = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

function point(v: unknown): ILatLng | null {
  const p = v as { lat?: unknown; lng?: unknown } | null | undefined;
  const lat = nombre(p?.lat);
  const lng = nombre(p?.lng);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

/** Lit `last_location` et `last_location_at` tels qu'en base (ancienne écriture sans précision comprise). */
export function lirePositionLivreur(lastLocation: unknown, lastLocationAt: Date | string | null | undefined): PositionLue {
  const position = point(lastLocation);
  const position_at = date(lastLocationAt);
  const brut = (lastLocation ?? null) as { precision_m?: unknown; sure?: unknown } | null;
  const precision_m = nombre(brut?.precision_m);
  if (!position) return { position: null, position_at, precision_m, sure: null };

  if (positionAssezPrecise(precision_m)) {
    return { position, position_at, precision_m, sure: position_at ? { position, position_at } : null };
  }
  const gardee = brut?.sure as { at?: unknown } | null | undefined;
  const p = point(gardee);
  const at = date(gardee?.at);
  return { position, position_at, precision_m, sure: p && at ? { position: p, position_at: at } : null };
}

/**
 * Ce qu'il faut écrire dans `last_location` pour un nouveau relevé. Relevé
 * précis (ou sans précision annoncée, comme avant) : lui seul. Relevé
 * imprécis : lui, plus la dernière position précise connue (`precedente`,
 * la ligne avant l'écriture), pour que les règles qui décident la gardent.
 */
export function positionAEnregistrer(
  releve: { lat: number; lng: number; precision_m?: number | null },
  precedente: { last_location: unknown; last_location_at: Date | string | null } | null,
): PositionEnregistree {
  const precision_m = nombre(releve.precision_m);
  const base: PositionEnregistree = { lat: releve.lat, lng: releve.lng, precision_m };
  if (positionAssezPrecise(precision_m)) return base;
  const avant = precedente ? lirePositionLivreur(precedente.last_location, precedente.last_location_at).sure : null;
  return {
    ...base,
    sure: avant ? { lat: avant.position.lat, lng: avant.position.lng, at: avant.position_at.toISOString() } : null,
  };
}

/** Le relevé est-il assez précis pour être enregistré sans relire la ligne ? */
export const releveAssezPrecis = (precisionM: number | null | undefined): boolean => positionAssezPrecise(nombre(precisionM));
