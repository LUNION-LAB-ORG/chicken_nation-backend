import { HttpException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import type { PrismaService } from 'src/database/services/prisma.service';
import type { JsonWebTokenService } from 'src/json-web-token/json-web-token.service';
import type { OtpService } from 'src/modules/auth/otp/otp.service';
import type { TwilioService } from 'src/twilio/services/twilio.service';

import { AuthDelivererService } from './auth-deliverer.service';
import { creerTableTentativesSimulee } from './table-tentatives-simulee-spec';
import { TentativesLivreurService } from './tentatives-livreur.service';

// Comparaison réelle (on vérifie qu'elle n'est pas appelée sous verrou) ;
// empreinte du jeton de session simulée, pour ne pas payer bcrypt coût 12.
jest.mock('bcryptjs', () => {
  const reel = jest.requireActual('bcryptjs');
  return {
    ...reel,
    compare: jest.fn((...args: unknown[]) => reel.compare(...args)),
    hash: jest.fn(async () => 'empreinte'),
  };
});

const TELEPHONE = '+2250707000000';
const BON_CODE = '1234';
const MAUVAIS_CODE = '9999';
const HEURE = 60 * 60 * 1000;

const LIVREUR = {
  id: 'livreur-1',
  phone: TELEPHONE,
  password: jest.requireActual('bcryptjs').hashSync(BON_CODE, 4) as string,
  refresh_token: null,
  entity_status: EntityStatus.ACTIVE,
  deletion_scheduled_at: null,
  first_name: 'Awa',
};

/** Exécute l'appel et renvoie l'erreur HTTP levée (ou échoue s'il réussit). */
async function erreurDe(appel: Promise<unknown>): Promise<HttpException> {
  try {
    await appel;
  } catch (erreur) {
    return erreur as HttpException;
  }
  throw new Error("L'appel aurait dû échouer");
}

describe('AuthDelivererService (verrous et délais)', () => {
  let service: AuthDelivererService;
  let simulee: ReturnType<typeof creerTableTentativesSimulee>;
  let prisma: {
    otpVerificationAttempt: ReturnType<typeof creerTableTentativesSimulee>['table'];
    deliverer: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    otpToken: { findFirst: jest.Mock; deleteMany: jest.Mock };
  };
  let otpService: { generate: jest.Mock; getResendCooldownSeconds: jest.Mock };
  let twilio: { sendOtp: jest.Mock };
  let jwt: Record<string, jest.Mock>;

  beforeEach(() => {
    jest.clearAllMocks();
    simulee = creerTableTentativesSimulee();
    prisma = {
      otpVerificationAttempt: simulee.table,
      deliverer: {
        findUnique: jest.fn(async ({ where }) => (where.phone === TELEPHONE ? { ...LIVREUR } : null)),
        findFirst: jest.fn(async () => null),
        update: jest.fn(async ({ data }) => ({ ...LIVREUR, ...data, restaurant: null })),
      },
      otpToken: {
        findFirst: jest.fn(async () => null),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    otpService = {
      generate: jest.fn(async () => '4321'),
      getResendCooldownSeconds: jest.fn(async () => 0),
    };
    twilio = { sendOtp: jest.fn(async () => true) };
    jwt = {
      generateDelivererToken: jest.fn(async () => 'jeton-acces'),
      generateDelivererRefreshToken: jest.fn(async () => 'jeton-renouvellement'),
      generateDelivererVerifyToken: jest.fn(async () => 'jeton-verification'),
      generateDelivererResetToken: jest.fn(async () => 'jeton-reinitialisation'),
      verifyDelivererResetToken: jest.fn(async () => ({ phone: TELEPHONE, scope: 'reset' })),
    };

    const prismaService = prisma as unknown as PrismaService;
    service = new AuthDelivererService(
      prismaService,
      jwt as unknown as JsonWebTokenService,
      otpService as unknown as OtpService,
      twilio as unknown as TwilioService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      new TentativesLivreurService(prismaService),
    );
  });

  // ============================================================
  // CONNEXION
  // ============================================================

  describe('login', () => {
    const connexion = (password: string, phone = TELEPHONE) => service.login({ phone, password });

    it('garde 400 pour un mauvais code jusqu’au 5e, puis refuse en 429 sans comparer ni compter', async () => {
      for (let i = 1; i <= 5; i++) {
        const erreur = await erreurDe(connexion(MAUVAIS_CODE));
        expect(erreur.getStatus()).toBe(400);
        expect(erreur.message).toBe('Mot de passe invalide');
      }

      (bcrypt.compare as jest.Mock).mockClear();
      simulee.table.upsert.mockClear();

      const refus = await erreurDe(connexion(BON_CODE));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe('Trop de tentatives. Réessayez dans 15 minutes.');
      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(simulee.table.upsert).not.toHaveBeenCalled();
    });

    it('au 15e échec du jour, annonce tout de suite le verrou de 24 heures et ne compte pas les refus', async () => {
      const cle = `livreur-connexion:${TELEPHONE}`;
      const cleJour = `livreur-connexion-jour:${TELEPHONE}`;
      // Le quart d'heure s'écoule : on fait échoir le verrou de 15 minutes.
      const quartDHeurePlusTard = () => {
        simulee.lignes.get(cle)!.locked_until = new Date(Date.now() - 1);
      };

      for (let serie = 1; serie <= 3; serie++) {
        for (let i = 1; i <= 5; i++) {
          expect((await erreurDe(connexion(MAUVAIS_CODE))).getStatus()).toBe(400);
        }
        if (serie < 3) quartDHeurePlusTard();
      }

      // 15e échec : les deux verrous sont posés, le plus long est annoncé.
      const refus = await erreurDe(connexion(BON_CODE));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe('Trop de tentatives. Réessayez dans 24 heures.');

      // Le verrou de 15 minutes échu ne rouvre rien, et les refus ne comptent pas.
      quartDHeurePlusTard();
      const compteAvant = simulee.lignes.get(cle)!.failed_count;
      for (let i = 1; i <= 3; i++) {
        expect((await erreurDe(connexion(BON_CODE))).message).toBe(
          'Trop de tentatives. Réessayez dans 24 heures.',
        );
      }
      expect(simulee.lignes.get(cle)!.failed_count).toBe(compteAvant);
      expect(simulee.lignes.get(cleJour)!.failed_count).toBe(15);
      expect(bcrypt.compare).toHaveBeenCalledTimes(15);
    });

    it('numéro inconnu : 404 à chaque fois, sans rien écrire (aucun code comparé)', async () => {
      const inconnu = '+2250101010101';
      for (let i = 1; i <= 8; i++) {
        expect((await erreurDe(connexion(MAUVAIS_CODE, inconnu))).getStatus()).toBe(404);
      }
      expect(simulee.lignes.size).toBe(0);
      expect(simulee.table.upsert).not.toHaveBeenCalled();
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('compte inactif : garde son 401, sans être compté ni comparé', async () => {
      prisma.deliverer.findUnique.mockResolvedValue({ ...LIVREUR, entity_status: EntityStatus.INACTIVE });
      for (let i = 1; i <= 8; i++) {
        const erreur = await erreurDe(connexion(BON_CODE));
        expect(erreur.getStatus()).toBe(401);
        expect(erreur.message).toBe('Compte livreur inactif');
      }
      expect(simulee.lignes.size).toBe(0);
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('ne répond jamais 401 pour le verrou (l’appli y verrait une fin de session)', async () => {
      for (let i = 1; i <= 5; i++) await erreurDe(connexion(MAUVAIS_CODE));
      for (let i = 1; i <= 3; i++) {
        expect((await erreurDe(connexion(BON_CODE))).getStatus()).toBe(429);
      }
    });

    it('remet les deux compteurs à zéro après une connexion réussie, et garde la forme de la session', async () => {
      for (let i = 0; i < 4; i++) await erreurDe(connexion(MAUVAIS_CODE));
      expect(simulee.lignes.size).toBe(2);

      const session = await connexion(BON_CODE);
      expect(session).toEqual({
        deliverer: expect.objectContaining({ id: LIVREUR.id, phone: TELEPHONE }),
        token: 'jeton-acces',
        refreshToken: 'jeton-renouvellement',
      });
      expect(session.deliverer).not.toHaveProperty('password');
      expect(session.deliverer).not.toHaveProperty('refresh_token');
      expect(simulee.lignes.size).toBe(0);

      // Nouvelle série : on repart de 1, pas de 5.
      await erreurDe(connexion(MAUVAIS_CODE));
      expect(simulee.lignes.get(`livreur-connexion:${TELEPHONE}`)?.failed_count).toBe(1);
    });

    it('ne laisse comparer que 5 codes quand 30 requêtes arrivent en même temps', async () => {
      const resultats = await Promise.all(
        Array.from({ length: 30 }, () => erreurDe(connexion(MAUVAIS_CODE))),
      );
      const statuts = resultats.map((e) => e.getStatus());
      expect(statuts.filter((s) => s === 400)).toHaveLength(5);
      expect(statuts.filter((s) => s === 429)).toHaveLength(25);
      expect(bcrypt.compare).toHaveBeenCalledTimes(5);
    });

    it('verrouille 24 heures au 15e échec de la journée ; une réinitialisation par SMS lève le verrou', async () => {
      // 14 échecs déjà enregistrés aujourd'hui, fenêtre de 15 minutes vierge.
      simulee.lignes.set(`livreur-connexion-jour:${TELEPHONE}`, {
        id: 'jour',
        phone: `livreur-connexion-jour:${TELEPHONE}`,
        failed_count: 14,
        window_start: new Date(Date.now() - 2 * HEURE),
        locked_until: null,
        updated_at: new Date(),
      });

      expect((await erreurDe(connexion(MAUVAIS_CODE))).getStatus()).toBe(400);
      const refus = await erreurDe(connexion(BON_CODE));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe('Trop de tentatives. Réessayez dans 24 heures.');

      prisma.deliverer.findFirst.mockResolvedValue({ ...LIVREUR });
      const reinitialisation = await service.resetPassword({ resetToken: 'jeton', password: '5678' });
      expect(reinitialisation).toMatchObject({
        token: 'jeton-acces',
        refreshToken: 'jeton-renouvellement',
        message: 'Mot de passe réinitialisé avec succès',
      });
      expect(simulee.lignes.size).toBe(0);

      await expect(connexion(BON_CODE)).resolves.toMatchObject({ token: 'jeton-acces' });
    });
  });

  // ============================================================
  // VÉRIFICATION DES CODES REÇUS PAR SMS
  // ============================================================

  describe('vérification des codes', () => {
    const verifierInscription = (otp: string, phone = TELEPHONE) =>
      service.verifyRegistrationOtp({ phone, otp });
    const verifierReinitialisation = (otp: string, phone = TELEPHONE) =>
      service.verifyResetOtp({ phone, otp });

    it('mauvais code : 401 habituel ; au 6e essai, 429 sans chercher le code', async () => {
      for (let i = 1; i <= 5; i++) {
        const erreur = await erreurDe(verifierInscription(MAUVAIS_CODE));
        expect(erreur.getStatus()).toBe(401);
        expect(erreur.message).toBe('Code OTP invalide ou expiré');
      }
      prisma.otpToken.findFirst.mockClear();

      const refus = await erreurDe(verifierInscription(BON_CODE));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe('Trop de tentatives. Réessayez dans 15 minutes.');
      expect(prisma.otpToken.findFirst).not.toHaveBeenCalled();
    });

    it('partage un seul compteur entre inscription et réinitialisation, clé = téléphone nu', async () => {
      for (let i = 0; i < 3; i++) await erreurDe(verifierInscription(MAUVAIS_CODE));
      for (let i = 0; i < 2; i++) await erreurDe(verifierReinitialisation(MAUVAIS_CODE));

      expect((await erreurDe(verifierReinitialisation(BON_CODE))).getStatus()).toBe(429);
      expect((await erreurDe(verifierInscription(BON_CODE))).getStatus()).toBe(429);
      expect([...simulee.lignes.keys()]).toEqual([TELEPHONE]);
    });

    it('ne repart pas de zéro avec une autre graphie du numéro', async () => {
      for (let i = 0; i < 5; i++) await erreurDe(verifierInscription(MAUVAIS_CODE));
      expect((await erreurDe(verifierInscription(BON_CODE, '+225 07 07 00 00 00'))).getStatus()).toBe(
        429,
      );
    });

    it('bon code : consomme tous les codes du numéro, efface le compteur, garde { verifyToken }', async () => {
      await erreurDe(verifierInscription(MAUVAIS_CODE));
      prisma.otpToken.findFirst.mockResolvedValueOnce({ phone: TELEPHONE, code: BON_CODE });

      await expect(verifierInscription(BON_CODE)).resolves.toEqual({
        verifyToken: 'jeton-verification',
      });
      expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({ where: { phone: TELEPHONE } });
      expect(simulee.lignes.size).toBe(0);
    });

    it('bon code de réinitialisation : même consommation, garde { resetToken }', async () => {
      prisma.otpToken.findFirst.mockResolvedValueOnce({ phone: TELEPHONE, code: BON_CODE });

      await expect(verifierReinitialisation(BON_CODE)).resolves.toEqual({
        resetToken: 'jeton-reinitialisation',
      });
      expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({ where: { phone: TELEPHONE } });
    });
  });

  // ============================================================
  // DÉLAI ENTRE DEUX ENVOIS
  // ============================================================

  describe('envoi des codes', () => {
    it('inscription : refuse en 429 dans le délai, sans générer ni envoyer', async () => {
      otpService.getResendCooldownSeconds.mockResolvedValueOnce(42);

      const refus = await erreurDe(service.registerPhone({ phone: TELEPHONE }));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe("Un code vient d'être envoyé. Réessayez dans 42 secondes.");
      expect(otpService.getResendCooldownSeconds).toHaveBeenCalledWith(TELEPHONE, 60_000);
      expect(otpService.generate).not.toHaveBeenCalled();
      expect(twilio.sendOtp).not.toHaveBeenCalled();
    });

    it('inscription : le numéro déjà pris répond 409 avant le délai', async () => {
      prisma.deliverer.findFirst.mockResolvedValueOnce({ ...LIVREUR });
      expect((await erreurDe(service.registerPhone({ phone: TELEPHONE }))).getStatus()).toBe(409);
      expect(otpService.getResendCooldownSeconds).not.toHaveBeenCalled();
    });

    it('inscription hors délai : envoie et garde la forme de réponse', async () => {
      await expect(service.registerPhone({ phone: TELEPHONE })).resolves.toEqual({
        phone: TELEPHONE,
        message: 'Code OTP envoyé',
      });
      expect(twilio.sendOtp).toHaveBeenCalledWith({ phoneNumber: TELEPHONE, otp: '4321' });
    });

    it('mot de passe oublié : 404 avant le délai, puis 429 dans le délai', async () => {
      expect((await erreurDe(service.forgotPassword({ phone: TELEPHONE }))).getStatus()).toBe(404);
      expect(otpService.getResendCooldownSeconds).not.toHaveBeenCalled();

      prisma.deliverer.findFirst.mockResolvedValue({ ...LIVREUR });
      otpService.getResendCooldownSeconds.mockResolvedValueOnce(1);
      const refus = await erreurDe(service.forgotPassword({ phone: TELEPHONE }));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe("Un code vient d'être envoyé. Réessayez dans 1 seconde.");
      expect(otpService.generate).not.toHaveBeenCalled();

      await expect(service.forgotPassword({ phone: TELEPHONE })).resolves.toEqual({
        phone: TELEPHONE,
        message: 'Code OTP envoyé',
      });
    });

    it('envoi impossible : retire le code créé pour ne pas bloquer la nouvelle tentative, puis 500', async () => {
      twilio.sendOtp.mockResolvedValueOnce(false);

      const erreur = await erreurDe(service.registerPhone({ phone: TELEPHONE }));
      expect(erreur.getStatus()).toBe(500);
      expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
        where: { phone: TELEPHONE, code: '4321' },
      });
    });
  });
});
