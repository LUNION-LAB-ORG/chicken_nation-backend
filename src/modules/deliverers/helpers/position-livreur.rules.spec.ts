/**
 * Position du livreur gardée en base (relecture du 24/10) : un relevé
 * imprécis (plus de 80 m) reste la dernière position (carte, temps de
 * trajet) mais ne remplace pas la dernière position précise, seule à décider
 * départ, comptoir et sac attendu.
 */
import { lirePositionLivreur, positionAEnregistrer, releveAssezPrecis } from './position-livreur.rules';

const T0 = new Date('2026-10-24T12:00:00.000Z');
const T1 = new Date('2026-10-24T12:00:40.000Z');
const COMPTOIR = { lat: 5.286, lng: -3.9737 };
const LOIN = { lat: 5.286, lng: -3.9710 }; // environ 300 m à l'est

describe('position du livreur en base', () => {
  it('relevé précis, ou sans précision annoncée (ancienne appli) : lui seul, il décide', () => {
    expect(positionAEnregistrer({ ...LOIN, precision_m: 12 }, null)).toEqual({ ...LOIN, precision_m: 12 });
    expect(positionAEnregistrer({ ...LOIN }, null)).toEqual({ ...LOIN, precision_m: null });
    expect(lirePositionLivreur({ ...LOIN, precision_m: 12 }, T1)).toEqual({
      position: LOIN,
      position_at: T1,
      precision_m: 12,
      sure: { position: LOIN, position_at: T1 },
    });
    // Ancienne écriture `{ lat, lng }` : précise, comme avant.
    expect(lirePositionLivreur({ ...COMPTOIR }, T0).sure).toEqual({ position: COMPTOIR, position_at: T0 });
  });

  it('relevé imprécis : la dernière position précise est gardée à côté, avec son heure', () => {
    const precedente = { last_location: { ...COMPTOIR, precision_m: 10 }, last_location_at: T0 };
    const ecrite = positionAEnregistrer({ ...LOIN, precision_m: 150 }, precedente);
    expect(ecrite).toEqual({ ...LOIN, precision_m: 150, sure: { ...COMPTOIR, at: T0.toISOString() } });

    const lue = lirePositionLivreur(ecrite, T1);
    expect(lue.position).toEqual(LOIN); // la carte montre le relevé
    expect(lue.position_at).toEqual(T1);
    expect(lue.sure).toEqual({ position: COMPTOIR, position_at: T0 }); // les règles, la position précise
  });

  it('deux relevés imprécis de suite : la position précise d’avant reste, elle ne se perd pas', () => {
    const premier = positionAEnregistrer({ ...LOIN, precision_m: 150 }, { last_location: { ...COMPTOIR, precision_m: 10 }, last_location_at: T0 });
    const second = positionAEnregistrer({ lat: 5.287, lng: -3.972, precision_m: 200 }, { last_location: premier, last_location_at: T1 });
    expect(lirePositionLivreur(second, new Date(T1.getTime() + 30_000)).sure).toEqual({ position: COMPTOIR, position_at: T0 });
  });

  it('relevé imprécis sans aucune position précise connue : rien ne décide', () => {
    expect(positionAEnregistrer({ ...LOIN, precision_m: 150 }, null).sure).toBeNull();
    expect(positionAEnregistrer({ ...LOIN, precision_m: 150 }, { last_location: null, last_location_at: null }).sure).toBeNull();
    expect(lirePositionLivreur({ ...LOIN, precision_m: 150, sure: null }, T1).sure).toBeNull();
  });

  it('valeurs illisibles en base : aucune position, jamais d’erreur', () => {
    expect(lirePositionLivreur(null, null)).toEqual({ position: null, position_at: null, precision_m: null, sure: null });
    expect(lirePositionLivreur({ lat: '5.2', lng: -3.9 }, T0).position).toBeNull();
    expect(lirePositionLivreur({ ...LOIN, precision_m: 150, sure: { lat: 5.2, lng: -3.9, at: 'pas une date' } }, T0).sure).toBeNull();
  });

  it('seul un relevé imprécis demande de relire la ligne', () => {
    expect(releveAssezPrecis(null)).toBe(true);
    expect(releveAssezPrecis(80)).toBe(true);
    expect(releveAssezPrecis(81)).toBe(false);
  });
});
