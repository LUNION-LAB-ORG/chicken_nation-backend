/**
 * APPEL À TURBO BORNÉ DANS LE TEMPS (relecture du 23/10).
 *
 * Sans délai, `fetch` attend jusqu'à 5 min les en-têtes d'un Turbo muet ; le
 * planificateur v2, qui confie la course à Turbo pendant son passage, tenait
 * pendant tout ce temps le verrou du restaurant et la file des passages de
 * TOUS les restaurants. L'appel de création est maintenant interrompu au bout
 * de 10 s : issue incertaine, déjà gérée (la course reste sous-traitée, la
 * cloche sonne, jamais de second livreur). Aucun appel réel : `fetch` simulé.
 */
import { DeliveryService, OrderStatus } from '@prisma/client';

import { DELAI_APPEL_TURBO_MS, TurboService } from './turbo.service';

// Horloge simulée : rien n'attend vraiment, mais une machine très chargée
// (suite complète en parallèle) peut dépasser les 5 s par défaut.
jest.setTimeout(30_000);

describe('TurboService : appel de création borné', () => {
  const fetchOrigine = global.fetch;
  let signaux: (AbortSignal | undefined)[];

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    signaux = [];
    // Turbo muet : ne répond jamais, sauf si la requête est interrompue.
    global.fetch = jest.fn((_url: unknown, init?: RequestInit) => {
      signaux.push(init?.signal ?? undefined);
      return new Promise((_resoudre, rejeter) => {
        init?.signal?.addEventListener('abort', () => rejeter(init.signal!.reason ?? new Error('abort')));
      });
    }) as never;
  });
  afterEach(() => {
    global.fetch = fetchOrigine;
    jest.useRealTimers();
  });

  function service() {
    const commande = {
      id: 'o1',
      reference: 'CMD-1',
      status: OrderStatus.READY,
      delivery_service: DeliveryService.TURBO,
      address: JSON.stringify({ latitude: 5.3, longitude: -3.99 }),
      fullname: 'Client',
      phone: '0700000000',
      email: null,
      zone_id: null,
      paiements: [],
      amount: 5000,
      delivery_fee: 1000,
      delivery_fee_base: 1000,
      paied: true,
      restaurant: { id: 'r1', name: 'Zone 4', latitude: 5.286, longitude: -3.9737 },
    };
    const prisma = {
      course: {
        findUnique: jest.fn(async () => ({
          id: 'k1',
          reference: 'CRS-1',
          pickup_code: '421',
          restaurant: commande.restaurant,
          deliveries: [{ order: commande }],
        })),
      },
    };
    const cloche = { sendTurboDispatchFailedBell: jest.fn(async () => undefined) };
    return { turbo: new TurboService(prisma as never, cloche as never), cloche };
  }

  it('Turbo muet : interrompu après 10 s, issue incertaine (jamais de repli interne)', async () => {
    const { turbo, cloche } = service();
    let fini = false;
    const envoi = turbo.creerCourseGroupe({ courseId: 'k1', apikey: 'cle' }).finally(() => (fini = true));
    await jest.advanceTimersByTimeAsync(DELAI_APPEL_TURBO_MS - 100);
    expect(fini).toBe(false);
    expect(signaux[0]).toBeDefined();

    await jest.advanceTimersByTimeAsync(200);
    await expect(envoi).resolves.toEqual({ sentOrderIds: [], response: null, uncertain: true });
    expect(cloche.sendTurboDispatchFailedBell).toHaveBeenCalledTimes(1);
  });

  it('Turbo répond : rien ne change (groupe créé)', async () => {
    const { turbo } = service();
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ groupeId: 'g1' }) })) as never;
    await expect(turbo.creerCourseGroupe({ courseId: 'k1', apikey: 'cle' })).resolves.toMatchObject({ sentOrderIds: ['o1'] });
  });
});
