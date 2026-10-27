/**
 * Ordre des arrêts par la route (demande du client du 27/10) : règle pure.
 * Distances routières fixées dans le test (coordonnées d'Abidjan du contrat
 * `tournee-contrat.md`, section A5).
 */
import {
  ARRETS_MAX_PERMUTATIONS,
  ArretOrdre,
  clePaireArrets,
  cleOrdre,
  gainNouvelOrdreS,
  matriceComplete,
  meilleurOrdre,
  nouvelOrdreUtile,
  ParametresOrdre,
  SEUIL_NOUVEL_ORDRE_S,
  tourneeParLaRoute,
} from './ordre-arrets.rules';

const DEPART = Date.UTC(2026, 9, 27, 15, 30);
const MIN = 60_000;
/** 22 km/h hors pointe : mètres par seconde. */
const MPS = 22 / 3.6;

const arret = (id: string, o: Partial<ArretOrdre> = {}): ArretOrdre => ({
  id,
  place: true,
  promesseMs: DEPART + 60 * MIN,
  limiteMs: DEPART + 65 * MIN,
  ...o,
});

/** O2 : Zone 4 → Anoumabo (2,3 km), Riviera bord de lagune (7,0 km), Riviera Golf (9,6 km). */
const O2 = {
  restaurant: new Map([
    ['A', 2300],
    ['L', 7000],
    ['G', 9600],
  ]),
  paires: new Map([
    [clePaireArrets('A', 'L'), 4700],
    [clePaireArrets('A', 'G'), 7300],
    [clePaireArrets('L', 'G'), 2600],
  ]),
};

function parametres(o: Partial<ParametresOrdre> = {}): ParametresOrdre {
  return {
    arrets: [arret('A'), arret('L'), arret('G')],
    matrice: { depuisRestaurant: O2.restaurant, entreClients: O2.paires },
    departMs: DEPART,
    vitesseKmh: 22,
    arretClientS: 180,
    arriveeSansPositionMs: DEPART + 12 * MIN,
    ...o,
  };
}

describe('matriceComplete', () => {
  const client = (id: string, routeMetres: number | null, place = true) => ({
    id,
    position: place ? { lat: 5.3, lng: -3.98 } : null,
    routeMetres,
  });

  it('toutes les distances connues : restaurant → client et chaque paire, dans un sens ou dans l’autre', () => {
    const m = matriceComplete([client('A', 2300), client('L', 7000), client('G', 9600)], O2.paires);
    expect(m).not.toBeNull();
    expect(m!.depuisRestaurant.get('G')).toBe(9600);
    expect(m!.entreClients.get(clePaireArrets('G', 'A'))).toBe(7300);
  });

  it('une seule distance manque : pas de matrice (jamais de mélange route et vol d’oiseau)', () => {
    const sansPaire = new Map(O2.paires);
    sansPaire.delete(clePaireArrets('L', 'G'));
    expect(matriceComplete([client('A', 2300), client('L', 7000), client('G', 9600)], sansPaire)).toBeNull();
    expect(matriceComplete([client('A', 2300), client('L', null), client('G', 9600)], O2.paires)).toBeNull();
    expect(matriceComplete([client('A', 2300), client('L', 7000)], undefined)).toBeNull();
  });

  it('un client sans coordonnées n’entre pas dans la matrice (il reste en fin de liste)', () => {
    const m = matriceComplete([client('A', 2300), client('L', 7000), client('X', null, false)], O2.paires);
    expect(m).not.toBeNull();
    expect(m!.depuisRestaurant.has('X')).toBe(false);
  });
});

describe('tourneeParLaRoute et cleOrdre', () => {
  it('arrivées : départ + mètres cumulés / vitesse + 3 min par client précédent ; boucle avec le retour', () => {
    const t = tourneeParLaRoute(parametres(), ['A', 'L', 'G']);
    expect(t.arriveesMs.get('A')).toBe(DEPART + Math.round((2300 / MPS) * 1000));
    expect(t.arriveesMs.get('L')).toBe(DEPART + Math.round((7000 / MPS + 180) * 1000));
    expect(t.arriveesMs.get('G')).toBe(DEPART + Math.round((9600 / MPS + 360) * 1000));
    expect(t.dureeS).toBeCloseTo(9600 / MPS + 360, 3);
    expect(t.boucleS).toBeCloseTo(19200 / MPS + 540, 3);
    expect(t.cle).toEqual(cleOrdre(parametres().arrets, t.arriveesMs, DEPART, t.boucleS));
  });

  it('clé : retard au-delà des limites, au-delà des promesses, boucle, somme des arrivées (à la seconde)', () => {
    const arrets = [arret('A', { promesseMs: DEPART + 5 * MIN, limiteMs: DEPART + 10 * MIN })];
    const arrivees = new Map([['A', DEPART + 12 * MIN]]);
    expect(cleOrdre(arrets, arrivees, DEPART, 1000.4)).toEqual([120, 420, 1000, 720]);
  });

  it('un client sans coordonnées arrive à l’heure supposée, en fin de liste', () => {
    const p = parametres({ arrets: [arret('X', { place: false }), arret('A'), arret('L')] });
    const t = tourneeParLaRoute(p, ['X', 'A', 'L']);
    expect(t.ordre).toEqual(['A', 'L', 'X']);
    expect(t.arriveesMs.get('X')).toBe(DEPART + 12 * MIN);
  });
});

describe('meilleurOrdre', () => {
  it('O2 : pont HKB passé une seule fois, Anoumabo, Riviera lagune, Riviera Golf', () => {
    // Quatre boucles ont la même longueur (19,2 km) : le client le plus proche servi d’abord départage.
    const r = meilleurOrdre({ ...parametres(), ordreDirection: ['L', 'A', 'G'], dureeTourneeMaxS: 25 * 60 })!;
    expect(r.meilleur.ordre).toEqual(['A', 'L', 'G']);
    expect(r.direction.ordre).toEqual(['L', 'A', 'G']);
    expect(r.meilleur.boucleS).toBeLessThan(r.direction.boucleS);
  });

  it('la promesse passe avant la distance (O4) : le client pressé d’abord s’il passerait sa limite', () => {
    // O1 : Koumassi 2,3 km, Port-Bouët 4,6 km, entre les deux 2,6 km. Port-Bouët commandée il y a 33 min.
    const p: ParametresOrdre = {
      ...parametres(),
      arrets: [
        arret('K'),
        arret('PB', { promesseMs: DEPART + 2 * MIN, limiteMs: DEPART + 7 * MIN }),
      ],
      matrice: {
        depuisRestaurant: new Map([
          ['K', 2300],
          ['PB', 4600],
        ]),
        entreClients: new Map([[clePaireArrets('K', 'PB'), 2600]]),
      },
    };
    expect(meilleurOrdre({ ...p, ordreDirection: ['K', 'PB'], dureeTourneeMaxS: 25 * 60 })!.meilleur.ordre).toEqual(['PB', 'K']);
    // Sans urgence : Koumassi d’abord (même boucle, client le plus proche servi d’abord).
    const calme = { ...p, arrets: [arret('K'), arret('PB')] };
    expect(meilleurOrdre({ ...calme, ordreDirection: ['PB', 'K'], dureeTourneeMaxS: 25 * 60 })!.meilleur.ordre).toEqual(['K', 'PB']);
  });

  it('égalité parfaite : l’ordre de la direction est gardé', () => {
    const p: ParametresOrdre = {
      ...parametres(),
      arrets: [arret('A'), arret('B')],
      matrice: {
        depuisRestaurant: new Map([
          ['A', 3000],
          ['B', 3000],
        ]),
        entreClients: new Map([[clePaireArrets('A', 'B'), 1000]]),
      },
    };
    expect(meilleurOrdre({ ...p, ordreDirection: ['B', 'A'], dureeTourneeMaxS: 25 * 60 })!.meilleur.ordre).toEqual(['B', 'A']);
    expect(meilleurOrdre({ ...p, ordreDirection: ['A', 'B'], dureeTourneeMaxS: 25 * 60 })!.meilleur.ordre).toEqual(['A', 'B']);
  });

  it('écarte un ordre dont la tournée dépasse le plus long de l’ordre de la direction et de 25 min', () => {
    // X à 1 km, Y à 5 km, 4,5 km entre eux ; Y pressée. Y d’abord la sauverait
    // un peu, mais la tournée passerait à 29 min (direction : 18 min).
    const p: ParametresOrdre = {
      ...parametres(),
      arrets: [arret('X'), arret('Y', { promesseMs: DEPART + MIN, limiteMs: DEPART + 5 * MIN })],
      matrice: {
        depuisRestaurant: new Map([
          ['X', 1000],
          ['Y', 5000],
        ]),
        entreClients: new Map([[clePaireArrets('X', 'Y'), 4500]]),
      },
    };
    const r = meilleurOrdre({ ...p, ordreDirection: ['X', 'Y'], dureeTourneeMaxS: 25 * 60 })!;
    expect(r.direction.dureeS).toBeLessThan(25 * 60);
    expect(r.meilleur.ordre).toEqual(['X', 'Y']);
    // Avec une tournée permise de 30 min, l’ordre qui sauve Y passe.
    expect(meilleurOrdre({ ...p, ordreDirection: ['X', 'Y'], dureeTourneeMaxS: 30 * 60 })!.meilleur.ordre).toEqual(['Y', 'X']);
  });

  it(`au-delà de ${ARRETS_MAX_PERMUTATIONS} arrêts placés, ou moins de 2 : rien (le calcul d’aujourd’hui)`, () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const restaurant = new Map(ids.map((id, i) => [id, 1000 + i * 100]));
    const paires = new Map<string, number>();
    for (const x of ids) for (const y of ids) if (x < y) paires.set(clePaireArrets(x, y), 500);
    const p: ParametresOrdre = {
      ...parametres(),
      arrets: ids.map((id) => arret(id)),
      matrice: { depuisRestaurant: restaurant, entreClients: paires },
    };
    expect(meilleurOrdre({ ...p, ordreDirection: ids, dureeTourneeMaxS: 25 * 60 })).toBeNull();
    expect(meilleurOrdre({ ...p, arrets: [arret('a')], ordreDirection: ['a'], dureeTourneeMaxS: 25 * 60 })).toBeNull();
    const cinq = ids.slice(0, 5);
    expect(meilleurOrdre({ ...p, arrets: cinq.map((id) => arret(id)), ordreDirection: cinq, dureeTourneeMaxS: 25 * 60 })).not.toBeNull();
  });
});

describe('nouvelOrdreUtile : 60 s de tolérance sur chaque critère, dans l’ordre', () => {
  it('gain de 40 s : non ; gain de 3 min : oui', () => {
    expect(SEUIL_NOUVEL_ORDRE_S).toBe(60);
    expect(nouvelOrdreUtile([0, 0, 1000, 2000], [0, 0, 1000, 1960])).toBe(false);
    expect(nouvelOrdreUtile([0, 0, 1000, 2000], [0, 0, 1000, 1820])).toBe(true);
    expect(gainNouvelOrdreS([0, 0, 1000, 2000], [0, 0, 1000, 1820])).toBe(180);
  });

  it('dans la tolérance, le critère suivant décide ; pire au-delà de la tolérance : non', () => {
    expect(nouvelOrdreUtile([30, 0, 1000, 2000], [0, 0, 1200, 1000])).toBe(false);
    expect(nouvelOrdreUtile([300, 0, 1000, 2000], [0, 0, 1200, 3000])).toBe(true);
    expect(gainNouvelOrdreS([300, 0, 1000, 2000], [0, 0, 1200, 3000])).toBe(300);
    expect(nouvelOrdreUtile([0, 0, 1000, 2000], [0, 0, 1000, 2000])).toBe(false);
    expect(gainNouvelOrdreS([0, 0, 1000, 2000], [0, 0, 1000, 2000])).toBe(0);
  });
});
