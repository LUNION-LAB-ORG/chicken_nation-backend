import { HttpException } from '@nestjs/common';
import type { PrismaService } from 'src/database/services/prisma.service';

import {
  POLITIQUE_CODE,
  POLITIQUE_CONNEXION_JOUR,
} from '../helpers/tentatives-livreur.helper';
import { creerTableTentativesSimulee } from './table-tentatives-simulee-spec';
import { TentativesLivreurService } from './tentatives-livreur.service';

const MINUTE = 60 * 1000;
const T0 = new Date('2026-09-25T10:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
const CLE = '+2250707000000';

/** Lance `reserver` et renvoie le rang, ou l'erreur levée. */
async function tenter(service: TentativesLivreurService, maintenant: Date) {
  try {
    return await service.reserver(CLE, POLITIQUE_CODE, maintenant);
  } catch (erreur) {
    return erreur as HttpException;
  }
}

describe('TentativesLivreurService', () => {
  let service: TentativesLivreurService;
  let simulee: ReturnType<typeof creerTableTentativesSimulee>;

  beforeEach(() => {
    simulee = creerTableTentativesSimulee();
    const prisma = { otpVerificationAttempt: simulee.table } as unknown as PrismaService;
    service = new TentativesLivreurService(prisma);
  });

  it('compte les tentatives une à une', async () => {
    expect(await service.reserver(CLE, POLITIQUE_CODE, T0)).toBe(1);
    expect(await service.reserver(CLE, POLITIQUE_CODE, plus(1000))).toBe(2);
    expect(simulee.lignes.get(CLE)?.failed_count).toBe(2);
  });

  it('refuse la 6e tentative en 429 avec un message en français, et pose le verrou', async () => {
    for (let i = 0; i < 5; i++) await service.reserver(CLE, POLITIQUE_CODE, T0);

    const refus = await tenter(service, T0);
    expect(refus).toBeInstanceOf(HttpException);
    expect((refus as HttpException).getStatus()).toBe(429);
    expect((refus as HttpException).message).toBe('Trop de tentatives. Réessayez dans 15 minutes.');
    expect(simulee.lignes.get(CLE)?.locked_until).toEqual(plus(15 * MINUTE));
  });

  it('ne laisse passer que 5 requêtes sur 50 lancées en même temps', async () => {
    const resultats = await Promise.all(Array.from({ length: 50 }, () => tenter(service, T0)));

    const rangs = resultats.filter((r): r is number => typeof r === 'number');
    const refus = resultats.filter((r) => r instanceof HttpException) as HttpException[];
    expect(rangs.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(refus).toHaveLength(45);
    expect(refus.every((e) => e.getStatus() === 429)).toBe(true);
  });

  it('pose le verrou au 5e échec : la tentative suivante est refusée sans être comptée', async () => {
    for (let rang = 1; rang <= 5; rang++) {
      const r = await service.reserver(CLE, POLITIQUE_CODE, T0);
      await service.constaterEchec(CLE, r, POLITIQUE_CODE, T0);
    }
    expect(simulee.lignes.get(CLE)?.locked_until).toEqual(plus(15 * MINUTE));

    simulee.table.upsert.mockClear();
    const refus = await tenter(service, plus(5 * MINUTE));
    expect((refus as HttpException).getStatus()).toBe(429);
    expect((refus as HttpException).message).toBe('Trop de tentatives. Réessayez dans 10 minutes.');
    expect(simulee.table.upsert).not.toHaveBeenCalled();
  });

  it('ne pose pas de verrou avant le plafond', async () => {
    const r = await service.reserver(CLE, POLITIQUE_CODE, T0);
    await service.constaterEchec(CLE, r, POLITIQUE_CODE, T0);
    expect(simulee.table.updateMany).not.toHaveBeenCalled();
    expect(simulee.lignes.get(CLE)?.locked_until).toBeNull();
  });

  it('repart de zéro une fois le verrou échu', async () => {
    for (let rang = 1; rang <= 5; rang++) {
      const r = await service.reserver(CLE, POLITIQUE_CODE, T0);
      await service.constaterEchec(CLE, r, POLITIQUE_CODE, T0);
    }
    expect(await service.reserver(CLE, POLITIQUE_CODE, plus(15 * MINUTE))).toBe(1);
    expect(simulee.lignes.get(CLE)?.locked_until).toBeNull();
  });

  it('repart de zéro quand la fenêtre de 15 minutes est écoulée', async () => {
    for (let i = 0; i < 4; i++) await service.reserver(CLE, POLITIQUE_CODE, T0);
    expect(await service.reserver(CLE, POLITIQUE_CODE, plus(16 * MINUTE))).toBe(1);
    expect(simulee.lignes.get(CLE)?.window_start).toEqual(plus(16 * MINUTE));
  });

  it('garde le verrou de 24 heures jusqu’à son terme', async () => {
    for (let rang = 1; rang <= 15; rang++) {
      const r = await service.reserver(CLE, POLITIQUE_CONNEXION_JOUR, T0);
      await service.constaterEchec(CLE, r, POLITIQUE_CONNEXION_JOUR, T0);
    }
    const refus = await service
      .reserver(CLE, POLITIQUE_CONNEXION_JOUR, plus(30 * MINUTE))
      .catch((e: HttpException) => e);
    expect((refus as HttpException).getStatus()).toBe(429);
    expect((refus as HttpException).message).toBe('Trop de tentatives. Réessayez dans 24 heures.');
  });

  describe('verifierVerrous', () => {
    const JOUR = 'livreur-connexion-jour:+2250707000000';

    it('laisse passer sans rien compter quand aucune clé n’est verrouillée', async () => {
      await service.reserver(CLE, POLITIQUE_CODE, T0);
      await expect(service.verifierVerrous([CLE, JOUR], T0)).resolves.toBeUndefined();
      expect(simulee.lignes.get(CLE)?.failed_count).toBe(1);
      expect(simulee.lignes.has(JOUR)).toBe(false);
    });

    it('annonce le verrou le plus long parmi les clés', async () => {
      for (let rang = 1; rang <= 5; rang++) {
        const r = await service.reserver(CLE, POLITIQUE_CODE, T0);
        await service.constaterEchec(CLE, r, POLITIQUE_CODE, T0);
      }
      for (let rang = 1; rang <= 15; rang++) {
        const r = await service.reserver(JOUR, POLITIQUE_CONNEXION_JOUR, T0);
        await service.constaterEchec(JOUR, r, POLITIQUE_CONNEXION_JOUR, T0);
      }

      const refus = await service.verifierVerrous([CLE, JOUR], plus(MINUTE)).catch((e) => e);
      expect((refus as HttpException).getStatus()).toBe(429);
      expect((refus as HttpException).message).toBe('Trop de tentatives. Réessayez dans 24 heures.');
    });

    it('ignore un verrou échu', async () => {
      for (let rang = 1; rang <= 5; rang++) {
        const r = await service.reserver(CLE, POLITIQUE_CODE, T0);
        await service.constaterEchec(CLE, r, POLITIQUE_CODE, T0);
      }
      await expect(service.verifierVerrous([CLE], plus(15 * MINUTE))).resolves.toBeUndefined();
    });
  });

  it('efface le compteur après un succès', async () => {
    await service.reserver(CLE, POLITIQUE_CODE, T0);
    await service.reserver('livreur-connexion:+2250101010101', POLITIQUE_CODE, T0);
    await service.effacer(CLE, 'livreur-connexion:+2250101010101');
    expect(simulee.lignes.size).toBe(0);
  });

  it('n’échoue pas si la remise à zéro rencontre une erreur de base', async () => {
    simulee.table.deleteMany.mockRejectedValueOnce(new Error('base indisponible'));
    await expect(service.effacer(CLE)).resolves.toBeUndefined();
  });

  it('recommence l’incrément quand deux créations simultanées se heurtent (P2002)', async () => {
    await service.reserver(CLE, POLITIQUE_CODE, T0);
    simulee.table.upsert.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    expect(await service.reserver(CLE, POLITIQUE_CODE, T0)).toBe(2);
  });

  it('laisse remonter les autres erreurs de base', async () => {
    simulee.table.upsert.mockRejectedValueOnce(new Error('base indisponible'));
    await expect(service.reserver(CLE, POLITIQUE_CODE, T0)).rejects.toThrow('base indisponible');
  });
});
