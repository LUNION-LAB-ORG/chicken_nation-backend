/**
 * Appli du livreur active ou fermée (demande du 24/10 : « c'est lorsqu'il
 * ferme la fenêtre que ça ne doit pas passer »).
 *
 * Le VRAI service sur la base simulée : contexte de la règle unique (présence
 * demandée seulement pour les signes de vie qui ne suffisent pas).
 */
import { DelivererStatus } from '@prisma/client';

import { livreur, monterBaseDispatch } from 'src/modules/course/services/base-dispatch.simulee-spec';

import { appliLivreurSimulee } from './base-livreurs.simulee-spec';
import { MARGE_PRESENCE_MS, idsSansSignalSuffisant } from './appli-livreur.service';

const MAINTENANT = new Date('2026-10-24T12:00:00.000Z');
const avantS = (s: number, depuis = MAINTENANT) => new Date(depuis.getTime() - s * 1000);

type OptionsAppli = Parameters<typeof appliLivreurSimulee>[1];

function monter(donnees: Parameters<typeof monterBaseDispatch>[0], appli: OptionsAppli = { connectes: [] }) {
  const base = monterBaseDispatch(donnees);
  const a = appliLivreurSimulee(base.prisma, appli);
  return { ...base, ...a };
}

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

describe('idsSansSignalSuffisant (présence à demander)', () => {
  it('signe de vie absent, trop vieux ou qui le sera dans les 10 s : présence demandée', () => {
    expect(MARGE_PRESENCE_MS).toBe(10_000);
    const lignes = [
      { id: 'frais', dernier_signal_at: avantS(30) },
      { id: 'limite-marge', dernier_signal_at: avantS(169) },
      { id: 'dans-la-marge', dernier_signal_at: avantS(170) },
      { id: 'vieux', dernier_signal_at: avantS(600) },
      { id: 'jamais', dernier_signal_at: null },
    ];
    expect(idsSansSignalSuffisant(lignes, MAINTENANT, 180)).toEqual(['dans-la-marge', 'vieux', 'jamais']);
  });

  it('seuil plus court que la marge : présence demandée pour tous', () => {
    expect(idsSansSignalSuffisant([{ id: 'a', dernier_signal_at: MAINTENANT }], MAINTENANT, 5)).toEqual(['a']);
  });
});

describe('contexte de la règle unique', () => {
  it('règle coupée (0) : aucune présence demandée, `connectes` inconnu', async () => {
    const t = monter({}, { seuilS: 0 });
    expect(await t.service.contexte([{ id: 'l', dernier_signal_at: null }], MAINTENANT)).toEqual({
      appliFermeeApresS: 0,
      connectes: null,
    });
    expect(t.gateway.livreursConnectes).not.toHaveBeenCalled();
  });

  it('signes de vie récents : aucune question au serveur temps réel', async () => {
    const t = monter({});
    const contexte = await t.service.contexte([{ id: 'l', dernier_signal_at: avantS(20) }], MAINTENANT);
    expect(contexte.appliFermeeApresS).toBe(180);
    expect([...(contexte.connectes ?? [])]).toEqual([]);
    expect(t.gateway.livreursConnectes).not.toHaveBeenCalled();
  });

  it('présence demandée pour les seuls signes de vie insuffisants ; erreur du serveur temps réel : inconnue', async () => {
    const t = monter({}, { connectes: ['vieux'] });
    const contexte = await t.service.contexte(
      [
        { id: 'frais', dernier_signal_at: avantS(20) },
        { id: 'vieux', dernier_signal_at: avantS(900) },
      ],
      MAINTENANT,
    );
    expect(t.gateway.livreursConnectes).toHaveBeenCalledWith(['vieux']);
    expect([...(contexte.connectes ?? [])]).toEqual(['vieux']);

    t.gateway.livreursConnectes.mockRejectedValueOnce(new Error('Redis'));
    expect((await t.service.contexte([{ id: 'vieux', dernier_signal_at: null }], MAINTENANT)).connectes).toBeNull();
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
