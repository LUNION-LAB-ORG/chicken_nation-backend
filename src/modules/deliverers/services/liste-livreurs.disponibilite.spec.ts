/**
 * Liste des livreurs (`GET /deliverers`, fenêtre « Forcer l'affectation » du
 * backoffice) et carte (`GET /deliverers/live-locations`) : chaque livreur
 * porte `disponibilite`, calculée par la règle unique. Le backoffice montre
 * exactement ce que le serveur refuserait. Depuis le 24/10 : `appli_active`
 * et `appli_vue_a` (« Appli fermée », « En arrière-plan »).
 */
import { CourseStatut } from '@prisma/client';

import {
  course,
  livreur,
  monterBaseDispatch,
  offre,
} from 'src/modules/course/services/base-dispatch.simulee-spec';

import { FIN_PAUSE_INDEFINIE } from '../helpers/disponibilite.rules';
import { finsSocketSimulees } from './base-livreurs.simulee-spec';
import { DeliverersService } from './deliverers.service';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

function monter() {
  const disponible = livreur({ first_name: 'Awa' });
  const enPause = livreur({ first_name: 'Koffi', pause_until: new Date('2026-10-22T14:32:00.000Z'), last_available_at: null });
  const horsService = livreur({ first_name: 'Yao', last_available_at: null });
  const enCourse = livreur({ first_name: 'Ama', last_available_at: null });
  const sollicite = livreur({ first_name: 'Kouamé' });
  const c = course();
  const base = monterBaseDispatch({
    livreurs: [disponible, enPause, horsService, enCourse, sollicite],
    courses: [c, course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: enCourse.id })],
    offres: [offre({ course_id: c.id, deliverer_id: sollicite.id })],
  });
  // Présence : seule Awa a l'appli ouverte (socket dans son canal privé).
  const presence = {
    livreursConnectes: jest.fn(async (ids: string[]): Promise<Set<string> | null> =>
      new Set(ids.filter((id) => id === disponible.id)),
    ),
  };
  const service = new DeliverersService(
    base.prisma,
    {} as never,
    {} as never,
    { load: jest.fn(async () => ({ gpsExpirationMinutes: 5, appliFermeeApresS: 180 })) } as never,
    {} as never,
    presence as never,
  );
  return { base, service, presence, c, disponible, enPause, horsService, enCourse, sollicite };
}

/**
 * Appli active ou fermée (24/10) : Fanta est en service mais son appli se tait
 * depuis 10 min (glissée hors de la liste des applis : l'appli a fermé son
 * socket) ; Koffi aussi, mais son socket est tombé faute de réseau (25/10 :
 * connexion coupée) ; Moussa a l'appli en arrière-plan (positions toutes les
 * 30 s, pas de socket) ; Awa a le socket.
 */
function monterAppli(appliFermeeApresS = 180) {
  const vue = (s: number) => new Date(MAINTENANT.getTime() - s * 1000);
  const awa = livreur({ protocole_appli: 4, first_name: 'Awa', dernier_signal_at: vue(400) });
  const fanta = livreur({ protocole_appli: 4, first_name: 'Fanta', dernier_signal_at: vue(600) });
  const koffi = livreur({ protocole_appli: 4, first_name: 'Koffi', dernier_signal_at: vue(600) });
  const moussa = livreur({ protocole_appli: 4, first_name: 'Moussa', dernier_signal_at: vue(30) });
  const base = monterBaseDispatch({ livreurs: [awa, fanta, koffi, moussa] });
  const fins = finsSocketSimulees({
    [fanta.id]: { raison: 'client namespace disconnect', a: vue(598) },
    [koffi.id]: { raison: 'ping timeout', a: vue(555) },
    // Ancienne fin d'Awa : son socket est rouvert, elle ne compte pas.
    [awa.id]: { raison: 'client namespace disconnect', a: vue(3000) },
  });
  const presence = {
    livreursConnectes: jest.fn(async (ids: string[]): Promise<Set<string> | null> =>
      new Set(ids.filter((id) => id === awa.id)),
    ),
  };
  const service = new DeliverersService(
    base.prisma,
    {} as never,
    {} as never,
    { load: jest.fn(async () => ({ gpsExpirationMinutes: 5, appliFermeeApresS })) } as never,
    {} as never,
    presence as never,
    undefined,
    fins as never,
  );
  return { service, fins, vue, awa, fanta, koffi, moussa };
}

describe('GET /deliverers : état de chaque livreur', () => {
  it('disponible, en pause jusqu’à 14 h 32, hors service, en course, offre en attente (avec sa course)', async () => {
    const t = monter();

    const { items } = await t.service.findAll({ limit: 50 } as never);
    const parPrenom = Object.fromEntries(items.map((l: any) => [l.first_name, l.disponibilite]));

    expect(parPrenom.Awa).toMatchObject({ etat: 'DISPONIBLE', libelle: 'Disponible', peut_recevoir_offre: true });
    expect(parPrenom.Koffi).toMatchObject({
      etat: 'EN_PAUSE',
      libelle: "En pause jusqu'à 14 h 32",
      message_refus: "Ce livreur est en pause jusqu'à 14 h 32.",
      peut_recevoir_offre: false,
    });
    expect(parPrenom.Yao).toMatchObject({ etat: 'HORS_SERVICE', libelle: 'Hors service', en_service: false });
    expect(parPrenom.Ama).toMatchObject({ etat: 'EN_COURSE', en_course: true });
    expect(parPrenom['Kouamé']).toMatchObject({
      etat: 'OFFRE_EN_ATTENTE',
      offre_en_attente: true,
      offre_course_id: t.c.id,
    });
    // Les champs de calcul ne sortent pas.
    expect(items.every((l: any) => !('_count' in l) && !('offer_attempts' in l))).toBe(true);
  });
});

describe('« Appli non connectée » : présence du socket de chaque livreur', () => {
  it('GET /deliverers : `appli_connectee` vrai seulement pour celui qui a un socket, en une seule question', async () => {
    const t = monter();

    const { items } = await t.service.findAll({ limit: 50 } as never);
    const parPrenom = Object.fromEntries(items.map((l: any) => [l.first_name, l.appli_connectee]));

    expect(parPrenom).toEqual({ Awa: true, Koffi: false, Yao: false, Ama: false, 'Kouamé': false });
    expect(t.presence.livreursConnectes).toHaveBeenCalledTimes(1);
  });

  it('présence illisible (Redis) : `appli_connectee` à null, la liste répond quand même', async () => {
    const t = monter();
    t.presence.livreursConnectes.mockResolvedValue(null);

    const { items } = await t.service.findAll({ limit: 50 } as never);
    expect(items.map((l: any) => l.appli_connectee)).toEqual(items.map(() => null));
    const carte = await t.service.getLiveLocations({ includeOffline: true });
    expect(carte.every((l) => l.appli_connectee === null)).toBe(true);
  });

  it('carte (live-locations) : même champ', async () => {
    const t = monter();
    const carte = await t.service.getLiveLocations({ includeOffline: true });
    const parId = Object.fromEntries(carte.map((l) => [l.id, l.appli_connectee]));
    expect(parId[t.disponible.id]).toBe(true);
    expect(parId[t.enPause.id]).toBe(false);
  });
});

describe('GET /deliverers/live-locations : « En pause » et « Hors service » visibles', () => {
  it('chaque livreur porte son état, position récente ou non (includeOffline)', async () => {
    const t = monter();
    t.horsService.pause_until = FIN_PAUSE_INDEFINIE;

    const carte = await t.service.getLiveLocations({ includeOffline: true });
    const parId = Object.fromEntries(carte.map((l) => [l.id, l.disponibilite]));

    expect(parId[t.enPause.id].libelle).toBe("En pause jusqu'à 14 h 32");
    expect(parId[t.horsService.id].libelle).toBe('En pause');
    expect(parId[t.disponible.id].etat).toBe('DISPONIBLE');
    expect(parId[t.sollicite.id].etat).toBe('OFFRE_EN_ATTENTE');
  });
});

describe('appli active ou fermée (24/10) : `appli_active` et `appli_vue_a`', () => {
  it('GET /deliverers : « Appli fermée » pour l’appli qui se tait, en arrière-plan reste disponible', async () => {
    const t = monterAppli();

    const { items } = await t.service.findAll({ limit: 50 } as never);
    const parPrenom = Object.fromEntries(items.map((l: any) => [l.first_name, l]));

    expect(parPrenom.Fanta).toMatchObject({
      appli_connectee: false,
      appli_active: false,
      appli_vue_a: t.vue(600).toISOString(),
      appli_etat: 'FERMEE',
      disponibilite: {
        etat: 'APPLI_FERMEE',
        libelle: 'Appli fermée',
        peut_recevoir_offre: false,
        message_refus: "L'appli de ce livreur est fermée.",
        appli_active: false,
        appli_vue_a: t.vue(600),
        appli_etat: 'FERMEE',
      },
    });
    // Même silence, mais le socket est tombé faute de réseau (25/10) : connexion coupée.
    expect(parPrenom.Koffi).toMatchObject({
      appli_connectee: false,
      appli_active: false,
      appli_etat: 'COUPURE',
      appli_vue_a: t.vue(600).toISOString(),
      disponibilite: {
        etat: 'CONNEXION_COUPEE',
        libelle: 'Connexion coupée',
        peut_recevoir_offre: false,
        message_refus: 'La connexion de ce livreur est coupée : son appli ne répond plus.',
        appli_etat: 'COUPURE',
      },
    });
    // En arrière-plan : pas de socket, mais l'appli envoie ses positions.
    expect(parPrenom.Moussa).toMatchObject({
      appli_connectee: false,
      appli_active: true,
      appli_etat: 'ACTIVE',
      appli_vue_a: t.vue(30).toISOString(),
      disponibilite: { etat: 'DISPONIBLE', peut_recevoir_offre: true },
    });
    // Socket ouvert : active, même sans signe de vie récent, quelle que soit une ancienne fin.
    expect(parPrenom.Awa).toMatchObject({
      appli_connectee: true,
      appli_active: true,
      appli_etat: 'ACTIVE',
      disponibilite: { etat: 'DISPONIBLE' },
    });
    // Fins lues en une fois, pour les seuls livreurs sans socket ouvert.
    expect(t.fins.lireSansSocket).toHaveBeenCalledTimes(1);
    expect(t.fins.lire.mock.calls[0][0]).not.toContain(t.awa.id);
  });

  it('fins de socket illisibles (Redis muet) : jamais « Appli fermée », connexion coupée pour les deux', async () => {
    const t = monterAppli();
    t.fins.etat.fins = null;
    const { items } = await t.service.findAll({ limit: 50 } as never);
    const parPrenom = Object.fromEntries(items.map((l: any) => [l.first_name, l]));
    expect(parPrenom.Fanta).toMatchObject({ appli_etat: 'COUPURE', disponibilite: { etat: 'CONNEXION_COUPEE' } });
    expect(parPrenom.Koffi).toMatchObject({ appli_etat: 'COUPURE', disponibilite: { etat: 'CONNEXION_COUPEE' } });
  });

  it('carte (live-locations) : mêmes champs', async () => {
    const t = monterAppli();
    const carte = await t.service.getLiveLocations({ includeOffline: true });
    const parId = Object.fromEntries(carte.map((l) => [l.id, l]));

    expect(parId[t.fanta.id]).toMatchObject({
      appli_active: false,
      appli_etat: 'FERMEE',
      appli_vue_a: t.vue(600).toISOString(),
      disponibilite: { etat: 'APPLI_FERMEE', libelle: 'Appli fermée' },
    });
    expect(parId[t.koffi.id]).toMatchObject({
      appli_active: false,
      appli_etat: 'COUPURE',
      disponibilite: { etat: 'CONNEXION_COUPEE', libelle: 'Connexion coupée' },
    });
    expect(parId[t.moussa.id]).toMatchObject({ appli_connectee: false, appli_active: true });
    expect(parId[t.awa.id]).toMatchObject({ appli_connectee: true, appli_active: true });
  });

  it('appli d’avant le protocole 4 : disponible malgré son silence, état de l’appli inconnu (null) dans la liste et sur la carte', async () => {
    const t = monterAppli();
    t.fanta.protocole_appli = 3;

    const { items } = await t.service.findAll({ limit: 50 } as never);
    const fanta = items.find((l: any) => l.first_name === 'Fanta') as any;
    expect(fanta).toMatchObject({
      appli_active: null,
      appli_etat: null,
      disponibilite: { etat: 'DISPONIBLE', appli_active: null, appli_etat: null },
    });
    const moussa = items.find((l: any) => l.first_name === 'Moussa') as any;
    expect(moussa.appli_active).toBe(true);

    const carte = await t.service.getLiveLocations({ includeOffline: true });
    expect(carte.find((l) => l.id === t.fanta.id)).toMatchObject({ appli_active: null, disponibilite: { etat: 'DISPONIBLE' } });
  });

  it('réglage à 0 : règle coupée, toute appli peut recevoir une offre, mais son état est inconnu (null, jamais « En arrière-plan »)', async () => {
    const t = monterAppli(0);
    const { items } = await t.service.findAll({ limit: 50 } as never);
    expect(items.every((l: any) => l.disponibilite.etat === 'DISPONIBLE')).toBe(true);
    expect(items.every((l: any) => l.appli_active === null && l.disponibilite.appli_active === null)).toBe(true);
    expect(items.every((l: any) => l.appli_etat === null)).toBe(true);

    const carte = await t.service.getLiveLocations({ includeOffline: true });
    expect(carte.length).toBeGreaterThan(0);
    expect(carte.every((l) => l.appli_active === null && l.disponibilite.appli_active === null)).toBe(true);
  });
});

describe('« Injoignable » : ni socket ouvert, ni jeton de notification', () => {
  function monterJoignables(offreJoignablesSeulement: boolean) {
    const awa = livreur({ first_name: 'Awa', expo_push_token: null });
    const fanta = livreur({ first_name: 'Fanta', expo_push_token: null });
    const moussa = livreur({ first_name: 'Moussa' });
    const base = monterBaseDispatch({ livreurs: [awa, fanta, moussa] });
    // Awa a le socket, Fanta n'a rien, Moussa a un jeton (iOS en arrière-plan).
    const presence = {
      livreursConnectes: jest.fn(async (ids: string[]): Promise<Set<string> | null> =>
        new Set(ids.filter((id) => id === awa.id)),
      ),
    };
    const service = new DeliverersService(
      base.prisma,
      {} as never,
      {} as never,
      { load: jest.fn(async () => ({ gpsExpirationMinutes: 5, appliFermeeApresS: 180, offreJoignablesSeulement })) } as never,
      {} as never,
      presence as never,
    );
    return { service, awa, fanta, moussa };
  }

  it('liste et carte : Fanta « Injoignable », non sélectionnable ; Awa et Moussa disponibles', async () => {
    const t = monterJoignables(true);

    const { items } = await t.service.findAll({ limit: 50 } as never);
    const liste = Object.fromEntries(items.map((l: any) => [l.first_name, l.disponibilite]));
    expect(liste.Fanta).toMatchObject({
      etat: 'INJOIGNABLE',
      libelle: 'Injoignable',
      peut_recevoir_offre: false,
      message_refus: 'Ce livreur est injoignable : ni appli connectée, ni notifications.',
    });
    expect(liste.Awa).toMatchObject({ etat: 'DISPONIBLE' });
    expect(liste.Moussa).toMatchObject({ etat: 'DISPONIBLE' });

    const carte = await t.service.getLiveLocations({ includeOffline: true });
    const parId = Object.fromEntries(carte.map((l) => [l.id, l]));
    expect(parId[t.fanta.id].disponibilite.etat).toBe('INJOIGNABLE');
    expect(parId[t.moussa.id].disponibilite.etat).toBe('DISPONIBLE');
    // Le jeton est lu pour l'état, jamais renvoyé par la carte.
    expect(carte.every((l) => !('expo_push_token' in l))).toBe(true);
  });

  it('réglage à 0 : disponible comme avant', async () => {
    const t = monterJoignables(false);
    const { items } = await t.service.findAll({ limit: 50 } as never);
    expect(items.find((l: any) => l.first_name === 'Fanta')?.disponibilite.etat).toBe('DISPONIBLE');
  });
});

describe('Jeton de notification du livreur : lu pour l’état, jamais renvoyé (26/10)', () => {
  /*
   * La liste et la fiche sont ouvertes au suivi des livraisons et au call
   * center. Le serveur pousse sans jeton d'accès Expo : le jeton d'un livreur
   * suffit à envoyer une fausse offre à son téléphone.
   */
  it('GET /deliverers : aucun livreur ne porte `expo_push_token`, Moussa reste joignable par son jeton', async () => {
    const awa = livreur({ first_name: 'Awa', expo_push_token: null });
    const fanta = livreur({ first_name: 'Fanta', expo_push_token: null });
    const moussa = livreur({ first_name: 'Moussa', expo_push_token: 'ExponentPushToken[moussa]' });
    const base = monterBaseDispatch({ livreurs: [awa, fanta, moussa] });
    const service = new DeliverersService(
      base.prisma,
      {} as never,
      {} as never,
      { load: jest.fn(async () => ({ gpsExpirationMinutes: 5, appliFermeeApresS: 180, offreJoignablesSeulement: true })) } as never,
      {} as never,
      { livreursConnectes: jest.fn(async (ids: string[]) => new Set(ids.filter((id) => id === awa.id))) } as never,
    );

    const { items } = await service.findAll({ limit: 50 } as never);

    expect(items).toHaveLength(3);
    expect(items.every((l: any) => !('expo_push_token' in l))).toBe(true);
    expect(JSON.stringify(items)).not.toContain('ExponentPushToken');
    const etats = Object.fromEntries(items.map((l: any) => [l.first_name, l.disponibilite.etat]));
    expect(etats).toEqual({ Awa: 'DISPONIBLE', Fanta: 'INJOIGNABLE', Moussa: 'DISPONIBLE' });
  });

  it('GET /deliverers/:id et GET /deliverers/me : le jeton n’est pas lu, ni le mot de passe, ni le jeton de session', async () => {
    const moussa = livreur({ first_name: 'Moussa' });
    const base = monterBaseDispatch({ livreurs: [moussa] });
    const service = new DeliverersService(base.prisma, {} as never, {} as never, {} as never, {} as never, {} as never);

    await service.findOne(moussa.id);

    const lecture = (base.prisma.deliverer.findUnique as jest.Mock).mock.calls[0][0];
    expect(lecture.omit).toEqual({ password: true, refresh_token: true, expo_push_token: true });
  });
});
