import { HttpException } from '@nestjs/common';
import { EntityStatus } from '@prisma/client';
import type { Cache } from 'cache-manager';
import type { PrismaService } from 'src/database/services/prisma.service';
import type { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';
import type { OtpService } from 'src/modules/auth/otp/otp.service';
import type { TwilioService } from 'src/twilio/services/twilio.service';
import { creerTableTentativesSimulee } from 'src/modules/auth-deliverer/services/table-tentatives-simulee-spec';
import { TentativesLivreurService } from 'src/modules/auth-deliverer/services/tentatives-livreur.service';

import {
  CLE_ENVOIS_NOUVEAUX,
  cleDelaiEnvoi,
  MESSAGE_NUMERO_INVALIDE,
  MESSAGE_TROP_DE_CODES_GLOBAL,
} from '../helpers/envois-otp.helper';
import { EnvoisOtpService } from '../otp/envois-otp.service';
import { creerRedisSimule } from '../otp/redis-envois-simule-spec';
import { AuthService } from './auth.service';

const TELEPHONE = '+2250707000000';
const BON_CODE = '1234';
const MAUVAIS_CODE = '9999';

/** Graphies du même numéro : chacune ouvrait ses propres 5 essais. */
const GRAPHIES = [
  '+2250707000000',
  '2250707000000',
  '+225 07 07 00 00 00',
  '+225-07-07-00-00-00',
  '002250707000000',
  '0707000000',
];

interface Client {
  id: string;
  phone: string;
  entity_status: EntityStatus;
  last_login_at: Date | null;
}

async function erreurDe(appel: Promise<unknown>): Promise<HttpException> {
  try {
    await appel;
  } catch (erreur) {
    return erreur as HttpException;
  }
  throw new Error("L'appel aurait dû échouer");
}

describe('AuthService, connexion des clients par code', () => {
  const envInitial = { ...process.env };
  let service: AuthService;
  let simulee: ReturnType<typeof creerTableTentativesSimulee>;
  let redis: ReturnType<typeof creerRedisSimule>;
  let clients: Map<string, Client>;
  let prisma: {
    otpVerificationAttempt: ReturnType<typeof creerTableTentativesSimulee>['table'];
    customer: { findFirst: jest.Mock; update: jest.Mock; create: jest.Mock };
    otpToken: { findFirst: jest.Mock; deleteMany: jest.Mock };
  };
  let otpService: { generate: jest.Mock; getResendCooldownSeconds: jest.Mock };
  let twilio: { sendOtp: jest.Mock };

  const ajouterClient = (phone: string, last_login_at: Date | null = new Date('2026-09-01')) => {
    const client: Client = {
      id: `client-${clients.size + 1}`,
      phone,
      entity_status: EntityStatus.ACTIVE,
      last_login_at,
    };
    clients.set(client.id, client);
    return client;
  };

  beforeEach(() => {
    delete process.env.OTP_ENVOIS_MAX_PAR_HEURE;
    delete process.env.OTP_ENVOIS_ETRANGER_MAX_PAR_HEURE;
    simulee = creerTableTentativesSimulee();
    redis = creerRedisSimule();
    clients = new Map();
    prisma = {
      otpVerificationAttempt: simulee.table,
      customer: {
        findFirst: jest.fn(async ({ where }) => {
          const trouve = [...clients.values()].find((c) => where.phone.in.includes(c.phone));
          return trouve ? { ...trouve } : null;
        }),
        update: jest.fn(async ({ where, data }) => {
          const client = clients.get(where.id)!;
          Object.assign(client, data);
          return { ...client };
        }),
        create: jest.fn(async ({ data }) => ({
          ...ajouterClient(data.phone, null),
        })),
      },
      otpToken: {
        findFirst: jest.fn(async () => null),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    otpService = {
      generate: jest.fn(async () => BON_CODE),
      getResendCooldownSeconds: jest.fn(async () => 0),
    };
    twilio = { sendOtp: jest.fn(async () => true) };

    const prismaService = prisma as unknown as PrismaService;
    const envois = new EnvoisOtpService(redis.client);
    service = new AuthService(
      prismaService,
      { generateCustomerToken: jest.fn(async () => 'jeton-client') } as unknown as JsonWebTokenService,
      otpService as unknown as OtpService,
      twilio as unknown as TwilioService,
      {} as Cache,
      envois,
      new TentativesLivreurService(prismaService),
    );
    // Les journaux attendus (plafond atteint, Redis coupé) n'encombrent pas la sortie.
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    jest.spyOn((envois as any).logger, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    process.env = envInitial;
  });

  // ============================================================
  // VÉRIFICATION DU CODE
  // ============================================================

  describe('verifyOtp', () => {
    const verifier = (otp: string, phone = TELEPHONE) => service.verifyOtp({ phone, otp });

    it('toutes les graphies du numéro partagent les mêmes 5 essais', async () => {
      for (let i = 0; i < 5; i++) {
        const erreur = await erreurDe(verifier(MAUVAIS_CODE, GRAPHIES[i]));
        expect(erreur.getStatus()).toBe(401);
        expect(erreur.message).toBe('Code OTP invalide');
      }
      prisma.otpToken.findFirst.mockClear();

      for (const graphie of GRAPHIES) {
        const refus = await erreurDe(verifier(BON_CODE, graphie));
        expect(refus.getStatus()).toBe(429);
        expect(refus.message).toBe('Trop de tentatives. Réessayez dans 15 minutes.');
      }
      expect(prisma.otpToken.findFirst).not.toHaveBeenCalled();
      expect([...simulee.lignes.keys()]).toEqual([TELEPHONE]);
    });

    it('cherche le code sous la clé canonique et ses graphies héritées, pas sous la saisie brute', async () => {
      await erreurDe(verifier(MAUVAIS_CODE, '07 07 00 00 00'));
      expect(prisma.otpToken.findFirst).toHaveBeenCalledWith({
        where: {
          code: MAUVAIS_CODE,
          phone: { in: [TELEPHONE, TELEPHONE.slice(1)] },
          expire: { gte: expect.any(Date) },
        },
      });
    });

    it('au 5e échec : verrou posé et codes en cours du numéro retirés', async () => {
      for (let i = 0; i < 4; i++) await erreurDe(verifier(MAUVAIS_CODE));
      expect(prisma.otpToken.deleteMany).not.toHaveBeenCalled();

      await erreurDe(verifier(MAUVAIS_CODE));
      expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
        where: { phone: { in: [TELEPHONE, TELEPHONE.slice(1)] } },
      });
      expect(simulee.lignes.get(TELEPHONE)?.locked_until?.getTime()).toBeGreaterThan(Date.now());
    });

    it('rafale de 30 essais simultanés sous des graphies variées : 5 codes cherchés seulement', async () => {
      const resultats = await Promise.all(
        Array.from({ length: 30 }, (_, i) => erreurDe(verifier(MAUVAIS_CODE, GRAPHIES[i % GRAPHIES.length]))),
      );
      const statuts = resultats.map((e) => e.getStatus());
      expect(statuts.filter((s) => s === 401)).toHaveLength(5);
      expect(statuts.filter((s) => s === 429)).toHaveLength(25);
      expect(prisma.otpToken.findFirst).toHaveBeenCalledTimes(5);
    });

    it('bon code : jeton, codes consommés, compteur effacé', async () => {
      const client = ajouterClient(TELEPHONE, null);
      await erreurDe(verifier(MAUVAIS_CODE));
      prisma.otpToken.findFirst.mockResolvedValueOnce({ phone: TELEPHONE, code: BON_CODE });

      const reponse = await verifier(BON_CODE, '+225 07 07 00 00 00');
      expect(reponse).toMatchObject({ id: client.id, phone: TELEPHONE, token: 'jeton-client' });
      expect(reponse).not.toHaveProperty('entity_status');
      expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({ where: { phone: TELEPHONE } });
      expect(clients.get(client.id)?.last_login_at).toBeInstanceOf(Date);
      expect(simulee.lignes.size).toBe(0);
    });

    it.each([['+225707000000'], ['+0707000000'], ['12345678']])(
      'numéro inexploitable %p : 400 sans compter ni chercher',
      async (phone) => {
        const erreur = await erreurDe(verifier(MAUVAIS_CODE, phone));
        expect(erreur.getStatus()).toBe(400);
        expect(erreur.message).toBe(MESSAGE_NUMERO_INVALIDE);
        expect(simulee.table.upsert).not.toHaveBeenCalled();
        expect(prisma.otpToken.findFirst).not.toHaveBeenCalled();
      },
    );
  });

  // ============================================================
  // DEMANDE DE CODE
  // ============================================================

  describe('loginCustomer', () => {
    it('numéro inexploitable : 400, sans rien lire, compter ni créer', async () => {
      const erreur = await erreurDe(service.loginCustomer('+225707000000'));
      expect(erreur.getStatus()).toBe(400);
      expect(erreur.message).toBe(MESSAGE_NUMERO_INVALIDE);
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
      expect(redis.espions.set).not.toHaveBeenCalled();
      expect(prisma.customer.create).not.toHaveBeenCalled();
      expect(twilio.sendOtp).not.toHaveBeenCalled();
    });

    it('numéro inconnu : compté parmi les inconnus, compte créé sous la forme canonique, code envoyé', async () => {
      await expect(service.loginCustomer('07 07 00 00 00')).resolves.toEqual({
        phone: TELEPHONE,
        message: 'Code envoyé par SMS',
      });
      expect(prisma.customer.create).toHaveBeenCalledWith({ data: { phone: TELEPHONE } });
      expect(twilio.sendOtp).toHaveBeenCalledWith({ phoneNumber: TELEPHONE, otp: BON_CODE });
      expect(redis.valeur(CLE_ENVOIS_NOUVEAUX)).toBe('1');
    });

    it('plafond commun atteint : refuse un numéro inconnu sans créer de compte, laisse passer un client connu', async () => {
      process.env.OTP_ENVOIS_MAX_PAR_HEURE = '1';
      await service.loginCustomer('+2250101010101');
      prisma.customer.create.mockClear();
      twilio.sendOtp.mockClear();

      const refus = await erreurDe(service.loginCustomer('+2250505050505'));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe(MESSAGE_TROP_DE_CODES_GLOBAL);
      expect(prisma.customer.create).not.toHaveBeenCalled();
      expect(otpService.generate).toHaveBeenCalledTimes(1);
      expect(twilio.sendOtp).not.toHaveBeenCalled();

      ajouterClient(TELEPHONE);
      await expect(service.loginCustomer(TELEPHONE)).resolves.toMatchObject({ phone: TELEPHONE });
      expect(twilio.sendOtp).toHaveBeenCalledTimes(1);
    });

    it('un compte créé par une simple demande (jamais connecté) reste compté parmi les inconnus', async () => {
      ajouterClient(TELEPHONE, null);
      await service.loginCustomer(TELEPHONE);
      expect(redis.valeur(CLE_ENVOIS_NOUVEAUX)).toBe('1');
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it('client connu : ni plafond commun ni création', async () => {
      ajouterClient(TELEPHONE);
      await service.loginCustomer(TELEPHONE);
      expect(redis.valeur(CLE_ENVOIS_NOUVEAUX)).toBeNull();
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it('délai de 30 s : la seconde demande est refusée avant toute écriture, sous une autre graphie aussi', async () => {
      await service.loginCustomer(TELEPHONE);
      const refus = await erreurDe(service.loginCustomer('+225 07 07 00 00 00'));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toMatch(/^Un code vient d'être envoyé\. Réessayez dans (30|29) secondes\.$/);
      expect(prisma.customer.create).toHaveBeenCalledTimes(1);
      expect(otpService.generate).toHaveBeenCalledTimes(1);
    });

    it('rafale de demandes simultanées pour un numéro inconnu : un seul compte, un seul code', async () => {
      const resultats = await Promise.allSettled(
        Array.from({ length: 10 }, () => service.loginCustomer(TELEPHONE)),
      );
      expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(prisma.customer.create).toHaveBeenCalledTimes(1);
      expect(twilio.sendOtp).toHaveBeenCalledTimes(1);
    });

    it('envoi impossible : 500, code retiré, délai levé pour la nouvelle tentative', async () => {
      twilio.sendOtp.mockResolvedValueOnce(false);

      const erreur = await erreurDe(service.loginCustomer(TELEPHONE));
      expect(erreur.getStatus()).toBe(500);
      expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
        where: { phone: TELEPHONE, code: BON_CODE },
      });
      expect(redis.valeur(cleDelaiEnvoi(TELEPHONE))).toBeNull();

      await expect(service.loginCustomer(TELEPHONE)).resolves.toMatchObject({ phone: TELEPHONE });
    });

    it('Redis indisponible : le code part quand même, le délai en base reste en place', async () => {
      redis.panne(true);
      await expect(service.loginCustomer(TELEPHONE)).resolves.toMatchObject({ phone: TELEPHONE });

      otpService.getResendCooldownSeconds.mockResolvedValueOnce(25);
      const refus = await erreurDe(service.loginCustomer(TELEPHONE));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe("Un code vient d'être envoyé. Réessayez dans 25 secondes.");
      expect(twilio.sendOtp).toHaveBeenCalledTimes(1);
    });

    it('graphie héritée sans « + » : retrouvée et réécrite sous la forme canonique', async () => {
      const client = ajouterClient('2250707000000');
      await expect(service.loginCustomer(TELEPHONE)).resolves.toMatchObject({ phone: TELEPHONE });
      expect(clients.get(client.id)?.phone).toBe(TELEPHONE);
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });
  });
});
