/**
 * Flux OAuth HubRise, de la demande de connexion au retour.
 *
 * Ce qui compte ici : AUCUN échange de code (donc aucun jeton obtenu) avant
 * que le `state` signé, le nonce à usage unique, l'utilisateur et le
 * restaurant soient vérifiés ; aucune liaison écrasée ; un jeton refusé
 * révoqué, sauf s'il sert déjà à un autre restaurant.
 *
 * Prisma, les paramètres, le cache et `fetch` sont simulés.
 */

import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EntityStatus, UserRole } from '@prisma/client';
import { HUBRISE_OAUTH } from '../constants/hubrise-endpoints.constant';
import { HubriseAuthService } from './hubrise-auth.service';

const fetchOrigine = global.fetch;
afterAll(() => {
  global.fetch = fetchOrigine;
});

const RESTAURANT = '3f2b8c1e-5d4a-4b7e-9c10-2a6f8e0d1b23';
const AUTRE_RESTAURANT = '9a1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
const ADMIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const LOCATION = '3r4s3-0';
const JETON = 'jeton-hubrise-neuf';

type Options = {
  role?: UserRole;
  statut?: EntityStatus;
  restaurantExiste?: boolean;
  /** Restaurant qui détient déjà la location (autre que RESTAURANT). */
  locationChez?: string | null;
  /** Résultat de l'écriture conditionnelle. */
  compteEcrit?: number;
  /** Restaurant qui détient déjà le jeton renvoyé par HubRise. */
  jetonChez?: string | null;
  reponseJeton?: Record<string, unknown>;
  cacheEnPanne?: boolean;
};

const monter = (o: Options = {}) => {
  const magasin = new Map<string, unknown>();
  const cache = {
    set: jest.fn(async (cle: string, valeur: unknown) => {
      if (!o.cacheEnPanne) magasin.set(cle, valeur);
      return valeur;
    }),
    get: jest.fn(async (cle: string) => magasin.get(cle)),
    del: jest.fn(async (cle: string) => magasin.delete(cle)),
  };

  const prisma = {
    restaurant: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('hubrise_access_token' in where) {
          return o.jetonChez ? { id: o.jetonChez } : null;
        }
        if ('hubrise_location_id' in where) {
          return o.locationChez ? { id: o.locationChez } : null;
        }
        return o.restaurantExiste === false ? null : { id: where.id };
      }),
      updateMany: jest.fn(async () => ({ count: o.compteEcrit ?? 1 })),
    },
    user: {
      findUnique: jest.fn(async () => ({
        id: ADMIN,
        role: o.role ?? UserRole.ADMIN,
        entity_status: o.statut ?? EntityStatus.ACTIVE,
      })),
    },
  };

  const settings = {
    getManyOrEnv: jest.fn(async () => ({
      hubrise_client_id: 'client-id',
      hubrise_client_secret: 'client-secret',
      base_url: 'https://api.exemple/api/v1',
    })),
  };

  const config = {
    get: jest.fn((cle: string) =>
      cle === 'HUBRISE_STATE_SECRET' ? 'une-cle-de-test-de-trente-deux-caracteres-au-moins' : undefined,
    ),
  };

  const fetchSimule = jest.fn(async (url: string) => {
    if (url === HUBRISE_OAUTH.TOKEN) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          o.reponseJeton ?? { access_token: JETON, location_id: LOCATION, location_name: 'Test' },
        text: async () => '',
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
  (global as unknown as { fetch: unknown }).fetch = fetchSimule;

  const service = new HubriseAuthService(
    settings as never,
    prisma as never,
    config as never,
    cache as never,
  );
  (service as unknown as { logger: unknown }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const appels = (url: string) => fetchSimule.mock.calls.filter(([u]) => u === url).length;
  return { service, prisma, cache, fetchSimule, appels };
};

/** Demande l'URL, en extrait le `state` signé. */
const demanderState = async (service: HubriseAuthService) => {
  const url = await service.getAuthorizationUrl(RESTAURANT, ADMIN);
  const state = new URL(url).searchParams.get('state');
  if (!state) throw new Error('state absent');
  return state;
};

describe('HubriseAuthService.getAuthorizationUrl', () => {
  it('rend une URL HubRise avec un state signé, jamais l’identifiant en clair', async () => {
    const { service } = monter();
    const url = await service.getAuthorizationUrl(RESTAURANT, ADMIN);
    expect(url.startsWith(`${HUBRISE_OAUTH.AUTHORIZE}?`)).toBe(true);
    const state = new URL(url).searchParams.get('state');
    expect(state).not.toBe(RESTAURANT);
    expect(state?.split('.')).toHaveLength(6);
  });

  it('refuse un identifiant de restaurant qui n’est pas un UUID', async () => {
    const { service } = monter();
    await expect(service.getAuthorizationUrl('restaurant-x', ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuse un restaurant introuvable ou supprimé', async () => {
    const { service } = monter({ restaurantExiste: false });
    await expect(service.getAuthorizationUrl(RESTAURANT, ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('répond 503 si le nonce n’a pas pu être posé (cache indisponible)', async () => {
    const { service } = monter({ cacheEnPanne: true });
    await expect(service.getAuthorizationUrl(RESTAURANT, ADMIN)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('HubriseAuthService.traiterRetour : rien n’est échangé avant les contrôles', () => {
  it('refus sur HubRise : motif refuse, aucun échange', async () => {
    const { service, appels } = monter();
    const state = await demanderState(service);
    await expect(
      service.traiterRetour({ error: 'access_denied', state }),
    ).resolves.toEqual({ ok: false, motif: 'refuse' });
    expect(appels(HUBRISE_OAUTH.TOKEN)).toBe(0);
  });

  it('ancien state en clair (identifiant du restaurant) : lien_invalide, aucun échange', async () => {
    const { service, appels, prisma } = monter();
    await expect(service.traiterRetour({ code: 'abc', state: RESTAURANT })).resolves.toEqual({
      ok: false,
      motif: 'lien_invalide',
    });
    expect(appels(HUBRISE_OAUTH.TOKEN)).toBe(0);
    expect(prisma.restaurant.updateMany).not.toHaveBeenCalled();
  });

  it('code absent ou d’un autre type : lien_invalide, aucun échange', async () => {
    const { service, appels } = monter();
    const state = await demanderState(service);
    for (const code of [undefined, '', ['a', 'b'], 'x'.repeat(513)]) {
      await expect(service.traiterRetour({ code, state })).resolves.toEqual({
        ok: false,
        motif: 'lien_invalide',
      });
    }
    expect(appels(HUBRISE_OAUTH.TOKEN)).toBe(0);
  });

  it('lien rejoué : le second retour est refusé (nonce à usage unique)', async () => {
    const { service, appels } = monter();
    const state = await demanderState(service);
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: true,
      accessToken: JETON,
    });
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: false,
      motif: 'lien_invalide',
    });
    expect(appels(HUBRISE_OAUTH.TOKEN)).toBe(1);
  });

  it('utilisateur passé en lecture seule entre-temps : droit_insuffisant, aucun échange', async () => {
    const { service, appels } = monter({ role: UserRole.MARKETING });
    const state = await demanderState(service);
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: false,
      motif: 'droit_insuffisant',
    });
    expect(appels(HUBRISE_OAUTH.TOKEN)).toBe(0);
  });

  it('utilisateur désactivé entre-temps : droit_insuffisant, aucun échange', async () => {
    const { service, appels } = monter({ statut: EntityStatus.INACTIVE });
    const state = await demanderState(service);
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: false,
      motif: 'droit_insuffisant',
    });
    expect(appels(HUBRISE_OAUTH.TOKEN)).toBe(0);
  });
});

describe('HubriseAuthService.traiterRetour : écriture et révocation', () => {
  it('succès : écriture CONDITIONNELLE (restaurant libre ou déjà sur cette location)', async () => {
    const { service, prisma, appels } = monter();
    const state = await demanderState(service);
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: true,
      accessToken: JETON,
    });
    expect(prisma.restaurant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: RESTAURANT,
          OR: [{ hubrise_location_id: null }, { hubrise_location_id: LOCATION }],
        }),
      }),
    );
    expect(appels(HUBRISE_OAUTH.REVOKE)).toBe(0);
  });

  it('location déjà reliée à un autre restaurant : deja_relie, rien écrit, jeton neuf révoqué', async () => {
    const { service, prisma, appels } = monter({ locationChez: AUTRE_RESTAURANT });
    const state = await demanderState(service);
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: false,
      motif: 'deja_relie',
    });
    expect(prisma.restaurant.updateMany).not.toHaveBeenCalled();
    expect(appels(HUBRISE_OAUTH.REVOKE)).toBe(1);
  });

  it('restaurant déjà relié à une autre location : deja_relie, jeton neuf révoqué', async () => {
    const { service, appels } = monter({ compteEcrit: 0 });
    const state = await demanderState(service);
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: false,
      motif: 'deja_relie',
    });
    expect(appels(HUBRISE_OAUTH.REVOKE)).toBe(1);
  });

  it('jeton renvoyé déjà utilisé par l’autre restaurant : refus SANS révocation', async () => {
    // HubRise peut renvoyer le jeton d'une connexion existante : le révoquer
    // couperait la liaison légitime de l'autre restaurant.
    const { service, appels } = monter({
      locationChez: AUTRE_RESTAURANT,
      jetonChez: AUTRE_RESTAURANT,
    });
    const state = await demanderState(service);
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: false,
      motif: 'deja_relie',
    });
    expect(appels(HUBRISE_OAUTH.REVOKE)).toBe(0);
  });

  it('jeton sans location : echec, rien écrit, jeton révoqué', async () => {
    const { service, prisma, appels } = monter({ reponseJeton: { access_token: JETON } });
    const state = await demanderState(service);
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: false,
      motif: 'echec',
    });
    expect(prisma.restaurant.updateMany).not.toHaveBeenCalled();
    expect(appels(HUBRISE_OAUTH.REVOKE)).toBe(1);
  });

  it('écriture en erreur après l’échange : echec et jeton révoqué', async () => {
    const { service, prisma, appels } = monter();
    prisma.restaurant.updateMany.mockRejectedValueOnce(new Error('base injoignable'));
    const state = await demanderState(service);
    await expect(service.traiterRetour({ code: 'abc', state })).resolves.toEqual({
      ok: false,
      motif: 'echec',
    });
    expect(appels(HUBRISE_OAUTH.REVOKE)).toBe(1);
  });
});
