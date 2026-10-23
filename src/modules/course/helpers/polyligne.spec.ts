/**
 * Tracé routier : décodage du format de Google, distance d'un point au tracé
 * et position le long du tracé.
 */
import { haversineMeters } from './geo.helper';
import {
  decoderPolyligne,
  distanceAuTrace,
  encoderPolyligne,
  longueurPolyligne,
  positionLeLongDuTrace,
  projeterSurTrace,
} from './polyligne';

/** Décale un point de `nord` et `est` mètres (assez juste en ville). */
function decale(p: { lat: number; lng: number }, nord: number, est: number) {
  const parDegre = (Math.PI / 180) * 6_371_000;
  return {
    lat: p.lat + nord / parDegre,
    lng: p.lng + est / (parDegre * Math.cos((p.lat * Math.PI) / 180)),
  };
}

const ZONE_4 = { lat: 5.286, lng: -3.9737 };

describe('decoderPolyligne', () => {
  it('décode le tracé d’exemple de la documentation de Google', () => {
    const points = decoderPolyligne('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0].lat).toBeCloseTo(38.5, 5);
    expect(points[0].lng).toBeCloseTo(-120.2, 5);
    expect(points[1].lat).toBeCloseTo(40.7, 5);
    expect(points[1].lng).toBeCloseTo(-120.95, 5);
    expect(points[2].lat).toBeCloseTo(43.252, 5);
    expect(points[2].lng).toBeCloseTo(-126.453, 5);
  });

  it('rend le tracé encodé, aller et retour, à 1e-5 près (Abidjan, coordonnées négatives)', () => {
    const trace = [ZONE_4, { lat: 5.3117011, lng: -3.9797001 }, { lat: 5.3273915, lng: -3.980939 }];
    const retour = decoderPolyligne(encoderPolyligne(trace));
    expect(retour).toHaveLength(3);
    retour.forEach((p, i) => {
      expect(Math.abs(p.lat - trace[i].lat)).toBeLessThanOrEqual(0.5e-5);
      expect(Math.abs(p.lng - trace[i].lng)).toBeLessThanOrEqual(0.5e-5);
    });
  });

  it('chaîne vide, absente ou abîmée : aucun tracé plutôt qu’un tracé partiel', () => {
    expect(decoderPolyligne('')).toEqual([]);
    expect(decoderPolyligne(null)).toEqual([]);
    expect(decoderPolyligne(undefined)).toEqual([]);
    // Tronquée au milieu d'une valeur.
    expect(decoderPolyligne('_p~iF~ps|U_ulLnnqC_mqNvxq')).toEqual([]);
    // Caractère hors de l'alphabet (code < 63).
    expect(decoderPolyligne('_p~iF ~ps|U')).toEqual([]);
  });
});

describe('longueurPolyligne', () => {
  it('somme des segments, proche du grand cercle', () => {
    const b = decale(ZONE_4, 1000, 0);
    const c = decale(b, 0, 1000);
    expect(longueurPolyligne([ZONE_4, b, c])).toBeCloseTo(2000, -1);
    expect(longueurPolyligne([ZONE_4, b])).toBeCloseTo(haversineMeters(ZONE_4, b), 0);
  });

  it('0 pour un seul point ou des points répétés', () => {
    expect(longueurPolyligne([ZONE_4])).toBe(0);
    expect(longueurPolyligne([ZONE_4, ZONE_4])).toBe(0);
    expect(longueurPolyligne([])).toBe(0);
  });
});

describe('projeterSurTrace', () => {
  // Tracé en L : 2 km vers le nord, puis 2 km vers l'est.
  const coude = decale(ZONE_4, 2000, 0);
  const arrivee = decale(coude, 0, 2000);
  const trace = [ZONE_4, coude, arrivee];

  it('point à côté du premier segment : distance latérale et position', () => {
    const p = decale(ZONE_4, 800, 300);
    const proj = projeterSurTrace(p, trace)!;
    expect(proj.distanceMetres).toBeCloseTo(300, -1);
    expect(proj.positionMetres).toBeCloseTo(800, -1);
    expect(proj.longueurMetres).toBeCloseTo(4000, -1);
    expect(proj.segment).toBe(0);
  });

  it('point à côté du second segment : position comptée depuis le départ', () => {
    const p = decale(coude, -250, 1500);
    const proj = projeterSurTrace(p, trace)!;
    expect(proj.distanceMetres).toBeCloseTo(250, -1);
    expect(proj.positionMetres).toBeCloseTo(3500, -1);
    expect(proj.segment).toBe(1);
  });

  it('point sur le tracé : distance nulle', () => {
    expect(distanceAuTrace(decale(ZONE_4, 1000, 0), trace)!).toBeLessThan(1);
    expect(positionLeLongDuTrace(decale(ZONE_4, 1000, 0), trace)!).toBeCloseTo(1000, -1);
  });

  it('au-delà de l’arrivée, la position dépasse la longueur (prolongement du dernier segment)', () => {
    const p = decale(arrivee, 0, 500);
    const proj = projeterSurTrace(p, trace)!;
    expect(proj.distanceMetres).toBeCloseTo(500, -1);
    expect(proj.positionMetres).toBeCloseTo(4500, -1);
  });

  it('derrière le départ, la position est négative', () => {
    const p = decale(ZONE_4, -400, 0);
    const proj = projeterSurTrace(p, trace)!;
    expect(proj.distanceMetres).toBeCloseTo(400, -1);
    expect(proj.positionMetres).toBeCloseTo(-400, -1);
  });

  it('dans le coude, hors prolongement : la position reste dans le tracé', () => {
    const p = decale(coude, 300, -300);
    const proj = projeterSurTrace(p, trace)!;
    expect(proj.positionMetres).toBeCloseTo(2000, -1);
    expect(proj.distanceMetres).toBeCloseTo(Math.hypot(300, 300), -1);
  });

  it('tracé d’un seul point : distance au point, position nulle', () => {
    const p = decale(ZONE_4, 300, 400);
    const proj = projeterSurTrace(p, [ZONE_4])!;
    expect(proj.distanceMetres).toBeCloseTo(500, -1);
    expect(proj.positionMetres).toBe(0);
    expect(proj.longueurMetres).toBe(0);
  });

  it('tracé vide : rien', () => {
    expect(projeterSurTrace(ZONE_4, [])).toBeNull();
    expect(distanceAuTrace(ZONE_4, [])).toBeNull();
    expect(positionLeLongDuTrace(ZONE_4, [])).toBeNull();
  });

  it('points répétés ignorés', () => {
    const p = decale(ZONE_4, 800, 300);
    const proj = projeterSurTrace(p, [ZONE_4, ZONE_4, coude, coude, arrivee])!;
    expect(proj.distanceMetres).toBeCloseTo(300, -1);
    expect(proj.positionMetres).toBeCloseTo(800, -1);
  });

  it('sur un tracé Google décodé (Abidjan, pont HKB)', () => {
    const traceHkb = decoderPolyligne(
      encoderPolyligne([
        ZONE_4,
        { lat: 5.299, lng: -3.976 },
        { lat: 5.3117011, lng: -3.9797001 },
        { lat: 5.3183745, lng: -3.9801586 },
        { lat: 5.3273915, lng: -3.980939 },
      ]),
    );
    // Le milieu du pont est sur le tracé.
    expect(distanceAuTrace({ lat: 5.3183745, lng: -3.9801586 }, traceHkb)!).toBeLessThan(2);
    // Treichville (ouest) en est loin.
    expect(distanceAuTrace({ lat: 5.304, lng: -4.004 }, traceHkb)!).toBeGreaterThan(2000);
  });
});
