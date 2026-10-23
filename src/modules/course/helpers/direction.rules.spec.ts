/**
 * Règle « même direction » (conception 2) : les sept tests dans l'ordre avec
 * leur motif, les exemples d'Abidjan (restaurant Zone 4), le repli sans
 * tracé, le détour mesuré, les groupes et l'ordre des arrêts, les durées
 * sans Google, et la règle de toujours : jamais de mélange entre mètres
 * routiers et vol d'oiseau.
 *
 * Les tracés sont SYNTHÉTIQUES : quelques points sur les vraies routes et les
 * vrais ponts (coordonnées du pont HKB données par l'utilisateur, autres
 * ponts approchés), comme le ferait l'`overview_polyline` de Google.
 */
import { haversineMeters, ILatLng } from './geo.helper';
import {
  capDepuis,
  choisirLointain,
  ClientDirection,
  compatibiliteGroupe,
  compatibilitePaire,
  ecartCap,
  estDetourAMesurer,
  estimerTrajets,
  evaluerGroupe,
  evaluerPaire,
  FACTEUR_ROUTE_VOL_OISEAU,
  libelleDirection,
  lireReglagesDirection,
  MesureDetour,
  ordonnerArrets,
  REGLAGES_DIRECTION_DEFAUT,
  VerdictPaire,
} from './direction.rules';
import { longueurPolyligne } from './polyligne';

// ─── Outils ──────────────────────────────────────────────────────────────────

/** Décale un point de `nord` et `est` mètres. */
function decale(p: ILatLng, nord: number, est: number): ILatLng {
  const parDegre = (Math.PI / 180) * 6_371_000;
  return { lat: p.lat + nord / parDegre, lng: p.lng + est / (parDegre * Math.cos((p.lat * Math.PI) / 180)) };
}

/** Client avec, au choix, un tracé (sa distance routière en est la longueur). */
function client(id: string, position: ILatLng | null, trace?: ILatLng[] | null, routeMetres?: number | null): ClientDirection {
  return {
    id,
    position,
    trace: trace ?? null,
    routeMetres: routeMetres !== undefined ? routeMetres : trace ? longueurPolyligne(trace) : null,
  };
}

/** Verdict sans aucun appel à Google (détour indisponible). */
const sansGoogle = (r: ILatLng | null, a: ClientDirection, b: ClientDirection, reglages = REGLAGES_DIRECTION_DEFAUT) =>
  evaluerPaire(r, a, b, reglages, null) as VerdictPaire;

/** Faux Google : rend une mesure fixe et compte ses appels. */
function fauxDetour(mesure: MesureDetour | null) {
  return jest.fn(async () => mesure);
}

// Restaurant Zone 4 (Marcory).
const ZONE_4: ILatLng = { lat: 5.286, lng: -3.9737 };

// Pont Henri-Konan-Bédié (coordonnées de l'utilisateur) : sortie Marcory, milieu, péage côté Riviera.
const HKB_SORTIE_MARCORY: ILatLng = { lat: 5.3117011, lng: -3.9797001 };
const HKB_MILIEU: ILatLng = { lat: 5.3183745, lng: -3.9801586 };
const HKB_PEAGE: ILatLng = { lat: 5.3273915, lng: -3.980939 };
// Pont Charles-de-Gaulle, Treichville → Plateau (approché).
const DE_GAULLE_SUD: ILatLng = { lat: 5.308, lng: -4.012 };
const DE_GAULLE_NORD: ILatLng = { lat: 5.317, lng: -4.015 };

// ─── Tests 1 à 7, un par un, sur une géométrie simple ───────────────────────

describe('compatibilité d’une paire : les sept tests dans l’ordre', () => {
  const R = ZONE_4;

  it('1. même adresse : moins de 150 m entre les deux clients', () => {
    const a = client('a', decale(R, 2000, 0));
    const b = client('b', decale(R, 2000, 120));
    const v = sansGoogle(R, a, b);
    expect(v).toMatchObject({ compatible: true, test: 1, motif: 'MEME_ADRESSE', libelle: 'même adresse' });
    expect(v.versLointain).toBe(true);
    expect(v.memeZone).toBe(true);
  });

  it('1 l’emporte sur 2 : deux clients voisins ne sont jamais « opposés »', () => {
    // Même adresse très proche du restaurant : caps quelconques.
    const a = client('a', decale(R, 60, 0));
    const b = client('b', decale(R, -60, 0));
    expect(sansGoogle(R, a, b)).toMatchObject({ compatible: true, test: 1 });
  });

  it('2. sens opposés : plus de 100° d’écart, les deux à plus de 1 200 m', () => {
    const a = client('a', decale(R, 1500, 0), [R, decale(R, 1500, 0)]);
    const b = client('b', decale(R, -2000, 300), [R, decale(R, -2000, 300)]);
    expect(sansGoogle(R, a, b)).toMatchObject({ compatible: false, test: 2, motif: 'SENS_OPPOSES', libelle: 'sens opposés' });
  });

  it('2 ne joue pas si un client est à moins de 1 200 m du restaurant', () => {
    const a = client('a', decale(R, 1000, 0));
    const b = client('b', decale(R, -2000, 0));
    const v = sansGoogle(R, a, b);
    expect(v.test).not.toBe(2);
    expect(v.compatible).toBe(false);
  });

  it('3. sur le trajet : P à moins du couloir du tracé de L, et avant L', () => {
    const coude = decale(R, 2000, 0);
    const L = decale(coude, 0, 2500);
    const trace = [R, coude, L];
    const a = client('P', decale(R, 1200, 450), [R, decale(R, 1200, 450)]);
    const b = client('L', L, trace);
    const v = sansGoogle(R, a, b);
    expect(v).toMatchObject({ compatible: true, test: 3, motif: 'SUR_LE_TRAJET', libelle: 'sur le trajet', procheId: 'P', lointainId: 'L' });
    expect(v.distanceAuTraceM!).toBeCloseTo(450, -1);
    expect(v.versLointain).toBe(true);
  });

  it('3 : P à plus de 300 m au-delà de L n’est pas « sur le trajet »', () => {
    const L = decale(R, 3000, 0);
    // P plus près par la route (fausse distance courte) mais 500 m après L sur l'axe.
    const p = client('P', decale(R, 3500, 0), null, 2000);
    const l = client('L', L, [R, L], 3000);
    const v = sansGoogle(R, p, l);
    expect(v.test).not.toBe(3);
  });

  it('3 : P jusqu’à 300 m au-delà de L reste « sur le trajet » (imprécision des adresses)', () => {
    const L = decale(R, 3000, 0);
    const p = client('P', decale(R, 3250, 0), null, 2900);
    const l = client('L', L, [R, L], 3000);
    expect(sansGoogle(R, p, l)).toMatchObject({ compatible: true, test: 3 });
  });

  it('4. même zone : moins de 800 m, caps à 60° au plus ; Google coupé : compatible', () => {
    const a = client('a', decale(R, 2000, 0));
    const b = client('b', decale(R, 2300, 600));
    const v = sansGoogle(R, a, b);
    expect(v).toMatchObject({ compatible: true, test: 4, motif: 'MEME_ZONE', libelle: 'même zone', memeZone: true });
  });

  it('4 puis 5 : Google répond, la même zone est confirmée par le détour', async () => {
    const a = client('a', decale(R, 2000, 0));
    const b = client('b', decale(R, 2300, 600));
    const mesurer = fauxDetour({ secondesDirect: 420, secondesAvecEtape: 540 });
    const v = await compatibilitePaire(R, a, b, REGLAGES_DIRECTION_DEFAUT, mesurer);
    expect(mesurer).toHaveBeenCalledTimes(1);
    expect(v).toMatchObject({ compatible: true, test: 5, motif: 'MEME_ZONE', detourSecondes: 120, memeZone: true, versLointain: true });
  });

  it('4 puis 5 : Google dément la même zone (bras de lagune) : incompatible', async () => {
    const a = client('a', decale(R, 2000, 0));
    const b = client('b', decale(R, 2300, 600));
    const v = await compatibilitePaire(R, a, b, REGLAGES_DIRECTION_DEFAUT, fauxDetour({ secondesDirect: 420, secondesAvecEtape: 1100 }));
    expect(v).toMatchObject({ compatible: false, test: 5, motif: 'DETOUR_TROP_LONG', libelle: 'détour de 11 min, trop long', memeZone: false });
  });

  it('5. détour mesuré, sans tracé : compatible, « détour de 4 min »', async () => {
    const a = client('a', decale(R, 1500, 900));
    const b = client('b', decale(R, 4000, 0));
    const mesurer = fauxDetour({ secondesDirect: 900, secondesAvecEtape: 1140 });
    const v = await compatibilitePaire(R, a, b, REGLAGES_DIRECTION_DEFAUT, mesurer);
    expect(v).toMatchObject({ compatible: true, test: 5, motif: 'DETOUR', libelle: 'détour de 4 min', detourSecondes: 240 });
    // Restaurant, proche, lointain : dans cet ordre.
    expect(mesurer).toHaveBeenCalledWith(R, a.position, b.position);
  });

  it('5 : détour au-delà de 6 min refusé', async () => {
    const a = client('a', decale(R, 1500, 900));
    const b = client('b', decale(R, 4000, 0));
    const v = await compatibilitePaire(R, a, b, REGLAGES_DIRECTION_DEFAUT, fauxDetour({ secondesDirect: 1800, secondesAvecEtape: 2220 }));
    expect(v).toMatchObject({ compatible: false, test: 5, motif: 'DETOUR_TROP_LONG' });
  });

  it('5 : détour sous 6 min mais au-delà de 40 % du trajet direct, refusé', async () => {
    const a = client('a', decale(R, 1500, 900));
    const b = client('b', decale(R, 4000, 0));
    // 250 s de détour pour 600 s de trajet direct : 42 %.
    const v = await compatibilitePaire(R, a, b, REGLAGES_DIRECTION_DEFAUT, fauxDetour({ secondesDirect: 600, secondesAvecEtape: 850 }));
    expect(v).toMatchObject({ compatible: false, motif: 'DETOUR_TROP_LONG' });
    // 240 s pour 600 s : exactement 40 %, accepté.
    const w = await compatibilitePaire(R, a, b, REGLAGES_DIRECTION_DEFAUT, fauxDetour({ secondesDirect: 600, secondesAvecEtape: 840 }));
    expect(w).toMatchObject({ compatible: true, motif: 'DETOUR' });
  });

  it('5 : tracé connu et P juste hors du couloir (moins de deux couloirs) : le détour tranche', () => {
    const L = decale(R, 4000, 0);
    const p = client('P', decale(R, 2000, 900));
    const l = client('L', L, [R, L]);
    const v = evaluerPaire(R, p, l, REGLAGES_DIRECTION_DEFAUT, undefined);
    expect(estDetourAMesurer(v)).toBe(true);
  });

  it('5 n’est pas mené quand le tracé dit « loin » (plus de deux couloirs) : aucun appel à Google', async () => {
    const L = decale(R, 4000, 0);
    const p = client('P', decale(R, 2000, 1400));
    const l = client('L', L, [R, L]);
    const mesurer = fauxDetour({ secondesDirect: 900, secondesAvecEtape: 960 });
    const v = await compatibilitePaire(R, p, l, REGLAGES_DIRECTION_DEFAUT, mesurer);
    expect(mesurer).not.toHaveBeenCalled();
    expect(v).toMatchObject({ compatible: false, test: 7, motif: 'DIRECTION_DIFFERENTE' });
  });

  it('5 n’est pas mené au-delà de 60° d’écart de cap', () => {
    const p = client('P', decale(R, 500, 1500)); // 72° d'écart avec le nord
    const l = client('L', decale(R, 4000, 0));
    const v = evaluerPaire(R, p, l, REGLAGES_DIRECTION_DEFAUT, undefined);
    expect(estDetourAMesurer(v)).toBe(false);
  });

  it('les tests 1 à 3 concluent sans jamais demander de détour', async () => {
    const L = decale(R, 4000, 0);
    const mesurer = fauxDetour({ secondesDirect: 900, secondesAvecEtape: 960 });
    await compatibilitePaire(R, client('P', decale(R, 2000, 100)), client('L', L, [R, L]), REGLAGES_DIRECTION_DEFAUT, mesurer);
    await compatibilitePaire(R, client('a', decale(R, 2000, 0)), client('b', decale(R, 2000, 50)), REGLAGES_DIRECTION_DEFAUT, mesurer);
    expect(mesurer).not.toHaveBeenCalled();
  });

  it('6. sans carte : cap à 35° au plus et P à moins du couloir de la droite R → L', () => {
    const p = client('P', decale(R, 1500, 350));
    const l = client('L', decale(R, 4000, 0));
    expect(sansGoogle(R, p, l)).toMatchObject({
      compatible: true,
      test: 6,
      motif: 'SANS_CARTE',
      libelle: 'même direction (sans carte)',
      versLointain: true,
    });
  });

  it('6 : au-delà de l’angle maximal, refusé', () => {
    const p = client('P', decale(R, 1000, 800)); // 38,7° d'écart avec le nord
    const l = client('L', decale(R, 4000, 0));
    expect(sansGoogle(R, p, l)).toMatchObject({ compatible: false, test: 7 });
  });

  it('6 ne joue pas quand le tracé est connu : un tracé qui dit « loin » l’emporte sur l’angle (rives différentes)', async () => {
    // L à 4 km au nord, mais la route contourne une lagune par un pont à 3 km à l'est.
    const L = decale(R, 4000, 0);
    const trace = [R, decale(R, 0, 3000), decale(R, 4000, 3000), L];
    const p = client('P', decale(R, 2000, 0));
    // Sans tracé : le repli accepte (même angle, sur la droite).
    expect(sansGoogle(R, p, client('L', L))).toMatchObject({ compatible: true, test: 6 });
    // Avec le tracé : P est à 2 km de la route réelle, refusé, sans demander de détour.
    const mesurer = fauxDetour({ secondesDirect: 900, secondesAvecEtape: 960 });
    const v = await compatibilitePaire(R, p, client('L', L, trace), REGLAGES_DIRECTION_DEFAUT, mesurer);
    expect(v).toMatchObject({ compatible: false, test: 7, motif: 'DIRECTION_DIFFERENTE' });
    expect(mesurer).not.toHaveBeenCalled();
  });

  it('7. sinon : direction différente', () => {
    const p = client('P', decale(R, 1000, 1000));
    const l = client('L', decale(R, 3000, -1000));
    expect(sansGoogle(R, p, l)).toMatchObject({ compatible: false, test: 7, motif: 'DIRECTION_DIFFERENTE', libelle: 'direction différente' });
  });

  it('0. coordonnées manquantes (client ou restaurant) : la commande part seule', () => {
    const a = client('a', null);
    const b = client('b', decale(R, 2000, 0));
    expect(sansGoogle(R, a, b)).toMatchObject({ compatible: false, test: 0, motif: 'SANS_COORDONNEES', libelle: 'adresse sans coordonnées' });
    expect(sansGoogle(null, client('a', decale(R, 10, 0)), b)).toMatchObject({ compatible: false, motif: 'SANS_COORDONNEES' });
  });

  it('la réponse ne dépend pas de l’ordre des deux clients', () => {
    const coude = decale(R, 2000, 0);
    const L = decale(coude, 0, 2500);
    const p = client('P', decale(R, 1200, 450));
    const l = client('L', L, [R, coude, L]);
    const ab = sansGoogle(R, p, l);
    const ba = sansGoogle(R, l, p);
    expect(ba).toEqual(ab);
  });
});

// ─── Repli : Google muet, lent, plafonné ─────────────────────────────────────

describe('repli sans Google', () => {
  const R = ZONE_4;

  it('détour indisponible (null) : la même zone vaut seule, sinon le test 6', async () => {
    const zoneA = client('a', decale(R, 2000, 0));
    const zoneB = client('b', decale(R, 2300, 600));
    expect(await compatibilitePaire(R, zoneA, zoneB, REGLAGES_DIRECTION_DEFAUT, fauxDetour(null))).toMatchObject({
      compatible: true,
      test: 4,
      motif: 'MEME_ZONE',
    });
    const p = client('P', decale(R, 1500, 350));
    const l = client('L', decale(R, 4000, 0));
    expect(await compatibilitePaire(R, p, l, REGLAGES_DIRECTION_DEFAUT, fauxDetour(null))).toMatchObject({ compatible: true, test: 6 });
  });

  it('Google qui lève (délai dépassé) : même repli, jamais d’erreur', async () => {
    const p = client('P', decale(R, 1500, 350));
    const l = client('L', decale(R, 4000, 0));
    const lent = jest.fn(async () => {
      throw new Error('délai de 2500 ms dépassé');
    });
    await expect(compatibilitePaire(R, p, l, REGLAGES_DIRECTION_DEFAUT, lent)).resolves.toMatchObject({ compatible: true, test: 6 });
  });

  it('mesure absurde (durée nulle) : traitée comme une absence de mesure', () => {
    const p = client('P', decale(R, 1500, 350));
    const l = client('L', decale(R, 4000, 0));
    expect(evaluerPaire(R, p, l, REGLAGES_DIRECTION_DEFAUT, { secondesDirect: 0, secondesAvecEtape: 300 })).toMatchObject({ test: 6 });
  });

  it('tracé abîmé (un seul point) : traité comme absent', () => {
    const p = client('P', decale(R, 1500, 350));
    const l = client('L', decale(R, 4000, 0), [R]);
    expect(sansGoogle(R, p, l)).toMatchObject({ compatible: true, test: 6 });
  });

  it('sans mesureur : aucun appel, repli direct', async () => {
    const p = client('P', decale(R, 1500, 350));
    const l = client('L', decale(R, 4000, 0));
    await expect(compatibilitePaire(R, p, l)).resolves.toMatchObject({ test: 6 });
  });
});

// ─── Jamais de mélange entre mètres routiers et vol d'oiseau ─────────────────

describe('jamais de mélange entre mètres routiers et vol d’oiseau', () => {
  const R = ZONE_4;
  // A : 2,4 km à vol d'oiseau mais 5,2 km par la route (pont) ; B : 2,8 km et 3 km.
  const posA = decale(R, 2400, 0);
  const posB = decale(R, 0, 2800);

  it('les deux distances routières connues : P et L départagés par la route', () => {
    const v = sansGoogle(R, client('A', posA, null, 5200), client('B', posB, null, 3000));
    expect(v.classement).toBe('route');
    expect(v.lointainId).toBe('A');
  });

  it('une seule distance routière connue : tout à vol d’oiseau, jamais 5,2 km routiers contre 2,8 km d’oiseau', () => {
    const v = sansGoogle(R, client('A', posA, null, 5200), client('B', posB, null, null));
    expect(v.classement).toBe('vol_oiseau');
    expect(v.lointainId).toBe('B');
  });

  it('choisirLointain sur un groupe : la route seulement si toutes les distances la donnent', () => {
    const tous = [client('A', posA, null, 5200), client('B', posB, null, 3000), client('C', decale(R, 500, 0), null, 700)];
    expect(choisirLointain(R, tous)).toMatchObject({ classement: 'route', lointain: { id: 'A' } });
    tous[2] = client('C', decale(R, 500, 0), null, null);
    expect(choisirLointain(R, tous)).toMatchObject({ classement: 'vol_oiseau', lointain: { id: 'B' } });
  });

  it('une distance routière nulle ou illisible compte comme inconnue', () => {
    const v = sansGoogle(R, client('A', posA, null, 0), client('B', posB, null, 3000));
    expect(v.classement).toBe('vol_oiseau');
    const w = sansGoogle(R, client('A', posA, null, Number.NaN), client('B', posB, null, 3000));
    expect(w.classement).toBe('vol_oiseau');
  });

  it('estimations : base « route » avec un tracé, « vol d’oiseau » redressé sinon, jamais confondues', () => {
    const L = decale(R, 4000, 0);
    const avecTrace = estimerTrajets(R, [client('P', decale(R, 2000, 0)), client('L', L, [R, L])], { mode: 'trajet', vitesseKmh: 24 });
    const sansTrace = estimerTrajets(R, [client('P', decale(R, 2000, 0)), client('L', L)], { mode: 'trajet', vitesseKmh: 24 });
    expect(avecTrace.base).toBe('route');
    expect(sansTrace.base).toBe('vol_oiseau');
    expect(sansTrace.metresTotal / avecTrace.metresTotal).toBeCloseTo(FACTEUR_ROUTE_VOL_OISEAU, 2);
  });
});

// ─── Exemples d'Abidjan (conception 2.7), restaurant Zone 4 ─────────────────

describe('exemples d’Abidjan, restaurant Zone 4 (5.2860 / -3.9737)', () => {
  const R = ZONE_4;

  // Axe Marcory → Koumassi → Port-Bouët (boulevard VGE puis route de l'aéroport).
  const KOUMASSI: ILatLng = { lat: 5.283, lng: -3.955 };
  const PORT_BOUET: ILatLng = { lat: 5.26, lng: -3.942 };
  const traceVersPortBouet = [R, { lat: 5.285, lng: -3.96 }, { lat: 5.28, lng: -3.95 }, { lat: 5.27, lng: -3.945 }, PORT_BOUET];

  it('Koumassi (2 km) et Port-Bouët (4 km) sur le même axe : compatibles, « sur le trajet »', () => {
    expect(haversineMeters(R, KOUMASSI)).toBeGreaterThan(1900);
    expect(haversineMeters(R, PORT_BOUET)).toBeGreaterThan(4000);
    const koumassi = client('koumassi', KOUMASSI, [R, { lat: 5.285, lng: -3.96 }, KOUMASSI]);
    const portBouet = client('port-bouet', PORT_BOUET, traceVersPortBouet);
    const v = sansGoogle(R, koumassi, portBouet);
    expect(v).toMatchObject({ compatible: true, test: 3, motif: 'SUR_LE_TRAJET', procheId: 'koumassi', lointainId: 'port-bouet' });
    // Rejeté par l'ancien critère (1 500 m entre clients).
    expect(haversineMeters(KOUMASSI, PORT_BOUET)).toBeGreaterThan(1500);
  });

  it('Marcory nord et Biétry, 700 m de part et d’autre du restaurant : incompatibles', () => {
    const MARCORY_NORD: ILatLng = { lat: 5.2919, lng: -3.9758 };
    const BIETRY: ILatLng = { lat: 5.2801, lng: -3.9716 };
    expect(haversineMeters(R, MARCORY_NORD)).toBeCloseTo(700, -2);
    expect(haversineMeters(R, BIETRY)).toBeCloseTo(700, -2);
    // Accepté par l'ancien critère : moins de 1 500 m entre eux.
    expect(haversineMeters(MARCORY_NORD, BIETRY)).toBeLessThan(1500);
    // Avec tracés comme sans tracé : jamais groupés.
    const avec = sansGoogle(R, client('nord', MARCORY_NORD, [R, MARCORY_NORD], 900), client('bietry', BIETRY, [R, BIETRY], 950));
    const sans = sansGoogle(R, client('nord', MARCORY_NORD), client('bietry', BIETRY));
    expect(avec.compatible).toBe(false);
    expect(sans.compatible).toBe(false);
    expect(avec.motif).toBe('DIRECTION_DIFFERENTE');
    expect(ecartCap(capDepuis(R, MARCORY_NORD), capDepuis(R, BIETRY))).toBeGreaterThan(170);
  });

  it('500 m de part et d’autre du restaurant, avec tracés : jamais « sur le trajet » (recette R9)', () => {
    const est = decale(R, 0, 500);
    const ouest = decale(R, 0, -500);
    // P est dans le couloir du tracé de L (500 m du départ), mais derrière le restaurant.
    const v = sansGoogle(R, client('est', est, [R, est], 620), client('ouest', ouest, [R, ouest], 640));
    expect(v).toMatchObject({ compatible: false, motif: 'DIRECTION_DIFFERENTE', test: 7 });
    // Même résultat avec un tracé Google qui commence sur la route, un peu à côté du restaurant.
    const departRoute = decale(R, 40, 0);
    const w = sansGoogle(R, client('est', est, [departRoute, est], 620), client('ouest', ouest, [departRoute, ouest], 640));
    expect(w.compatible).toBe(false);
  });

  it('un client à 250 m en arrière du restaurant reste « sur le trajet » d’un client à 3 km (marge de 300 m)', () => {
    const derriere = decale(R, 0, -250);
    const loin = decale(R, 0, 3000);
    const v = sansGoogle(R, client('derriere', derriere, [R, derriere], 300), client('loin', loin, [R, loin], 3300));
    expect(v).toMatchObject({ compatible: true, motif: 'SUR_LE_TRAJET', test: 3, procheId: 'derriere' });
    const plusLoin = decale(R, 0, -400);
    const w = sansGoogle(R, client('derriere', plusLoin, [R, plusLoin], 480), client('loin', loin, [R, loin], 3300));
    expect(w.compatible).toBe(false);
  });

  it('plus loin de part et d’autre (1,5 et 2 km) : « sens opposés »', () => {
    const nord = decale(R, 1500, -300);
    const sud = decale(R, -2000, 400);
    expect(sansGoogle(R, client('nord', nord), client('sud', sud))).toMatchObject({ compatible: false, motif: 'SENS_OPPOSES' });
  });

  it('Treichville (zone portuaire) et Plateau, angle voisin, rives différentes : incompatibles avec le tracé', async () => {
    const TREICHVILLE_PORT: ILatLng = { lat: 5.29, lng: -4.01 };
    const PLATEAU: ILatLng = { lat: 5.323, lng: -4.018 };
    // Par le boulevard VGE et le pont Charles-de-Gaulle.
    const traceVersPlateau = [R, { lat: 5.295, lng: -3.985 }, { lat: 5.3, lng: -3.998 }, { lat: 5.305, lng: -4.008 }, DE_GAULLE_SUD, DE_GAULLE_NORD, PLATEAU];
    expect(ecartCap(capDepuis(R, TREICHVILLE_PORT), capDepuis(R, PLATEAU))).toBeLessThanOrEqual(35);

    const mesurer = fauxDetour({ secondesDirect: 1200, secondesAvecEtape: 1300 });
    const v = await compatibilitePaire(
      R,
      client('treichville', TREICHVILLE_PORT, [R, { lat: 5.295, lng: -3.985 }, { lat: 5.3, lng: -3.998 }, TREICHVILLE_PORT]),
      client('plateau', PLATEAU, traceVersPlateau),
      REGLAGES_DIRECTION_DEFAUT,
      mesurer,
    );
    expect(v).toMatchObject({ compatible: false, test: 7, motif: 'DIRECTION_DIFFERENTE', lointainId: 'plateau' });
    expect(v.distanceAuTraceM!).toBeGreaterThan(1200);
    // Le tracé dit « loin » : on ne paie même pas un détour.
    expect(mesurer).not.toHaveBeenCalled();
  });

  it('à surveiller sans tracé : Treichville (port) et Plateau restent refusés par l’écart latéral', () => {
    const v = sansGoogle(R, client('treichville', { lat: 5.29, lng: -4.01 }), client('plateau', { lat: 5.323, lng: -4.018 }));
    expect(v.compatible).toBe(false);
  });

  it('Treichville sur le boulevard VGE et Plateau : la route du Plateau passe par Treichville, compatibles', () => {
    const TREICHVILLE_VGE: ILatLng = { lat: 5.3015, lng: -4.0005 };
    const PLATEAU: ILatLng = { lat: 5.323, lng: -4.018 };
    const traceVersPlateau = [R, { lat: 5.295, lng: -3.985 }, { lat: 5.3, lng: -3.998 }, { lat: 5.305, lng: -4.008 }, DE_GAULLE_SUD, DE_GAULLE_NORD, PLATEAU];
    expect(sansGoogle(R, client('treichville', TREICHVILLE_VGE), client('plateau', PLATEAU, traceVersPlateau))).toMatchObject({
      compatible: true,
      motif: 'SUR_LE_TRAJET',
    });
  });

  it('Marcory ouest (rive sud) et Deux-Plateaux (rive nord, par le pont HKB), même angle : incompatibles', async () => {
    const MARCORY_OUEST: ILatLng = { lat: 5.304, lng: -3.995 };
    const DEUX_PLATEAUX: ILatLng = { lat: 5.36, lng: -4.0 };
    const traceParHkb = [R, { lat: 5.299, lng: -3.976 }, HKB_SORTIE_MARCORY, HKB_MILIEU, HKB_PEAGE, { lat: 5.34, lng: -3.988 }, DEUX_PLATEAUX];
    expect(ecartCap(capDepuis(R, MARCORY_OUEST), capDepuis(R, DEUX_PLATEAUX))).toBeLessThanOrEqual(35);

    const mesurer = fauxDetour({ secondesDirect: 1500, secondesAvecEtape: 1600 });
    const v = await compatibilitePaire(
      R,
      client('marcory', MARCORY_OUEST, null, 3800),
      client('deux-plateaux', DEUX_PLATEAUX, traceParHkb),
      REGLAGES_DIRECTION_DEFAUT,
      mesurer,
    );
    expect(v).toMatchObject({ compatible: false, test: 7, lointainId: 'deux-plateaux' });
    expect(mesurer).not.toHaveBeenCalled();
  });

  it('un client de Marcory au pied du pont HKB est, lui, sur le trajet de la Riviera', () => {
    const PIED_DU_PONT: ILatLng = { lat: 5.309, lng: -3.9815 };
    const RIVIERA: ILatLng = { lat: 5.345, lng: -3.975 };
    const traceParHkb = [R, { lat: 5.299, lng: -3.976 }, HKB_SORTIE_MARCORY, HKB_MILIEU, HKB_PEAGE, RIVIERA];
    expect(sansGoogle(R, client('marcory', PIED_DU_PONT), client('riviera', RIVIERA, traceParHkb))).toMatchObject({
      compatible: true,
      motif: 'SUR_LE_TRAJET',
    });
  });

  it('deux immeubles voisins à Biétry : « même adresse »', () => {
    const v = sansGoogle(R, client('a', { lat: 5.272, lng: -3.964 }), client('b', { lat: 5.2728, lng: -3.9645 }));
    expect(v).toMatchObject({ compatible: true, motif: 'MEME_ADRESSE' });
  });

  it('deux rues de Biétry à 500 m : « même zone », confirmée par le détour quand Google répond', async () => {
    const a = client('a', { lat: 5.272, lng: -3.964 });
    const b = client('b', { lat: 5.27, lng: -3.96 });
    expect(sansGoogle(R, a, b)).toMatchObject({ compatible: true, test: 4, motif: 'MEME_ZONE' });
    const v = await compatibilitePaire(R, a, b, REGLAGES_DIRECTION_DEFAUT, fauxDetour({ secondesDirect: 420, secondesAvecEtape: 500 }));
    expect(v).toMatchObject({ compatible: true, test: 5, motif: 'MEME_ZONE' });
  });
});

// ─── Groupes de 3 et ordre des arrêts (conception 2.4) ──────────────────────

describe('groupes et ordre des arrêts', () => {
  const R = ZONE_4;
  const L = decale(R, 4500, 0);
  const trace = [R, decale(R, 2000, 0), L];
  const p1 = client('p1', decale(R, 1500, 200));
  const p2 = client('p2', decale(R, 3000, -300));
  const l = client('l', L, trace);
  const verdictSansGoogle = (a: ClientDirection, b: ClientDirection) => sansGoogle(R, a, b);

  it('trois clients sur le trajet : groupe valide, arrêts dans l’ordre de la route, quel que soit l’ordre d’entrée', () => {
    for (const entree of [[p1, p2, l], [l, p2, p1], [p2, l, p1]]) {
      const g = evaluerGroupe(R, entree, verdictSansGoogle);
      expect(g).toMatchObject({ valide: true, mode: 'trajet', lointainId: 'l', motif: 'SUR_LE_TRAJET', libelle: 'sur le trajet' });
      expect(g.ordre).toEqual(['p1', 'p2', 'l']);
    }
  });

  it('le motif du groupe est celui de la paire la moins favorable (détour)', async () => {
    // p3 hors couloir mais à moins de deux couloirs : détour mesuré, 3 min.
    const p3 = client('p3', decale(R, 2500, 900));
    const g = await compatibiliteGroupe(R, [p1, p3, l], REGLAGES_DIRECTION_DEFAUT, fauxDetour({ secondesDirect: 900, secondesAvecEtape: 1080 }));
    expect(g).toMatchObject({ valide: true, mode: 'trajet', motif: 'DETOUR', libelle: 'détour de 3 min' });
    expect(g.ordre).toEqual(['p1', 'p3', 'l']);
  });

  it('un client qui n’est pas sur le trajet du plus lointain refuse le groupe, avec la paire en cause', () => {
    const ailleurs = client('ailleurs', decale(R, 1500, -1500));
    const g = evaluerGroupe(R, [p1, ailleurs, l], verdictSansGoogle);
    expect(g.valide).toBe(false);
    expect(g.ordre).toEqual([]);
    expect(g.refus).toMatchObject({ compatible: false, procheId: 'ailleurs', lointainId: 'l' });
    expect(g.libelle).toBe(g.refus!.libelle);
  });

  it('même zone deux à deux, sans être sur le trajet : mode zone, plus proche voisin depuis le restaurant', () => {
    // L à 1,5 km à l'est ; X à 700 m au nord de L, plus loin du restaurant à vol d'oiseau.
    const zl = client('zl', decale(R, 0, 1500));
    const zx = client('zx', decale(R, 700, 1500));
    const g = evaluerGroupe(R, [zx, zl], verdictSansGoogle);
    expect(g).toMatchObject({ valide: true, mode: 'zone', motif: 'MEME_ZONE', lointainId: 'zx' });
    expect(g.ordre).toEqual(['zl', 'zx']);
  });

  it('zone : on part du restaurant, pas de la commande la plus ancienne', () => {
    const loin = client('loin', decale(R, 2600, 2600));
    const pres = client('pres', decale(R, 2200, 2200));
    const milieu = client('milieu', decale(R, 2400, 2500));
    // L'entrée suit l'ancienneté : la plus lointaine d'abord.
    expect(ordonnerArrets(R, [loin, milieu, pres], { mode: 'zone' })).toEqual(['pres', 'milieu', 'loin']);
  });

  it('les livraisons déjà en route gardent leur rang en tête', () => {
    expect(ordonnerArrets(R, [p1, p2, l], { mode: 'trajet', lointainId: 'l', fixes: ['p2'] })).toEqual(['p2', 'p1', 'l']);
    // En zone, le voisinage repart du dernier client fixe.
    const a = client('a', decale(R, 2000, 2000));
    const b = client('b', decale(R, 2300, 2300));
    const c = client('c', decale(R, 2100, 2150));
    expect(ordonnerArrets(R, [a, b, c], { mode: 'zone', fixes: ['b'] })).toEqual(['b', 'c', 'a']);
  });

  it('un client juste au-delà du plus lointain (même adresse, 100 m plus loin sur l’axe) passe après lui', () => {
    // Plus court par la route (entrée de rue), mais au-delà sur le tracé.
    const apres = client('apres', decale(L, 100, 0), null, 4400);
    const g = evaluerGroupe(R, [apres, client('p1', p1.position, null, 1600), l], verdictSansGoogle);
    expect(g).toMatchObject({ valide: true, mode: 'trajet', lointainId: 'l', classement: 'route' });
    expect(g.ordre).toEqual(['p1', 'l', 'apres']);
  });

  it('un seul client : groupe « seul »', () => {
    expect(evaluerGroupe(R, [p1], verdictSansGoogle)).toMatchObject({ valide: true, mode: 'seul', ordre: ['p1'] });
  });

  it('un client sans coordonnées n’est jamais groupé', () => {
    const g = evaluerGroupe(R, [p1, client('sans', null)], verdictSansGoogle);
    expect(g).toMatchObject({ valide: false, motif: 'SANS_COORDONNEES' });
  });

  it('compatibiliteGroupe : sur le trajet, les paires sans le plus lointain ne coûtent aucun détour', async () => {
    const mesurer = fauxDetour({ secondesDirect: 900, secondesAvecEtape: 960 });
    const g = await compatibiliteGroupe(R, [p1, p2, l], REGLAGES_DIRECTION_DEFAUT, mesurer);
    expect(g.valide).toBe(true);
    expect(mesurer).not.toHaveBeenCalled();
    expect(g.verdicts).toHaveLength(2);
  });
});

// ─── Durées des trajets sans Google ──────────────────────────────────────────

describe('estimerTrajets', () => {
  const R = ZONE_4;
  const L = decale(R, 4000, 0);

  it('sur le trajet : positions le long du tracé, écart au tracé aller et retour', () => {
    const e = estimerTrajets(R, [client('p', decale(R, 2000, 300)), client('l', L, [R, L])], { mode: 'trajet', vitesseKmh: 24 });
    expect(e.base).toBe('route');
    expect(e.metresCumules[0]).toBeCloseTo(2300, -1);
    expect(e.metresCumules[1]).toBeCloseTo(4600, -1);
    expect(e.secondesTotal).toBeCloseTo(4600 / (24 / 3.6), -1);
  });

  it('client avant le départ du tracé ou après sa fin : le bout du tracé n’est pas compté deux fois', () => {
    // 250 m derrière le restaurant : R → P 250 m, P → R → L 250 + 4 000 m.
    const derriere = estimerTrajets(R, [client('p', decale(R, -250, 0)), client('l', L, [R, L])], { mode: 'trajet', vitesseKmh: 24 });
    expect(derriere.metresCumules[0]).toBeCloseTo(250, -1);
    expect(derriere.metresCumules[1]).toBeCloseTo(4500, -1);
    // 200 m après L sur l'axe (marge du test 3) : R → L 4 000 m, puis 200 m.
    const lointain = client('l', L, [R, L]);
    const apres = estimerTrajets(R, [lointain, client('p', decale(R, 4200, 0))], { mode: 'trajet', lointain, vitesseKmh: 24 });
    expect(apres.metresCumules[0]).toBeCloseTo(4000, -1);
    expect(apres.metresCumules[1]).toBeCloseTo(4200, -1);
  });

  it('sans tracé : la droite R → L redressée de 1,4', () => {
    const e = estimerTrajets(R, [client('p', decale(R, 2000, 0)), client('l', L)], { mode: 'trajet', vitesseKmh: 22 });
    expect(e.base).toBe('vol_oiseau');
    expect(e.metresTotal).toBeCloseTo(4000 * 1.4, -1);
  });

  it('même zone : approche par le tracé du plus lointain, puis vol d’oiseau × 1,4', () => {
    const zl = decale(R, 0, 1500);
    const zx = decale(R, 700, 1500);
    const avec = estimerTrajets(R, [client('zl', zl), client('zx', zx, [R, decale(R, 0, 1500), zx])], {
      mode: 'zone',
      vitesseKmh: 22,
    });
    expect(avec.base).toBe('route');
    expect(avec.metresCumules[0]).toBeCloseTo(1500, -1);
    expect(avec.metresCumules[1]).toBeCloseTo(1500 + 700 * 1.4, -1);
    const sans = estimerTrajets(R, [client('zl', zl), client('zx', zx)], { mode: 'zone', vitesseKmh: 22 });
    expect(sans.base).toBe('vol_oiseau');
    expect(sans.metresCumules[0]).toBeCloseTo(1500 * 1.4, -1);
  });

  it('seul : tracé, sinon distance routière, sinon vol d’oiseau × 1,4', () => {
    expect(estimerTrajets(R, [client('l', L, [R, L])], { mode: 'seul', vitesseKmh: 22 })).toMatchObject({ base: 'route' });
    expect(estimerTrajets(R, [client('l', L, null, 5100)], { mode: 'seul', vitesseKmh: 22 }).metresTotal).toBe(5100);
    expect(estimerTrajets(R, [client('l', L)], { mode: 'seul', vitesseKmh: 22 }).metresTotal).toBeCloseTo(4000 * 1.4, -1);
  });

  it('vitesse absurde : 22 km/h par défaut ; aucun arrêt : zéro', () => {
    const e = estimerTrajets(R, [client('l', L, null, 2200)], { mode: 'seul', vitesseKmh: 0 });
    expect(e.secondesTotal).toBeCloseTo(2200 / (22 / 3.6), 3);
    expect(estimerTrajets(R, [], { mode: 'seul', vitesseKmh: 22 })).toMatchObject({ metresTotal: 0, secondesTotal: 0 });
  });
});

// ─── Réglages et textes ──────────────────────────────────────────────────────

describe('lireReglagesDirection', () => {
  it('rien en base : défauts de la conception', () => {
    expect(lireReglagesDirection({})).toEqual({
      reglages: { couloirM: 600, zoneRayonM: 800, angleMaxDeg: 35, detourMaxMin: 6, detourMaxPct: 40 },
      google: true,
      refusees: [],
    });
  });

  it('0 accepté (il coupe le test qu’il règle), valeurs lues', () => {
    const { reglages, google, refusees } = lireReglagesDirection({
      'course.direction_couloir_m': '400',
      'course.direction_zone_rayon_m': '0',
      'course.direction_angle_max_deg': '0',
      'course.direction_detour_max_min': '0',
      'course.direction_detour_max_pct': '25,5',
      'course.direction_google': '0',
    });
    expect(reglages).toEqual({ couloirM: 400, zoneRayonM: 0, angleMaxDeg: 0, detourMaxMin: 0, detourMaxPct: 25.5 });
    expect(google).toBe(false);
    expect(refusees).toEqual([]);
  });

  it('valeur négative, illisible ou angle de plus de 180° : refusée, défaut appliqué, signalée', () => {
    const { reglages, google, refusees } = lireReglagesDirection({
      'course.direction_couloir_m': '-5',
      'course.direction_angle_max_deg': '270',
      'course.direction_detour_max_min': 'six',
      'course.direction_google': 'peut-être',
    });
    expect(reglages).toMatchObject({ couloirM: 600, angleMaxDeg: 35, detourMaxMin: 6 });
    expect(google).toBe(true);
    expect(refusees.map((r) => r.cle)).toEqual([
      'course.direction_couloir_m',
      'course.direction_angle_max_deg',
      'course.direction_detour_max_min',
      'course.direction_google',
    ]);
  });

  it('zone à 0 : plus jamais « même zone »', () => {
    const { reglages } = lireReglagesDirection({ 'course.direction_zone_rayon_m': '0' });
    const a = client('a', decale(ZONE_4, 2000, 0));
    const b = client('b', decale(ZONE_4, 2300, 600));
    expect(sansGoogle(ZONE_4, a, b, reglages).motif).not.toBe('MEME_ZONE');
  });
});

describe('libelleDirection', () => {
  it('textes courts, sans valeur d’énumération brute ni tiret cadratin, 40 caractères au plus', () => {
    const motifs = ['MEME_ADRESSE', 'SENS_OPPOSES', 'SUR_LE_TRAJET', 'MEME_ZONE', 'DETOUR', 'DETOUR_TROP_LONG', 'SANS_CARTE', 'DIRECTION_DIFFERENTE', 'SANS_COORDONNEES'] as const;
    for (const m of motifs) {
      for (const secondes of [null, 20, 240, 1500]) {
        const texte = libelleDirection(m, secondes);
        expect(texte).not.toMatch(/[A-Z]{2,}|_|—/);
        expect(texte.length).toBeLessThanOrEqual(40);
      }
    }
    expect(libelleDirection('DETOUR', 20)).toBe('détour de moins d’une minute');
    expect(libelleDirection('DETOUR', 240)).toBe('détour de 4 min');
  });
});
