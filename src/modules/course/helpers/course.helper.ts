import { Injectable } from '@nestjs/common';

/**
 * Générateurs de références/codes pour le module course.
 *
 * Trois types de codes :
 *  - `reference` : CRS-YYMMDD-XXXXX — identifiant UNIQUE (tracking interne)
 *  - `pickup_code` : 3 chiffres — donné au restaurant, NON unique (collisions tolérées)
 *  - `delivery_pin` : 4 chiffres — donné au client pour confirmer la réception
 */
@Injectable()
export class CourseHelper {
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
   * Code retrait à 3 chiffres (000-999) — non unique.
   * Affiché au livreur, donné au restaurant pour retrouver les commandes à retirer.
   */
  generatePickupCode(): string {
    return Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0');
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
