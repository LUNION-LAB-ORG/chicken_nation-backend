import { HttpException } from '@nestjs/common';

import {
  CLE_ENVOIS_ETRANGER,
  CLE_ENVOIS_ETRANGER_CONNUS,
  CLE_ENVOIS_NOUVEAUX,
  cleDelaiEnvoi,
  cleEnvoisNumero,
  FENETRE_ENVOIS_MS,
  MAX_ENVOIS_PAR_NUMERO,
  MESSAGE_TROP_DE_CODES_GLOBAL,
  MESSAGE_TROP_DE_CODES_NUMERO,
} from '../helpers/envois-otp.helper';
import { EnvoisOtpService } from './envois-otp.service';
import { creerRedisSimule } from './redis-envois-simule-spec';

const DELAI_MS = 30_000;
const IVOIRIEN = '+2250707000000';

/** Numéro ivoirien distinct pour chaque `n` (numéros inventés d'un script). */
const ivoirien = (n: number) => `+22507${String(n).padStart(8, '0')}`;
const etranger = (n: number) => `+3361${String(n).padStart(7, '0')}`;

async function erreurDe(appel: Promise<unknown>): Promise<HttpException> {
  try {
    await appel;
  } catch (erreur) {
    return erreur as HttpException;
  }
  throw new Error("L'appel aurait dû être refusé");
}

describe('EnvoisOtpService', () => {
  const envInitial = { ...process.env };
  let redis: ReturnType<typeof creerRedisSimule>;
  let service: EnvoisOtpService;
  let journal: jest.SpyInstance;

  const reserver = (telephone: string, compteConnu = false) =>
    service.reserver({ telephone, compteConnu, delaiMs: DELAI_MS });

  beforeEach(() => {
    delete process.env.OTP_ENVOIS_MAX_PAR_HEURE;
    delete process.env.OTP_ENVOIS_ETRANGER_MAX_PAR_HEURE;
    redis = creerRedisSimule();
    service = new EnvoisOtpService(redis.client);
    journal = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    process.env = envInitial;
  });

  describe('délai entre deux envois', () => {
    it('refuse un second envoi au même numéro dans le délai, sans rien compter', async () => {
      await reserver(IVOIRIEN);
      redis.avancer(12_000);

      const refus = await erreurDe(reserver(IVOIRIEN));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe("Un code vient d'être envoyé. Réessayez dans 18 secondes.");
      expect(redis.valeur(cleEnvoisNumero(IVOIRIEN))).toBe('1');
      expect(redis.valeur(CLE_ENVOIS_NOUVEAUX)).toBe('1');
    });

    it('une autre graphie du numéro tombe sur le même délai', async () => {
      await reserver('+225 07 07 00 00 00');
      expect((await erreurDe(reserver('2250707000000'))).getStatus()).toBe(429);
    });

    it('rafale de 10 demandes simultanées au même numéro : une seule passe', async () => {
      const resultats = await Promise.allSettled(Array.from({ length: 10 }, () => reserver(IVOIRIEN)));
      expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(redis.valeur(cleEnvoisNumero(IVOIRIEN))).toBe('1');
    });

    it('passe de nouveau une fois le délai écoulé', async () => {
      await reserver(IVOIRIEN);
      redis.avancer(DELAI_MS);
      await expect(reserver(IVOIRIEN)).resolves.toBeUndefined();
    });
  });

  describe('plafond par numéro', () => {
    it(`${MAX_ENVOIS_PAR_NUMERO} codes par heure, puis 429 ; le refus ne garde ni compteur ni délai`, async () => {
      for (let i = 0; i < MAX_ENVOIS_PAR_NUMERO; i++) {
        await reserver(IVOIRIEN, true);
        redis.avancer(DELAI_MS);
      }

      const refus = await erreurDe(reserver(IVOIRIEN, true));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe(MESSAGE_TROP_DE_CODES_NUMERO);
      expect(redis.valeur(cleEnvoisNumero(IVOIRIEN))).toBe(String(MAX_ENVOIS_PAR_NUMERO));
      expect(redis.valeur(cleDelaiEnvoi(IVOIRIEN))).toBeNull();
    });

    it("repart de zéro une heure après le premier envoi (la clé expire d'elle-même)", async () => {
      for (let i = 0; i < MAX_ENVOIS_PAR_NUMERO; i++) {
        await reserver(IVOIRIEN, true);
        redis.avancer(DELAI_MS);
      }
      expect(redis.resteMs(cleEnvoisNumero(IVOIRIEN))).toBeGreaterThan(0);

      redis.avancer(FENETRE_ENVOIS_MS);
      await expect(reserver(IVOIRIEN, true)).resolves.toBeUndefined();
      expect(redis.valeur(cleEnvoisNumero(IVOIRIEN))).toBe('1');
    });
  });

  describe('plafond commun des numéros inconnus', () => {
    beforeEach(() => {
      process.env.OTP_ENVOIS_MAX_PAR_HEURE = '3';
    });

    it('refuse le numéro inventé de trop, sans lui laisser de compteur', async () => {
      for (let n = 1; n <= 3; n++) await reserver(ivoirien(n));

      const refus = await erreurDe(reserver(ivoirien(4)));
      expect(refus.getStatus()).toBe(429);
      expect(refus.message).toBe(MESSAGE_TROP_DE_CODES_GLOBAL);
      expect(redis.valeur(cleEnvoisNumero(ivoirien(4)))).toBe('0');
      expect(redis.valeur(CLE_ENVOIS_NOUVEAUX)).toBe('3');
      expect(redis.valeur(cleDelaiEnvoi(ivoirien(4)))).toBeNull();
      // Journalisé une fois, pas à chaque refus.
      await erreurDe(reserver(ivoirien(5)));
      expect(journal).toHaveBeenCalledTimes(1);
    });

    it("n'empêche pas un client connu de recevoir son code", async () => {
      for (let n = 1; n <= 3; n++) await reserver(ivoirien(n));
      await expect(reserver(IVOIRIEN, true)).resolves.toBeUndefined();
      expect(redis.valeur(CLE_ENVOIS_NOUVEAUX)).toBe('3');
    });

    it('rafale de 20 numéros inventés simultanés : exactement 3 passent', async () => {
      const resultats = await Promise.allSettled(
        Array.from({ length: 20 }, (_, n) => reserver(ivoirien(100 + n))),
      );
      expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      // Les refus ont rendu ce qu'ils avaient pris.
      expect(redis.valeur(CLE_ENVOIS_NOUVEAUX)).toBe('3');
    });

    it('le compteur commun a toujours une expiration, même rendu après expiration', async () => {
      await reserver(ivoirien(1));
      expect(redis.resteMs(CLE_ENVOIS_NOUVEAUX)).toBeGreaterThan(0);

      // Fenêtre écoulée entre l'incrément et le retour : un DECR seul
      // recréerait la clé à -1 pour toujours.
      redis.avancer(FENETRE_ENVOIS_MS);
      await (service as any).rendre([CLE_ENVOIS_NOUVEAUX], cleDelaiEnvoi(ivoirien(1)));
      expect(redis.resteMs(CLE_ENVOIS_NOUVEAUX)).toBeGreaterThan(0);
    });
  });

  describe('numéros étrangers', () => {
    beforeEach(() => {
      process.env.OTP_ENVOIS_ETRANGER_MAX_PAR_HEURE = '2';
    });

    it('plafond commun plus serré, réglable, qui vaut aussi pour un compte connu', async () => {
      await reserver(etranger(1));
      await reserver(etranger(2));
      expect((await erreurDe(reserver(etranger(3)))).message).toBe(MESSAGE_TROP_DE_CODES_GLOBAL);
      expect(redis.valeur(CLE_ENVOIS_ETRANGER)).toBe('2');

      await reserver(etranger(4), true);
      await reserver(etranger(5), true);
      expect((await erreurDe(reserver(etranger(6), true))).message).toBe(MESSAGE_TROP_DE_CODES_GLOBAL);
      expect(redis.valeur(CLE_ENVOIS_ETRANGER_CONNUS)).toBe('2');
    });

    it('des numéros étrangers inventés ne bloquent pas les clients étrangers connus', async () => {
      await reserver(etranger(1));
      await reserver(etranger(2));
      for (let n = 3; n <= 5; n++) expect((await erreurDe(reserver(etranger(n)))).getStatus()).toBe(429);
      expect(redis.valeur(CLE_ENVOIS_ETRANGER)).toBe('2');
      await expect(reserver(etranger(100), true)).resolves.toBeUndefined();
      expect(redis.valeur(CLE_ENVOIS_ETRANGER_CONNUS)).toBe('1');
    });

    it("n'entame pas les envois vers la Côte d'Ivoire", async () => {
      await reserver(etranger(1));
      await reserver(etranger(2));
      await erreurDe(reserver(etranger(3)));
      await expect(reserver(ivoirien(1))).resolves.toBeUndefined();
      expect(redis.valeur(CLE_ENVOIS_ETRANGER)).toBe('2');
    });

    it('20 par heure par défaut', async () => {
      delete process.env.OTP_ENVOIS_ETRANGER_MAX_PAR_HEURE;
      for (let n = 1; n <= 20; n++) await reserver(etranger(n));
      expect((await erreurDe(reserver(etranger(21)))).getStatus()).toBe(429);
    });
  });

  describe('Redis indisponible', () => {
    it("laisse partir le code et journalise l'erreur", async () => {
      redis.panne(true);
      await expect(reserver(IVOIRIEN)).resolves.toBeUndefined();
      await expect(reserver(IVOIRIEN)).resolves.toBeUndefined();
      expect(journal).toHaveBeenCalled();
    });

    it("panne au milieu des compteurs : le code part, ce qui est compté le reste", async () => {
      redis.espions.multi.mockImplementationOnce(() => {
        throw new Error('Connection is closed.');
      });
      await expect(reserver(IVOIRIEN)).resolves.toBeUndefined();
      expect(journal).toHaveBeenCalled();
    });
  });

  describe('encadrerEnvoi', () => {
    const demande = { telephone: IVOIRIEN, compteConnu: false, delaiMs: DELAI_MS };

    it("renvoie le résultat de l'envoi", async () => {
      await expect(service.encadrerEnvoi(demande, async () => 'parti')).resolves.toBe('parti');
      expect(redis.valeur(cleDelaiEnvoi(IVOIRIEN))).toBe('1');
    });

    it("refus des plafonds : l'envoi n'est pas exécuté", async () => {
      const envoi = jest.fn(async () => 'parti');
      await service.encadrerEnvoi(demande, envoi);
      expect((await erreurDe(service.encadrerEnvoi(demande, envoi))).getStatus()).toBe(429);
      expect(envoi).toHaveBeenCalledTimes(1);
    });

    it('envoi impossible : lève le délai, garde les compteurs', async () => {
      const echec = await erreurDe(
        service.encadrerEnvoi(demande, async () => {
          throw new HttpException("Envoi de l'OTP impossible", 500);
        }),
      );
      expect(echec.getStatus()).toBe(500);
      expect(redis.valeur(cleDelaiEnvoi(IVOIRIEN))).toBeNull();
      expect(redis.valeur(cleEnvoisNumero(IVOIRIEN))).toBe('1');

      await expect(service.encadrerEnvoi(demande, async () => 'parti')).resolves.toBe('parti');
    });

    it('erreur inattendue (base) : lève aussi le délai', async () => {
      await erreurDe(
        service.encadrerEnvoi(demande, async () => {
          throw new Error('base indisponible');
        }),
      );
      expect(redis.valeur(cleDelaiEnvoi(IVOIRIEN))).toBeNull();
    });

    it("refus 429 de l'envoi (délai en base) : garde le délai", async () => {
      await erreurDe(
        service.encadrerEnvoi(demande, async () => {
          throw new HttpException("Un code vient d'être envoyé. Réessayez dans 5 secondes.", 429);
        }),
      );
      expect(redis.valeur(cleDelaiEnvoi(IVOIRIEN))).toBe('1');
    });
  });
});
