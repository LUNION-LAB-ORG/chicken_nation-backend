/**
 * DirectionService : les commandes vues par la règle « même direction »
 * (coordonnées, distance routière et tracé du cache), le détour par Google,
 * et le réglage `course.direction_google` qui coupe tout appel.
 */
import { ILatLng } from '../helpers/geo.helper';
import { encoderPolyligne } from '../helpers/polyligne';
import { DirectionService } from './direction.service';

function decale(p: ILatLng, nord: number, est: number): ILatLng {
  const parDegre = (Math.PI / 180) * 6_371_000;
  return { lat: p.lat + nord / parDegre, lng: p.lng + est / (parDegre * Math.cos((p.lat * Math.PI) / 180)) };
}

const ZONE_4: ILatLng = { lat: 5.286, lng: -3.9737 };
const LOIN = decale(ZONE_4, 4000, 0);
const PROCHE = decale(ZONE_4, 2000, 900);

function monter(reglages: Record<string, string> = {}) {
  const maps = {
    itineraireRoutier: jest.fn(async (p: { destLat: number; destLng: number }) => {
      const destination = { lat: p.destLat, lng: p.destLng };
      return { metres: 1000 + Math.round(Math.abs(destination.lat - ZONE_4.lat) * 111_000), secondes: 600, polyligne: encoderPolyligne([ZONE_4, destination]) };
    }),
    detourSansTrafic: jest.fn(async () => ({ secondesDirect: 900, secondesAvecEtape: 1080 })),
  };
  const settings = { getMany: jest.fn(async () => reglages) };
  const service = new DirectionService(maps as never, settings as never);
  return { service, maps, settings };
}

const commande = (id: string, p: ILatLng | null, enChaine = false) => {
  if (!p) return { id, address: { title: 'Sans coordonnées', latitude: 0, longitude: 0 } };
  const adresse = { title: 'Maison', latitude: p.lat, longitude: p.lng };
  return { id, address: enChaine ? JSON.stringify(adresse) : adresse };
};

describe('DirectionService.client', () => {
  it('coordonnées (objet ou chaîne JSON), distance routière et tracé décodé', async () => {
    const { service, maps } = monter();
    const c = await service.client(ZONE_4, commande('cmd-1', LOIN, true), true);
    expect(c.position).toEqual({ lat: LOIN.lat, lng: LOIN.lng });
    expect(c.routeMetres).toBeGreaterThan(0);
    expect(c.trace).toHaveLength(2);
    // Budget du regroupement (plafonné), jamais celui des frais de livraison.
    expect(maps.itineraireRoutier).toHaveBeenCalledWith(
      {
        originLat: ZONE_4.lat,
        originLng: ZONE_4.lng,
        destLat: LOIN.lat,
        destLng: LOIN.lng,
      },
      { pour: 'direction' },
    );
  });

  it('Google coupé par réglage, restaurant ou client sans coordonnées : aucun appel', async () => {
    const { service, maps } = monter();
    await expect(service.client(ZONE_4, commande('a', LOIN), false)).resolves.toMatchObject({ routeMetres: null, trace: null });
    await expect(service.client(null, commande('b', LOIN), true)).resolves.toMatchObject({ routeMetres: null });
    await expect(service.client(ZONE_4, commande('c', null), true)).resolves.toMatchObject({ position: null });
    expect(maps.itineraireRoutier).not.toHaveBeenCalled();
  });

  it('itinéraire indisponible (Google muet, plafond) ou en échec : client sans route, jamais d’exception', async () => {
    const { service, maps } = monter();
    maps.itineraireRoutier.mockResolvedValueOnce(null as never);
    await expect(service.client(ZONE_4, commande('a', LOIN), true)).resolves.toMatchObject({ routeMetres: null, trace: null });
    maps.itineraireRoutier.mockRejectedValueOnce(new Error('imprévu'));
    await expect(service.client(ZONE_4, commande('b', LOIN), true)).resolves.toMatchObject({ routeMetres: null, trace: null });
  });

  it('tracé vide en cache : mètres gardés, pas de tracé', async () => {
    const { service, maps } = monter();
    maps.itineraireRoutier.mockResolvedValueOnce({ metres: 4200, secondes: 600, polyligne: '' });
    await expect(service.client(ZONE_4, commande('a', LOIN), true)).resolves.toMatchObject({ routeMetres: 4200, trace: null });
  });
});

describe('DirectionService.verdictPaire et verdictGroupe', () => {
  it('Google permis : le détour est mesuré par MapsService, en latitude / longitude', async () => {
    const { service, maps } = monter();
    const lus = await service.reglages();
    const [proche, loin] = await service.clients(ZONE_4, [commande('p', PROCHE), commande('l', LOIN)], lus.google);
    const v = await service.verdictPaire(ZONE_4, proche, loin, lus);
    expect(v).toMatchObject({ compatible: true, motif: 'DETOUR', libelle: 'détour de 3 min' });
    expect(maps.detourSansTrafic).toHaveBeenCalledWith({
      restaurant: { latitude: ZONE_4.lat, longitude: ZONE_4.lng },
      proche: { latitude: PROCHE.lat, longitude: PROCHE.lng },
      lointain: { latitude: LOIN.lat, longitude: LOIN.lng },
    });
  });

  it('course.direction_google = 0 : ni tracé ni détour, repli sans carte', async () => {
    const { service, maps } = monter({ 'course.direction_google': '0' });
    const lus = await service.reglages();
    expect(lus.google).toBe(false);
    const clients = await service.clients(ZONE_4, [commande('p', decale(ZONE_4, 1500, 300)), commande('l', LOIN)], lus.google);
    const g = await service.verdictGroupe(ZONE_4, clients, lus);
    expect(g).toMatchObject({ valide: true, mode: 'trajet', motif: 'SANS_CARTE' });
    expect(maps.itineraireRoutier).not.toHaveBeenCalled();
    expect(maps.detourSansTrafic).not.toHaveBeenCalled();
  });

  it('réglages relus à chaque appel quand on ne les passe pas', async () => {
    const { service, settings } = monter({ 'course.direction_couloir_m': '1000' });
    const a = { id: 'a', position: decale(ZONE_4, 1500, 800), routeMetres: null, trace: null };
    const l = { id: 'l', position: LOIN, routeMetres: 4000, trace: [ZONE_4, LOIN] };
    // 800 m du tracé : hors couloir de 600 m, dans celui de 1 000 m.
    await expect(service.verdictPaire(ZONE_4, a, l)).resolves.toMatchObject({ compatible: true, motif: 'SUR_LE_TRAJET' });
    expect(settings.getMany).toHaveBeenCalledTimes(1);
  });

  it('valeur refusée : défaut appliqué, signalée une fois par minute', async () => {
    const { service } = monter({ 'course.direction_couloir_m': '-3' });
    const avertir = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    const lus = await service.reglages();
    await service.reglages();
    expect(lus.reglages.couloirM).toBe(600);
    expect(avertir).toHaveBeenCalledTimes(1);
    expect(String((avertir.mock.calls[0] as unknown[])[0])).toContain('course.direction_couloir_m');
  });

  it('base muette : défauts, sans exception', async () => {
    const { service, settings } = monter();
    settings.getMany.mockRejectedValueOnce(new Error('P1001'));
    await expect(service.reglages()).resolves.toMatchObject({ google: true, reglages: { couloirM: 600 } });
  });
});
