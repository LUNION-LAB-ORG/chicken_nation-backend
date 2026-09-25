import { BadRequestException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { EntityStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import type { Cache } from 'cache-manager';
import { PrismaService } from 'src/database/services/prisma.service';
import { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';
import { OtpService } from 'src/modules/auth/otp/otp.service';
import { TwilioService } from 'src/twilio/services/twilio.service';
import { AuthService } from './auth.service';
import { MESSAGE_COMPTE_DESACTIVE } from '../helpers/staff-account-status.helper';
import {
  MAX_ECHECS_CONNEXION,
  MESSAGE_IDENTIFIANTS_INCORRECTS,
  cleEchecsConnexion,
} from '../helpers/connexion-echecs.helper';

const MOT_DE_PASSE = 'Caisse2026!';
// Coût 4 : le test compare vraiment, sans ralentir la suite.
const HACHE = bcrypt.hashSync(MOT_DE_PASSE, 4);
const EMAIL = 'caisse@chicken-nation.com';

function membre(entity_status: EntityStatus) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: EMAIL,
    password: HACHE,
    role: UserRole.CAISSIER,
    entity_status,
  };
}

/** Cache en mémoire, au comportement de cache-manager (get, set, del). */
function fauxCache() {
  const donnees = new Map<string, unknown>();
  return {
    donnees,
    cache: {
      get: jest.fn(async (cle: string) => donnees.get(cle)),
      set: jest.fn(async (cle: string, valeur: unknown) => {
        donnees.set(cle, valeur);
        return valeur;
      }),
      del: jest.fn(async (cle: string) => donnees.delete(cle)),
    },
  };
}

function monter(utilisateur: ReturnType<typeof membre> | null) {
  const user = {
    findUnique: jest.fn().mockResolvedValue(utilisateur),
    update: jest.fn().mockResolvedValue(utilisateur),
  };
  const jwt = {
    generateToken: jest.fn().mockResolvedValue('jeton'),
    generateRefreshToken: jest.fn().mockResolvedValue('jeton-rafraichissement'),
  };
  const { cache, donnees } = fauxCache();
  const service = new AuthService(
    { user } as unknown as PrismaService,
    jwt as unknown as JsonWebTokenService,
    {} as OtpService,
    {} as TwilioService,
    cache as unknown as Cache,
  );
  // Les avertissements de connexion ne doivent pas encombrer la sortie du test.
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  return { service, user, jwt, cache, donnees };
}

async function erreurDe(promesse: Promise<unknown>): Promise<HttpException> {
  try {
    await promesse;
  } catch (e) {
    return e as HttpException;
  }
  throw new Error('La connexion aurait dû être refusée');
}

describe('AuthService.login, statut du compte', () => {
  it('connecte un compte actif sans réécrire son statut', async () => {
    const { service, user } = monter(membre(EntityStatus.ACTIVE));

    const res = await service.login({ email: EMAIL, password: MOT_DE_PASSE }, '10.0.0.1');

    expect(res.token).toBe('jeton');
    expect(res).not.toHaveProperty('password');
    const data = user.update.mock.calls[0][0].data;
    expect(data.last_login_at).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('entity_status');
  });

  it('promeut un compte hérité NEW en ACTIVE', async () => {
    const { service, user } = monter(membre(EntityStatus.NEW));

    await service.login({ email: EMAIL, password: MOT_DE_PASSE });

    expect(user.update.mock.calls[0][0].data.entity_status).toBe(EntityStatus.ACTIVE);
  });

  it.each([EntityStatus.INACTIVE, EntityStatus.DELETED])(
    'refuse un compte %s (403) sans le réactiver ni émettre de jeton',
    async (statut) => {
      const { service, user, jwt } = monter(membre(statut));

      const err = await erreurDe(service.login({ email: EMAIL, password: MOT_DE_PASSE }));

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toBe(MESSAGE_COMPTE_DESACTIVE);
      expect(user.update).not.toHaveBeenCalled();
      expect(jwt.generateToken).not.toHaveBeenCalled();
    },
  );

  it('ne révèle pas la suspension à qui n’a pas le mot de passe', async () => {
    const { service } = monter(membre(EntityStatus.INACTIVE));

    const err = await erreurDe(service.login({ email: EMAIL, password: 'Mauvais2026!' }));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(MESSAGE_IDENTIFIANTS_INCORRECTS);
  });
});

describe('AuthService.login, identifiants et verrou par email', () => {
  it('répond pareil pour un email inconnu et un mauvais mot de passe', async () => {
    const inconnu = await erreurDe(
      monter(null).service.login({ email: 'personne@chicken-nation.com', password: MOT_DE_PASSE }),
    );
    const mauvais = await erreurDe(
      monter(membre(EntityStatus.ACTIVE)).service.login({ email: EMAIL, password: 'Mauvais2026!' }),
    );

    expect(inconnu).toBeInstanceOf(BadRequestException);
    expect(mauvais).toBeInstanceOf(BadRequestException);
    expect(inconnu.getResponse()).toEqual(mauvais.getResponse());
  });

  it(`verrouille l'email au ${MAX_ECHECS_CONNEXION}e échec, même avec le bon mot de passe ensuite`, async () => {
    const { service, jwt } = monter(membre(EntityStatus.ACTIVE));

    for (let i = 1; i < MAX_ECHECS_CONNEXION; i++) {
      const err = await erreurDe(service.login({ email: EMAIL, password: 'Mauvais2026!' }));
      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
    const dernier = await erreurDe(service.login({ email: EMAIL, password: 'Mauvais2026!' }));
    expect(dernier.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(dernier.message).toBe('Trop de tentatives de connexion. Réessayez dans 15 minutes.');

    const bonMotDePasse = await erreurDe(
      service.login({ email: EMAIL.toUpperCase(), password: MOT_DE_PASSE }),
    );
    expect(bonMotDePasse.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(jwt.generateToken).not.toHaveBeenCalled();
  });

  it('compte aussi les échecs sur un email inconnu (le verrou ne trahit pas les comptes)', async () => {
    const { service, donnees } = monter(null);

    await erreurDe(service.login({ email: 'personne@chicken-nation.com', password: MOT_DE_PASSE }));

    expect(donnees.get(cleEchecsConnexion('personne@chicken-nation.com'))).toMatchObject({ echecs: 1 });
  });

  it('remet le compteur à zéro après une connexion réussie', async () => {
    const { service, donnees } = monter(membre(EntityStatus.ACTIVE));

    await erreurDe(service.login({ email: EMAIL, password: 'Mauvais2026!' }));
    expect(donnees.has(cleEchecsConnexion(EMAIL))).toBe(true);

    await service.login({ email: EMAIL, password: MOT_DE_PASSE });
    expect(donnees.has(cleEchecsConnexion(EMAIL))).toBe(false);
  });

  it('laisse se connecter quand le cache est en panne', async () => {
    const { service, cache } = monter(membre(EntityStatus.ACTIVE));
    cache.get.mockRejectedValue(new Error('Redis indisponible'));
    cache.del.mockRejectedValue(new Error('Redis indisponible'));

    const res = await service.login({ email: EMAIL, password: MOT_DE_PASSE });

    expect(res.token).toBe('jeton');
  });

  it('laisse se connecter quand le cache ne répond plus (commandes en attente)', async () => {
    const { service, cache } = monter(membre(EntityStatus.ACTIVE));
    const jamais = () => new Promise<never>(() => undefined);
    cache.get.mockImplementation(jamais);
    cache.del.mockImplementation(jamais);

    const res = await service.login({ email: EMAIL, password: MOT_DE_PASSE });

    expect(res.token).toBe('jeton');
  }, 10_000);
});

describe('AuthService.login, essais simultanés sur un même email', () => {
  it(`n'essaie pas plus de ${MAX_ECHECS_CONNEXION} mots de passe, même lancés en parallèle`, async () => {
    const { service, user } = monter(membre(EntityStatus.ACTIVE));

    const reponses = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        service.login({ email: EMAIL, password: 'Mauvais2026!' }),
      ),
    );

    // Le verrou est contrôlé avant la recherche du compte : chaque recherche
    // correspond à un mot de passe réellement comparé.
    expect(user.findUnique).toHaveBeenCalledTimes(MAX_ECHECS_CONNEXION);
    const statuts = reponses.map((r) =>
      r.status === 'rejected' ? (r.reason as HttpException).getStatus() : 200,
    );
    expect(statuts.filter((s) => s === HttpStatus.BAD_REQUEST)).toHaveLength(MAX_ECHECS_CONNEXION - 1);
    expect(statuts.filter((s) => s === HttpStatus.TOO_MANY_REQUESTS)).toHaveLength(
      30 - (MAX_ECHECS_CONNEXION - 1),
    );
    expect((service as any).essaisParEmail.taille).toBe(0);
  });

  it('ne fait pas attendre les autres emails', async () => {
    const { service, cache } = monter(membre(EntityStatus.ACTIVE));
    let liberer: () => void = () => undefined;
    // Le premier essai de l'autre email reste bloqué dans le cache.
    cache.get.mockImplementationOnce(
      () => new Promise((r) => (liberer = () => r(undefined))),
    );
    const bloque = service.login({ email: 'autre@chicken-nation.com', password: MOT_DE_PASSE });

    const res = await service.login({ email: EMAIL, password: MOT_DE_PASSE });

    expect(res.token).toBe('jeton');
    liberer();
    await bloque;
  });
});

describe('AuthService.login, journal', () => {
  it('neutralise un email piégé avant de l’écrire', async () => {
    const { service } = monter(null);
    const warn = (service as any).logger.warn as jest.Mock;

    await erreurDe(
      service.login(
        { email: 'x@y.z\n[Nest] LOG connexion réussie', password: MOT_DE_PASSE },
        '1.2.3.4, 203.0.113.9',
      ),
    );

    const ligne = warn.mock.calls[0][0] as string;
    expect(ligne).not.toContain('\n');
    expect(ligne).toContain('x@y.z?[Nest] LOG connexion réussie');
    expect(ligne).toContain('depuis 1.2.3.4, 203.0.113.9');
  });
});
