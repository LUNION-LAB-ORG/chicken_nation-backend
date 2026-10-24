/**
 * Appli du livreur active ou fermée (demande du 24/10 : « c'est lorsqu'il
 * ferme la fenêtre que ça ne doit pas passer »).
 *
 * Le VRAI service sur la base simulée : contexte de la règle unique (présence
 * demandée seulement pour les signes de vie qui ne suffisent pas) et relevé
 * des passages « appli fermée » / « appli active » au journal de la diffusion,
 * sous verrou consultatif, jamais deux fois le même.
 */
import { CourseStatut, DelivererStatus } from '@prisma/client';

import { course, livreur as livreurBase, monterBaseDispatch } from 'src/modules/course/services/base-dispatch.simulee-spec';

import { appliLivreurSimulee } from './base-livreurs.simulee-spec';
import {
  CLASSE_VERROU_SUIVI_APPLIS,
  FENETRE_SUIVI_APPLIS_MS,
  MARGE_PRESENCE_MS,
  idsSansSignalSuffisant,
  passageAEcrire,
} from './appli-livreur.service';

/** Livreur avec la nouvelle appli (protocole 4) : la règle de l'appli fermée le vise. */
const livreur = (surcharge: Parameters<typeof livreurBase>[0] = {}) => livreurBase({ protocole_appli: 4, ...surcharge });

const MAINTENANT = new Date('2026-10-24T12:00:00.000Z');
const avantS = (s: number, depuis = MAINTENANT) => new Date(depuis.getTime() - s * 1000);
const apresS = (s: number) => new Date(MAINTENANT.getTime() + s * 1000);

type OptionsAppli = Parameters<typeof appliLivreurSimulee>[1];

function monter(donnees: Parameters<typeof monterBaseDispatch>[0], appli: OptionsAppli = { connectes: [] }) {
  const base = monterBaseDispatch(donnees);
  const a = appliLivreurSimulee(base.prisma, appli);
  const passages = () => base.journal.filter((l) => l.type === 'APPLI_FERMEE' || l.type === 'APPLI_ACTIVE');
  return { ...base, ...a, passages };
}

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

describe('passageAEcrire', () => {
  it('fermée sans passage écrit, ou après une réouverture : APPLI_FERMEE ; déjà écrit : rien', () => {
    expect(passageAEcrire(false, null)).toBe('APPLI_FERMEE');
    expect(passageAEcrire(false, 'APPLI_ACTIVE')).toBe('APPLI_FERMEE');
    expect(passageAEcrire(false, 'APPLI_FERMEE')).toBeNull();
  });

  it('active : APPLI_ACTIVE seulement après une fermeture écrite', () => {
    expect(passageAEcrire(true, 'APPLI_FERMEE')).toBe('APPLI_ACTIVE');
    expect(passageAEcrire(true, 'APPLI_ACTIVE')).toBeNull();
    expect(passageAEcrire(true, null)).toBeNull();
  });
});

describe('idsSansSignalSuffisant (présence à demander)', () => {
  it('signe de vie absent, trop vieux ou qui le sera dans les 10 s : présence demandée', () => {
    expect(MARGE_PRESENCE_MS).toBe(10_000);
    const lignes = [
      { id: 'frais', dernier_signal_at: avantS(30), protocole_appli: 4 },
      { id: 'limite-marge', dernier_signal_at: avantS(169), protocole_appli: 4 },
      { id: 'dans-la-marge', dernier_signal_at: avantS(170), protocole_appli: 4 },
      { id: 'vieux', dernier_signal_at: avantS(600), protocole_appli: 4 },
      { id: 'jamais', dernier_signal_at: null, protocole_appli: 4 },
    ];
    expect(idsSansSignalSuffisant(lignes, MAINTENANT, 180)).toEqual(['dans-la-marge', 'vieux', 'jamais']);
  });

  it('seuil plus court que la marge : présence demandée pour tous', () => {
    expect(idsSansSignalSuffisant([{ id: 'a', dernier_signal_at: MAINTENANT, protocole_appli: 4 }], MAINTENANT, 5)).toEqual(['a']);
  });

  it('appli d’avant le protocole 4 : la règle ne la vise pas, rien à demander', () => {
    const lignes = [
      { id: 'ancienne', dernier_signal_at: avantS(600), protocole_appli: 3 },
      { id: 'jamais-vue', dernier_signal_at: null, protocole_appli: null },
      { id: 'nouvelle', dernier_signal_at: avantS(600), protocole_appli: 4 },
    ];
    expect(idsSansSignalSuffisant(lignes, MAINTENANT, 180)).toEqual(['nouvelle']);
  });
});

describe('contexte de la règle unique', () => {
  it('règle coupée (0) : aucune présence demandée, `connectes` inconnu', async () => {
    const t = monter({}, { seuilS: 0 });
    expect(await t.service.contexte([{ id: 'l', dernier_signal_at: null, protocole_appli: 4 }], MAINTENANT)).toEqual({
      appliFermeeApresS: 0,
      connectes: null,
    });
    expect(t.gateway.livreursConnectes).not.toHaveBeenCalled();
  });

  it('signes de vie récents : aucune question au serveur temps réel', async () => {
    const t = monter({});
    const contexte = await t.service.contexte([{ id: 'l', dernier_signal_at: avantS(20), protocole_appli: 4 }], MAINTENANT);
    expect(contexte.appliFermeeApresS).toBe(180);
    expect([...(contexte.connectes ?? [])]).toEqual([]);
    expect(t.gateway.livreursConnectes).not.toHaveBeenCalled();
  });

  it('présence demandée pour les seuls signes de vie insuffisants ; erreur du serveur temps réel : inconnue', async () => {
    const t = monter({}, { connectes: ['vieux'] });
    const contexte = await t.service.contexte(
      [
        { id: 'frais', dernier_signal_at: avantS(20), protocole_appli: 4 },
        { id: 'vieux', dernier_signal_at: avantS(900), protocole_appli: 4 },
      ],
      MAINTENANT,
    );
    expect(t.gateway.livreursConnectes).toHaveBeenCalledWith(['vieux']);
    expect([...(contexte.connectes ?? [])]).toEqual(['vieux']);

    t.gateway.livreursConnectes.mockRejectedValueOnce(new Error('Redis'));
    expect((await t.service.contexte([{ id: 'vieux', dernier_signal_at: null, protocole_appli: 4 }], MAINTENANT)).connectes).toBeNull();
  });

  it('estActive : signe de vie récent, socket, ou règle coupée', async () => {
    const recent = livreur({ dernier_signal_at: avantS(60) });
    const ferme = livreur({ dernier_signal_at: avantS(181) });
    const socket = livreur({ dernier_signal_at: avantS(3600) });
    const t = monter({ livreurs: [recent, ferme, socket] }, { connectes: [socket.id] });

    expect(await t.service.estActive(recent.id, MAINTENANT)).toBe(true);
    expect(await t.service.estActive(ferme.id, MAINTENANT)).toBe(false);
    expect(await t.service.estActive(socket.id, MAINTENANT)).toBe(true);
    expect(await t.service.estActive('inconnu', MAINTENANT)).toBe(true);
    t.etat.seuilS = 0;
    expect(await t.service.estActive(ferme.id, MAINTENANT)).toBe(true);
  });

  it('contexteSelection : présence des seuls livreurs en service, actifs, du restaurant, au signe de vie insuffisant', async () => {
    const vieux = livreur({ dernier_signal_at: avantS(900) });
    const frais = livreur({ dernier_signal_at: avantS(10) });
    const horsService = livreur({ dernier_signal_at: null, last_available_at: null });
    const suspendu = livreur({ dernier_signal_at: null, status: DelivererStatus.SUSPENDED });
    const ailleurs = livreur({ dernier_signal_at: null, restaurant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    const t = monter({ livreurs: [vieux, frais, horsService, suspendu, ailleurs] }, { connectes: [vieux.id] });

    const contexte = await t.service.contexteSelection(vieux.restaurant_id, MAINTENANT);

    expect(t.gateway.livreursConnectes).toHaveBeenCalledWith([vieux.id]);
    expect([...(contexte.connectes ?? [])]).toEqual([vieux.id]);
  });
});

describe('passages au journal (tâche de 10 s)', () => {
  it('appli fermée : APPLI_FERMEE une seule fois, avec le dernier signe de vie ; rien pour l’appli active', async () => {
    const ferme = livreur({ dernier_signal_at: avantS(200) });
    const active = livreur({ dernier_signal_at: avantS(20) });
    const t = monter({ livreurs: [ferme, active] });

    expect(await t.service.suivrePassages(MAINTENANT)).toBe(1);
    expect(await t.service.suivrePassages(MAINTENANT)).toBe(0);

    expect(t.passages()).toEqual([
      expect.objectContaining({
        type: 'APPLI_FERMEE',
        source: 'serveur',
        deliverer_id: ferme.id,
        restaurant_id: ferme.restaurant_id,
        details: {
          appli_vue_a: avantS(200).toISOString(),
          seuil_s: 180,
          en_service: true,
          en_pause: false,
          en_course: false,
          presence_connue: true,
        },
      }),
    ]);
    expect(t.verrous).toContainEqual([CLASSE_VERROU_SUIVI_APPLIS]);
  });

  it('réouverture par un signe de vie : APPLI_ACTIVE avec l’heure de la fermeture, une seule fois', async () => {
    const l = livreur({ dernier_signal_at: avantS(400) });
    const t = monter({ livreurs: [l] });
    await t.service.suivrePassages(MAINTENANT);
    const fermeeA = t.passages()[0].created_at as Date;

    // Une minute plus tard, il rouvre l'appli : position reçue.
    const plusTard = apresS(60);
    jest.setSystemTime(plusTard);
    l.dernier_signal_at = plusTard;
    expect(await t.service.suivrePassages(plusTard)).toBe(1);
    expect(await t.service.suivrePassages(plusTard)).toBe(0);

    expect(t.passages().map((p) => p.type)).toEqual(['APPLI_FERMEE', 'APPLI_ACTIVE']);
    expect(t.passages()[1].details).toMatchObject({
      fermee_a: fermeeA.toISOString(),
      par: 'signal',
      appli_vue_a: plusTard.toISOString(),
    });
  });

  it('réouverture par le socket seul : APPLI_ACTIVE « par socket »', async () => {
    const l = livreur({ dernier_signal_at: avantS(400) });
    const t = monter({ livreurs: [l] });
    await t.service.suivrePassages(MAINTENANT);

    t.etat.connectes = [l.id];
    expect(await t.service.suivrePassages(MAINTENANT)).toBe(1);
    expect(t.passages()[1]).toMatchObject({ type: 'APPLI_ACTIVE', details: expect.objectContaining({ par: 'socket' }) });
  });

  it('fermée, rouverte, refermée : chaque passage est écrit', async () => {
    const l = livreur({ dernier_signal_at: avantS(400) });
    const t = monter({ livreurs: [l] });
    await t.service.suivrePassages(MAINTENANT);
    jest.setSystemTime(apresS(10));
    l.dernier_signal_at = apresS(10);
    await t.service.suivrePassages(apresS(10));
    jest.setSystemTime(apresS(400));
    await t.service.suivrePassages(apresS(400));

    expect(t.passages().map((p) => p.type)).toEqual(['APPLI_FERMEE', 'APPLI_ACTIVE', 'APPLI_FERMEE']);
  });

  it('en course ou en pause : passage écrit aussi, avec l’état du livreur', async () => {
    const enCourse = livreur({ dernier_signal_at: avantS(300), last_available_at: null });
    const enPause = livreur({ dernier_signal_at: avantS(300), last_available_at: null, pause_until: apresS(600) });
    const t = monter({
      livreurs: [enCourse, enPause],
      courses: [course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: enCourse.id })],
    });

    expect(await t.service.suivrePassages(MAINTENANT)).toBe(2);
    const parLivreur = Object.fromEntries(t.passages().map((p) => [p.deliverer_id, p.details]));
    expect(parLivreur[enCourse.id]).toMatchObject({ en_course: true, en_service: false, en_pause: false });
    expect(parLivreur[enPause.id]).toMatchObject({ en_course: false, en_pause: true });
  });

  it('signe de vie de plus de 12 h, compte suspendu : hors du suivi', async () => {
    const ancien = livreur({ dernier_signal_at: new Date(MAINTENANT.getTime() - FENETRE_SUIVI_APPLIS_MS - 1000) });
    const suspendu = livreur({ dernier_signal_at: avantS(300), status: DelivererStatus.SUSPENDED });
    const t = monter({ livreurs: [ancien, suspendu] });

    expect(await t.service.suivrePassages(MAINTENANT)).toBe(0);
    expect(t.passages()).toEqual([]);
  });

  it('présence inconnue (Redis muet) : jugée sur le signe de vie, comme la règle ; noté au journal', async () => {
    const l = livreur({ dernier_signal_at: avantS(300) });
    const t = monter({ livreurs: [l] }, { connectes: null });

    await t.service.suivrePassages(MAINTENANT);
    expect(t.passages()[0]).toMatchObject({ type: 'APPLI_FERMEE', details: expect.objectContaining({ presence_connue: false }) });
  });

  it('deux serveurs en même temps : un seul relève (verrou), pas de doublon', async () => {
    const l = livreur({ dernier_signal_at: avantS(300) });
    const t = monter({ livreurs: [l] });
    const autre = appliLivreurSimulee(t.prisma, { connectes: [] });

    const [a, b] = await Promise.all([t.service.suivrePassages(MAINTENANT), autre.service.suivrePassages(MAINTENANT)]);

    expect(a + b).toBe(1);
    expect(t.passages()).toHaveLength(1);
  });

  it('règle coupée (0) : rien n’est relevé, aucune lecture', async () => {
    const l = livreur({ dernier_signal_at: avantS(3000) });
    const t = monter({ livreurs: [l] }, { seuilS: 0 });

    expect(await t.service.suivrePassages(MAINTENANT)).toBe(0);
    expect(t.prisma.deliverer.findMany).not.toHaveBeenCalled();
    expect(t.passages()).toEqual([]);
  });

  it('le dernier passage se relit au journal même après d’autres lignes du livreur', async () => {
    const l = livreur({ dernier_signal_at: avantS(300) });
    const t = monter({ livreurs: [l] });
    await t.service.suivrePassages(MAINTENANT);
    // D'autres lignes du journal pour ce livreur (offre close, pause…) ne comptent pas.
    t.journal.push({ id: 'x', type: 'OFFRE_CLOSE', deliverer_id: l.id, created_at: apresS(5) });

    expect(await t.service.suivrePassages(apresS(10))).toBe(0);
  });

  it('textes du journal : aucun tiret cadratin', async () => {
    const l = livreur({ dernier_signal_at: avantS(300) });
    const t = monter({ livreurs: [l] });
    await t.service.suivrePassages(MAINTENANT);
    expect(JSON.stringify(t.passages())).not.toMatch(/[—–]/);
  });
});
