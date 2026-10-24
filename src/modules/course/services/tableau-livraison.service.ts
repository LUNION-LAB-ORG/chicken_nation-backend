import { Injectable, Logger } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, EntityStatus, OrderStatus, PaymentMethod } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererScoringSettingsHelper } from 'src/modules/deliverers/helpers/deliverer-scoring-settings.helper';
import { DeliverersService } from 'src/modules/deliverers/services/deliverers.service';

import { seuilAlerteSansLivreurMin } from '../helpers/alerte-sans-livreur.rules';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { journeeDeService } from '../helpers/journee-service.rules';
import { planificateurDuRestaurant } from '../helpers/planification.rules';
import { TableauLivraison, construireTableau } from '../helpers/tableau-livraison.rules';

/** Résultat gardé en mémoire, par périmètre (un restaurant, ou tout le réseau). */
const DUREE_CACHE_MS = 10_000;
/** Au-delà, les périmètres échus sont oubliés (le siège peut demander chaque restaurant). */
const TAILLE_MAX_CACHE = 50;

const STATUTS_COURSE_NON_TERMINEE: CourseStatut[] = [
  CourseStatut.PENDING_ASSIGNMENT,
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
  CourseStatut.IN_DELIVERY,
];

/**
 * `GET /livraison/tableau` (conception du 24/10, 11.4) : chiffres par
 * restaurant, livreurs, alertes. Lectures groupées ici, calcul dans la règle
 * pure `construireTableau` (tableau-livraison.rules.ts).
 *
 * Lectures : les livreurs actifs (la même que `GET /deliverers/live-locations`,
 * donc le même état et la même file), les courses non terminées et celles de
 * la journée (expirées, annulées), les commandes livrées en espèces pas
 * encaissées, les livraisons du jour, le planning du jour.
 */
@Injectable()
export class TableauLivraisonService {
  private readonly logger = new Logger(TableauLivraisonService.name);
  private readonly cache = new Map<string, { expire: number; valeur: Promise<TableauLivraison> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly livreurs: DeliverersService,
    private readonly reglagesCourse: CourseSettingsHelper,
    private readonly reglagesLivreur: DelivererScoringSettingsHelper,
  ) {}

  /**
   * @param restaurantId  Périmètre déjà résolu (`resolveRestaurantScope`) :
   *   un restaurant, ou `undefined` pour tout le réseau.
   */
  async lire(restaurantId: string | undefined): Promise<TableauLivraison> {
    const cle = restaurantId ?? '*';
    const maintenant = Date.now();
    const enMemoire = this.cache.get(cle);
    if (enMemoire && enMemoire.expire > maintenant) return enMemoire.valeur;

    if (this.cache.size >= TAILLE_MAX_CACHE) {
      for (const [k, v] of this.cache) if (v.expire <= maintenant) this.cache.delete(k);
    }
    const valeur = this.calculer(restaurantId, new Date(maintenant));
    this.cache.set(cle, { expire: maintenant + DUREE_CACHE_MS, valeur });
    // Une lecture ratée n'est pas gardée : la suivante réessaie.
    valeur.catch((erreur: unknown) => {
      if (this.cache.get(cle)?.valeur === valeur) this.cache.delete(cle);
      this.logger.warn(`Tableau de la livraison illisible : ${(erreur as Error)?.message ?? erreur}`);
    });
    return valeur;
  }

  private async calculer(restaurantId: string | undefined, maintenant: Date): Promise<TableauLivraison> {
    const journee = journeeDeService(maintenant);
    const duRestaurant = restaurantId ? { restaurant_id: restaurantId } : {};

    const [course, planification, livreur, restaurants, livreurs, courses, aEncaisser, livrees, planning] = await Promise.all([
      this.reglagesCourse.load(),
      this.reglagesCourse.lirePlanification(),
      this.reglagesLivreur.load(),
      this.prisma.restaurant.findMany({
        // Compte de restaurant : le sien, quel que soit son état ; siège : les restaurants ouverts.
        where: restaurantId
          ? { id: restaurantId, entity_status: { not: EntityStatus.DELETED } }
          : { entity_status: EntityStatus.ACTIVE },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.livreurs.getLiveLocations({ restaurantId, includeOffline: true }),
      this.prisma.course.findMany({
        where: {
          ...duRestaurant,
          OR: [
            { statut: { in: STATUTS_COURSE_NON_TERMINEE } },
            { statut: CourseStatut.EXPIRED, created_at: { gte: journee.debut } },
            { statut: CourseStatut.CANCELLED, cancelled_at: { gte: journee.debut } },
          ],
        },
        select: {
          id: true,
          reference: true,
          statut: true,
          restaurant_id: true,
          deliverer: { select: { id: true, first_name: true } },
          turbo_escalated_at: true,
          created_at: true,
          at_restaurant_at: true,
          picked_up_at: true,
          parti_at: true,
          motif_depart: true,
          estimated_duration_min: true,
          delay_alerted_at: true,
          cancelled_at: true,
          deliveries: {
            select: {
              statut: true,
              ajoutee_apres_retrait: true,
              order: { select: { reference: true, status: true, entity_status: true, delivery_service: true } },
            },
          },
        },
      }),
      this.prisma.order.findMany({
        where: {
          ...duRestaurant,
          status: OrderStatus.COLLECTED,
          payment_method: PaymentMethod.OFFLINE,
          paied: false,
          entity_status: { not: EntityStatus.DELETED },
          delivery: { is: { course: { is: { deliverer_id: { not: null } } } } },
        },
        select: {
          reference: true,
          restaurant_id: true,
          collected_at: true,
          delivery: { select: { course: { select: { deliverer: { select: { id: true, first_name: true } } } } } },
        },
      }),
      this.prisma.delivery.findMany({
        where: {
          statut: DeliveryStatut.DELIVERED,
          delivered_at: { gte: journee.debut, lt: journee.fin },
          ...(restaurantId && { course: { is: { restaurant_id: restaurantId } } }),
        },
        select: {
          delivered_at: true,
          course: { select: { restaurant_id: true } },
          order: { select: { ready_at: true } },
        },
      }),
      this.livreurs.lirePlanningDuJour(restaurantId, maintenant),
    ]);

    return construireTableau({
      maintenant,
      reglages: {
        facteurRetard: course.delayAlertFactor,
        sansLivreurAlerteMin: course.noDelivererAlertAfterMin,
        // Même seuil que la cloche « aucun livreur », restaurant par restaurant.
        sansLivreurAlerteMinParRestaurant: Object.fromEntries(
          restaurants.map((r) => [
            r.id,
            seuilAlerteSansLivreurMin({
              alerteMin: course.noDelivererAlertAfterMin,
              v2: planificateurDuRestaurant(planification.planificateur, r.id) === 'v2',
              turboActif: planification.planification.reglages.turboActif,
              turboApresMinV2: planification.planification.reglages.turboApresMinV2,
            }),
          ]),
        ),
        attenteAuRestaurantMin: course.autoCancelAtRestaurantAfterMin / 2,
        positionExpireeMin: livreur.gpsExpirationMinutes,
      },
      restaurants: restaurants.map((r) => ({ id: r.id, nom: r.name })),
      livreurs,
      courses,
      aEncaisser: aEncaisser.map((c) => ({
        reference: c.reference,
        restaurant_id: c.restaurant_id,
        collected_at: c.collected_at,
        livreur: c.delivery?.course?.deliverer ?? null,
      })),
      livrees: livrees.map((l) => ({
        restaurant_id: l.course.restaurant_id,
        delivered_at: l.delivered_at,
        ready_at: l.order.ready_at,
      })),
      planning,
    });
  }
}
