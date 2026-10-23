/**
 * TRACÉ ROUTIER : format de Google et géométrie le long du tracé.
 *
 * ⚠️ Pur, sans base ni réseau. Sert la règle « même direction »
 * (`direction.rules.ts`) : un client est-il sur la route qui mène à un autre,
 * et à quel endroit de cette route ?
 *
 * Le tracé vient de la réponse Directions de Google (`overview_polyline`),
 * déjà payée pour les frais de livraison et gardée 30 jours en cache
 * (`MapsService.itineraireRoutier`). C'est un tracé SIMPLIFIÉ : quelques
 * dizaines à quelques centaines de points, assez fin pour un couloir de
 * plusieurs centaines de mètres.
 *
 * Mesures : sur une ville (moins de 50 km), la Terre peut être tenue pour
 * plate autour du point étudié. On projette donc tout le tracé sur un plan
 * centré sur ce point (équirectangulaire), ce qui donne distance et position
 * dans une MÊME mesure, comparables entre elles. Écart avec le grand cercle :
 * bien moins de 0,1 % à Abidjan.
 */

import { ILatLng } from './geo.helper';

const RAYON_TERRE_M = 6_371_000;
const METRES_PAR_DEGRE = (Math.PI / 180) * RAYON_TERRE_M;

// ─── Format de Google ────────────────────────────────────────────────────────

/**
 * Décode un tracé au format « Encoded Polyline » de Google (précision 5 par
 * défaut, celle de Directions).
 *
 * Une chaîne vide, absente ou abîmée (tronquée, caractère hors alphabet)
 * donne un tracé VIDE : on préfère « pas de tracé » à un tracé partiel, qui
 * ferait croire qu'une route s'arrête au milieu.
 */
export function decoderPolyligne(encodee: string | null | undefined, precision = 5): ILatLng[] {
  if (!encodee) return [];
  const facteur = 10 ** precision;
  const points: ILatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const lireValeur = (): number | null => {
    let resultat = 0;
    let decalage = 0;
    let octet: number;
    do {
      if (index >= encodee.length) return null;
      octet = encodee.charCodeAt(index++) - 63;
      if (octet < 0 || octet > 63) return null;
      resultat |= (octet & 0x1f) << decalage;
      decalage += 5;
      if (decalage > 30) return null;
    } while (octet >= 0x20);
    return resultat & 1 ? ~(resultat >> 1) : resultat >> 1;
  };

  while (index < encodee.length) {
    const dLat = lireValeur();
    const dLng = dLat === null ? null : lireValeur();
    if (dLat === null || dLng === null) return [];
    lat += dLat;
    lng += dLng;
    points.push({ lat: lat / facteur, lng: lng / facteur });
  }
  return points;
}

/**
 * Encode un tracé au format de Google. Sert aux tests et au faux service
 * Google du banc : un tracé synthétique encodé puis décodé doit revenir tel
 * quel, à la précision près.
 */
export function encoderPolyligne(points: readonly ILatLng[], precision = 5): string {
  const facteur = 10 ** precision;
  let sortie = '';
  let latPrec = 0;
  let lngPrec = 0;

  const ecrire = (valeur: number) => {
    let v = valeur < 0 ? ~(valeur << 1) : valeur << 1;
    while (v >= 0x20) {
      sortie += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    sortie += String.fromCharCode(v + 63);
  };

  for (const p of points) {
    const lat = Math.round(p.lat * facteur);
    const lng = Math.round(p.lng * facteur);
    ecrire(lat - latPrec);
    ecrire(lng - lngPrec);
    latPrec = lat;
    lngPrec = lng;
  }
  return sortie;
}

// ─── Géométrie ───────────────────────────────────────────────────────────────

/** Coordonnées planes (mètres) d'un point, sur un plan centré sur `origine`. */
function planCentreSur(origine: ILatLng): (p: ILatLng) => [number, number] {
  const cosLat = Math.cos((origine.lat * Math.PI) / 180);
  return (p) => [
    (p.lng - origine.lng) * METRES_PAR_DEGRE * cosLat,
    (p.lat - origine.lat) * METRES_PAR_DEGRE,
  ];
}

/** Retire les points répétés d'affilée (segments de longueur nulle). */
function sansDoublons(trace: readonly ILatLng[]): ILatLng[] {
  const sortie: ILatLng[] = [];
  for (const p of trace) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue;
    const dernier = sortie[sortie.length - 1];
    if (dernier && dernier.lat === p.lat && dernier.lng === p.lng) continue;
    sortie.push(p);
  }
  return sortie;
}

/** Longueur d'un tracé en mètres (somme des segments). 0 pour moins de deux points. */
export function longueurPolyligne(trace: readonly ILatLng[]): number {
  const points = sansDoublons(trace);
  if (points.length < 2) return 0;
  const plan = planCentreSur(points[0]);
  let longueur = 0;
  let [xp, yp] = plan(points[0]);
  for (let i = 1; i < points.length; i++) {
    const [x, y] = plan(points[i]);
    longueur += Math.hypot(x - xp, y - yp);
    xp = x;
    yp = y;
  }
  return longueur;
}

export interface ProjectionSurTrace {
  /** Distance du point au tracé (au point le plus proche du tracé), en mètres. */
  distanceMetres: number;
  /**
   * Position du point le long du tracé, en mètres depuis son départ.
   *
   * Prolongée aux deux bouts : un point situé AU-DELÀ de l'arrivée, dans le
   * prolongement du dernier segment, a une position supérieure à la longueur
   * (de l'avance prise sur l'arrivée) ; un point situé derrière le départ a
   * une position négative. C'est ce qui permet de dire « avant le client
   * lointain » ou « après lui ».
   */
  positionMetres: number;
  /** Longueur du tracé, dans la même mesure que la position. */
  longueurMetres: number;
  /** Indice du segment le plus proche (0 = premier segment). */
  segment: number;
}

/**
 * Projette un point sur un tracé : distance au tracé et position le long du
 * tracé. `null` pour un tracé vide.
 *
 * Plusieurs segments à égale distance (tracé qui revient sur lui-même) : le
 * premier le long du tracé l'emporte.
 */
export function projeterSurTrace(point: ILatLng, trace: readonly ILatLng[]): ProjectionSurTrace | null {
  const points = sansDoublons(trace);
  if (points.length === 0 || !Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
    return null;
  }

  const plan = planCentreSur(point);
  const xy = points.map(plan);

  if (xy.length === 1) {
    return {
      distanceMetres: Math.hypot(xy[0][0], xy[0][1]),
      positionMetres: 0,
      longueurMetres: 0,
      segment: 0,
    };
  }

  // Longueurs cumulées au début de chaque segment.
  const cumul: number[] = [0];
  for (let i = 1; i < xy.length; i++) {
    cumul.push(cumul[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  }
  const longueur = cumul[cumul.length - 1];
  const dernierSegment = xy.length - 2;

  let meilleur = { distance: Number.POSITIVE_INFINITY, position: 0, segment: 0 };
  for (let i = 0; i <= dernierSegment; i++) {
    const [ax, ay] = xy[i];
    const [bx, by] = xy[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const longueurSegment = Math.hypot(dx, dy);
    // Le point étudié est l'origine du plan : (P - A)·(B - A) = -A·(B - A).
    const t = (-(ax * dx) - ay * dy) / (longueurSegment * longueurSegment);
    const tBorne = Math.min(1, Math.max(0, t));
    const distance = Math.hypot(ax + tBorne * dx, ay + tBorne * dy);
    if (distance < meilleur.distance) {
      // Prolongement aux deux bouts du tracé seulement.
      let tPosition = tBorne;
      if (i === dernierSegment && t > 1) tPosition = t;
      if (i === 0 && t < 0) tPosition = t;
      meilleur = { distance, position: cumul[i] + tPosition * longueurSegment, segment: i };
    }
  }

  return {
    distanceMetres: meilleur.distance,
    positionMetres: meilleur.position,
    longueurMetres: longueur,
    segment: meilleur.segment,
  };
}

/** Distance d'un point au tracé, en mètres ; `null` pour un tracé vide. */
export function distanceAuTrace(point: ILatLng, trace: readonly ILatLng[]): number | null {
  return projeterSurTrace(point, trace)?.distanceMetres ?? null;
}

/** Position d'un point le long du tracé, en mètres depuis le départ ; `null` pour un tracé vide. */
export function positionLeLongDuTrace(point: ILatLng, trace: readonly ILatLng[]): number | null {
  return projeterSurTrace(point, trace)?.positionMetres ?? null;
}
