/**
 * TRAJET RÉUTILISÉ : un livreur qui suit sa route ne demande pas un nouveau
 * trajet à Google toutes les 30 secondes.
 *
 * L'appli livreur et l'écran de suivi du client redemandent le trajet à chaque
 * déplacement. Facturé au tarif avec trafic, c'était le premier poste de la
 * facture Google (04/11 : 1 000 à 2 000 appels par jour). Tant que l'origine
 * reste sur un tracé récent vers la même destination, on coupe ce tracé à la
 * position du livreur, et le reste de la distance et de la durée en découle,
 * sans appeler Google.
 *
 * ⚠️ Pur, sans cache ni réseau.
 */
import { projeterSurTrace, sansDoublons } from 'src/modules/course/helpers/polyligne';

import type { IDirectionsResult, ILatLng } from './maps.service';

/** Durée de vie d'un tracé réutilisable : c'est la fraîcheur du trafic affiché. */
export const DUREE_TRAJET_VIF_MS = 5 * 60 * 1000;

/**
 * Écart maximal entre l'origine et le tracé. Le tracé de Google est simplifié
 * et le GPS flotte de quelques dizaines de mètres ; au-delà, le livreur a pris
 * une autre rue et il lui faut un vrai trajet.
 */
export const ECART_MAX_TRACE_M = 150;

/** Tracés gardés par destination : plusieurs livreurs vont au même restaurant. */
export const TRAJETS_VIFS_MAX = 5;

/** Un trajet donné par Google, avec le trafic du moment. */
export interface TrajetVif {
  calculeA: number;
  coordinates: ILatLng[];
  metres: number;
  secondes: number;
}

const estFrais = (trajet: TrajetVif, maintenant: number) => maintenant - trajet.calculeA < DUREE_TRAJET_VIF_MS;

/** Le trajet restant depuis `origine`, ou `null` si elle n'est pas sur le tracé. */
export function couperTrajet(origine: ILatLng, trajet: TrajetVif): IDirectionsResult | null {
  const trace = sansDoublons(trajet.coordinates.map((p) => ({ lat: p.latitude, lng: p.longitude })));
  const projection = projeterSurTrace({ lat: origine.latitude, lng: origine.longitude }, trace);
  if (!projection || projection.longueurMetres <= 0 || projection.distanceMetres > ECART_MAX_TRACE_M) return null;

  const reste = (projection.longueurMetres - projection.positionMetres) / projection.longueurMetres;
  const part = Math.min(1, Math.max(0, reste));
  const metres = Math.round(trajet.metres * part);
  const secondes = Math.round(trajet.secondes * part);
  const suite = trace.slice(projection.segment + 1).map((p) => ({ latitude: p.lat, longitude: p.lng }));
  const coordinates = [origine, ...suite];

  return {
    coordinates,
    totalDistanceMeters: metres,
    totalDurationSeconds: secondes,
    totalDurationWithStopsSeconds: secondes,
    stopsSeconds: 0,
    legs: [
      {
        distanceMeters: metres,
        durationSeconds: secondes,
        startCoord: origine,
        endCoord: coordinates[coordinates.length - 1],
      },
    ],
  };
}

/** Le trajet restant depuis le tracé frais le plus récent qui passe par `origine`. */
export function reprendreTrajet(
  origine: ILatLng,
  trajets: readonly TrajetVif[],
  maintenant: number,
): IDirectionsResult | null {
  for (let i = trajets.length - 1; i >= 0; i--) {
    if (!estFrais(trajets[i], maintenant)) continue;
    const coupe = couperTrajet(origine, trajets[i]);
    if (coupe) return coupe;
  }
  return null;
}

/** Ajoute un tracé : les périmés sortent, les plus anciens au-delà du maximum aussi. */
export function ajouterTrajet(trajets: readonly TrajetVif[], nouveau: TrajetVif): TrajetVif[] {
  return [...trajets.filter((t) => estFrais(t, nouveau.calculeA)), nouveau].slice(-TRAJETS_VIFS_MAX);
}
