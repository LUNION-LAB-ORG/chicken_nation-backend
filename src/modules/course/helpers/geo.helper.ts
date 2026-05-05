/**
 * Helpers géographiques purs — pas d'état, pas d'IO, safe à appeler partout.
 *
 * Usage principal : calculer rapidement la distance entre 2 coords pour décider
 * si une Order peut rejoindre un batch existant (comparaison vs
 * `course.max_detour_meters`). Le tracé routier précis (via Google Directions)
 * est réservé au calcul final du trajet d'une Course déjà assemblée.
 */

export interface ILatLng {
  lat: number;
  lng: number;
}

/**
 * Distance grand-cercle entre deux points GPS (formule de Haversine).
 * Approximation suffisante pour les distances urbaines (< 50 km) où la Terre
 * peut être considérée sphérique (erreur < 0.5 %).
 *
 * @returns Distance en mètres.
 */
export function haversineMeters(a: ILatLng, b: ILatLng): number {
  const R = 6_371_000; // Rayon moyen de la Terre en mètres
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Parse le champ `Order.address` qui peut arriver sous 2 formes :
 *   - **Objet** JSON (Prisma `@db.Json` typage `JsonValue`) — cas normal
 *   - **String** JSON stringifiée (données legacy avant passage au type Json)
 *
 * Retourne `null` si parsing impossible ou coords absentes/invalides.
 */
export function parseOrderLatLng(raw: unknown): ILatLng | null {
  if (raw === null || raw === undefined) return null;

  // Cas 1 : Prisma renvoie déjà un objet (type Json)
  if (typeof raw === 'object') {
    return normalizeCoords(raw as Record<string, unknown>);
  }

  // Cas 2 : legacy string JSON
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return normalizeCoords(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeCoords(obj: Record<string, unknown>): ILatLng | null {
  const lat = Number(obj.latitude);
  const lng = Number(obj.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null; // filet : coords par défaut suspectes
  return { lat, lng };
}

/**
 * Optimisation simple du trajet par **nearest-neighbor** depuis un point de départ.
 * Heuristique TSP approximative — suffisante pour 2-4 stops (cas typique d'une
 * Course regroupée). Pour plus de stops, on gagnerait à intégrer l'API Google
 * Directions avec `optimize:true` dans les waypoints.
 *
 * @param start Point de départ (restaurant).
 * @param stops Points à visiter avec leur id.
 * @returns Les ids dans l'ordre optimisé (le plus proche en 1er depuis start,
 *   puis le plus proche du précédent, etc.).
 */
export function nearestNeighborOrder<T extends { id: string; coords: ILatLng }>(
  start: ILatLng,
  stops: readonly T[],
): string[] {
  if (stops.length <= 1) return stops.map((s) => s.id);

  const remaining = [...stops];
  const route: T[] = [];
  let current = start;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMeters(current, remaining[i].coords);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    route.push(next);
    current = next.coords;
  }

  return route.map((r) => r.id);
}
