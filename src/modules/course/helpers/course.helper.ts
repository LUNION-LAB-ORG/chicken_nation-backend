import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { choisirCodeRetrait } from './code-retrait.rules';
import { journeeDeService } from './journee-service.rules';

/**
 * Classe du verrou consultatif des codes de retrait : un verrou par
 * restaurant (`hashtext(restaurant_id)`), tenu jusqu'à la fin de la
 * transaction de création. Les classes 727224 à 727226 sont au CRM.
 */
export const CLASSE_VERROU_CODE_RETRAIT = 727227;

/**
 * Générateurs de références/codes pour le module course.
 *
 * Trois types de codes :
 *  - `reference` : CRS-YYMMDD-XXXXX — identifiant UNIQUE (tracking interne)
 *  - `pickup_code` : 3 chiffres — donné au restaurant, UNIQUE dans le restaurant
 *    pour la journée de service (`genererCodeRetrait`, code-retrait.rules.ts)
 *  - `delivery_pin` : 4 chiffres — donné au client pour confirmer la réception
 */
@Injectable()
export class CourseHelper {
  private readonly logger = new Logger(CourseHelper.name);

  /**
   * Génère une référence unique : `CRS-YYMMDD-XXXXX` (5 chiffres random).
   * Le backend boucle avec retry en cas de collision unique (très rare).
   */
  generateReference(): string {
    const d = new Date();
    const yy = d.getFullYear().toString().slice(-2);
    const mm = (d.getMonth() + 1).toString().padStart(2, '0');
    const dd = d.getDate().toString().padStart(2, '0');
    const rand = Math.floor(10000 + Math.random() * 90000);
    return `CRS-${yy}${mm}${dd}-${rand}`;
  }

  /**
   * Code de retrait à 3 chiffres d'une nouvelle course : libre parmi les
   * courses du restaurant créées pendant la journée de service, tous statuts
   * confondus, tiré au hasard. Affiché au livreur, dicté à la caisse.
   *
   * À appeler DANS la transaction qui crée la course : le verrou consultatif
   * du restaurant est tenu jusqu'à sa fin. Deux créations simultanées pour le
   * même restaurant passent l'une après l'autre, et la seconde voit le code
   * de la première. Les autres restaurants ne sont pas bloqués.
   *
   * Si les 1 000 codes ont servi (improbable), repli journalisé : voir
   * `choisirCodeRetrait`.
   */
  async genererCodeRetrait(
    tx: Prisma.TransactionClient,
    restaurantId: string,
    maintenant: Date = new Date(),
  ): Promise<string> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CLASSE_VERROU_CODE_RETRAIT}::int, hashtext(${restaurantId}))`;

    const { debut, fin } = journeeDeService(maintenant);
    const codesDuJour = await tx.course.findMany({
      where: { restaurant_id: restaurantId, created_at: { gte: debut, lt: fin } },
      select: { pickup_code: true, statut: true },
    });

    const choix = choisirCodeRetrait(codesDuJour);
    if (choix.repli) {
      this.logger.warn(
        `Codes de retrait épuisés pour le restaurant ${restaurantId} (journée du ${debut.toISOString()}, ` +
          `${codesDuJour.length} courses) : repli ${choix.repli}, code ${choix.code} réutilisé.`,
      );
    }
    return choix.code;
  }

  /**
   * PIN de livraison à 4 chiffres — unique par Delivery.
   * Envoyé au client via push/SMS, demandé à la livraison.
   */
  generateDeliveryPin(): string {
    return Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0');
  }

  /**
   * Transitions autorisées pour CourseStatut.
   * Utilisé par le service pour valider les changements avant update.
   */
  static readonly VALID_COURSE_TRANSITIONS: Record<string, string[]> = {
    PENDING_ASSIGNMENT: ['ACCEPTED', 'EXPIRED', 'CANCELLED'],
    ACCEPTED: ['AT_RESTAURANT', 'CANCELLED'],
    AT_RESTAURANT: ['IN_DELIVERY', 'CANCELLED'],
    IN_DELIVERY: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
    EXPIRED: [],
  };

  /** Transitions autorisées pour DeliveryStatut (par livraison) */
  static readonly VALID_DELIVERY_TRANSITIONS: Record<string, string[]> = {
    PENDING: ['IN_ROUTE', 'CANCELLED'],
    IN_ROUTE: ['ARRIVED', 'FAILED', 'CANCELLED'],
    ARRIVED: ['DELIVERED', 'FAILED'],
    DELIVERED: [],
    FAILED: [],
    CANCELLED: [],
  };
}
