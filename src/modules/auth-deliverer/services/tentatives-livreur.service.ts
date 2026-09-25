import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';

import {
  PolitiqueTentatives,
  debutFenetreValide,
  depassePlafond,
  doitVerrouiller,
  estPerime,
  finBlocage,
  messageTropDeTentatives,
  resteBlocageMs,
} from '../helpers/tentatives-livreur.helper';

/**
 * Compteur de tentatives par clé (téléphone, avec ou sans préfixe), rangé
 * dans la table OtpVerificationAttempt. Voir `tentatives-livreur.helper.ts`
 * pour les clés et les seuils.
 *
 * Déroulé attendu par l'appelant :
 *  1. `reserver` AVANT de juger la tentative : elle est comptée tout de suite,
 *     de façon atomique, et refusée en 429 si le plafond est dépassé ;
 *  2. `constaterEchec` si la tentative échoue : pose le verrou au plafond ;
 *  3. `effacer` si elle réussit : remet le compteur à zéro.
 *
 * Pourquoi compter avant : le mécanisme client lit le compte puis le réécrit,
 * si bien que cent requêtes simultanées n'enregistrent qu'un échec. Ici,
 * l'incrément est fait par la base (`failed_count = failed_count + 1`) et
 * chaque requête reçoit son propre rang.
 *
 * Toute erreur de base remonte : sans compteur, on ne juge pas la tentative.
 */
@Injectable()
export class TentativesLivreurService {
  private readonly logger = new Logger(TentativesLivreurService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Refuse en 429 si l'une des clés est verrouillée, en annonçant le verrou
   * le plus long. Ne compte rien.
   *
   * À appeler avant `reserver` quand une tentative dépend de plusieurs
   * compteurs (connexion : 15 minutes et 24 heures). Sans cela, le verrou de
   * 15 minutes, lu en premier, masquerait celui de 24 heures (« Réessayez dans
   * 15 minutes », puis « dans 24 heures » un quart d'heure plus tard), et
   * chaque tentative refusée par le verrou du jour ferait monter le compteur
   * de 15 minutes sans avoir été examinée.
   *
   * @throws HttpException 429 si une clé est verrouillée
   */
  async verifierVerrous(cles: string[], maintenant: Date = new Date()): Promise<void> {
    if (cles.length === 0) return;
    const lignes = await this.prisma.otpVerificationAttempt.findMany({
      where: { phone: { in: cles } },
      select: { failed_count: true, window_start: true, locked_until: true },
    });
    const reste = Math.max(0, ...lignes.map((ligne) => resteBlocageMs(ligne, maintenant)));
    if (reste > 0) throw this.tropDeTentatives(reste);
  }

  /**
   * Compte une tentative et renvoie son rang dans la fenêtre (1 pour la
   * première).
   *
   * @throws HttpException 429 si la clé est verrouillée ou si le plafond est dépassé
   */
  async reserver(
    cle: string,
    politique: PolitiqueTentatives,
    maintenant: Date = new Date(),
  ): Promise<number> {
    const existant = await this.prisma.otpVerificationAttempt.findUnique({
      where: { phone: cle },
      select: { failed_count: true, window_start: true, locked_until: true },
    });

    if (existant) {
      const reste = resteBlocageMs(existant, maintenant);
      if (reste > 0) throw this.tropDeTentatives(reste);

      if (estPerime(existant, maintenant, politique)) {
        // Remise à zéro conditionnelle : la base réévalue la condition, donc
        // deux requêtes concurrentes ne remettent pas deux fois à zéro, et un
        // verrou posé entre-temps n'est pas effacé.
        await this.prisma.otpVerificationAttempt.updateMany({
          where: {
            phone: cle,
            OR: [
              { locked_until: { lte: maintenant } },
              {
                locked_until: null,
                window_start: { lt: debutFenetreValide(maintenant, politique) },
              },
            ],
          },
          data: { failed_count: 0, window_start: maintenant, locked_until: null },
        });
      }
    }

    const rang = await this.incrementer(cle, maintenant);

    if (depassePlafond(rang, politique)) {
      await this.verrouiller(cle, finBlocage(maintenant, politique), maintenant);
      throw this.tropDeTentatives(politique.blocageMs);
    }

    return rang;
  }

  /** Après un échec : pose le verrou si ce rang atteint le plafond. */
  async constaterEchec(
    cle: string,
    rang: number,
    politique: PolitiqueTentatives,
    maintenant: Date = new Date(),
  ): Promise<void> {
    if (!doitVerrouiller(rang, politique)) return;
    await this.verrouiller(cle, finBlocage(maintenant, politique), maintenant);
  }

  /**
   * Après un succès : supprime les compteurs. Sans conséquence si la ligne
   * n'existe pas ; une erreur est journalisée sans faire échouer l'appel,
   * car la tentative a déjà réussi.
   */
  async effacer(...cles: string[]): Promise<void> {
    if (cles.length === 0) return;
    try {
      await this.prisma.otpVerificationAttempt.deleteMany({
        where: { phone: { in: cles } },
      });
    } catch (erreur) {
      this.logger.error(`Remise à zéro des tentatives impossible : ${String(erreur)}`);
    }
  }

  /**
   * `INSERT … ON CONFLICT DO UPDATE SET failed_count = failed_count + 1` :
   * Prisma 6 emploie l'upsert natif de PostgreSQL quand la requête s'y prête
   * (un seul champ unique, même valeur à la création, aucune lecture imbriquée).
   */
  private async incrementer(cle: string, maintenant: Date): Promise<number> {
    const upsert = () =>
      this.prisma.otpVerificationAttempt.upsert({
        where: { phone: cle },
        create: { phone: cle, failed_count: 1, window_start: maintenant },
        update: { failed_count: { increment: 1 } },
        select: { failed_count: true },
      });

    try {
      return (await upsert()).failed_count;
    } catch (erreur) {
      // Si Prisma n'a pas pu passer par l'upsert natif, deux premières
      // tentatives simultanées créent la même ligne et la seconde heurte
      // l'unicité. La ligne existe alors : on recommence, ce qui l'incrémente.
      if ((erreur as { code?: string })?.code === 'P2002') {
        return (await upsert()).failed_count;
      }
      throw erreur;
    }
  }

  /** Pose le verrou, sauf si un verrou encore actif existe déjà. */
  private async verrouiller(cle: string, fin: Date, maintenant: Date): Promise<void> {
    await this.prisma.otpVerificationAttempt.updateMany({
      where: {
        phone: cle,
        OR: [{ locked_until: null }, { locked_until: { lte: maintenant } }],
      },
      data: { locked_until: fin },
    });
  }

  private tropDeTentatives(resteMs: number): HttpException {
    return new HttpException(messageTropDeTentatives(resteMs), HttpStatus.TOO_MANY_REQUESTS);
  }
}
