import { Injectable, Logger } from '@nestjs/common';
import {
  CourseBatchStatus,
  DeliveryService,
  EntityStatus,
  OrderStatus,
  OrderType,
  type Order,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { ILatLng } from '../helpers/geo.helper';
import { PlanificateurLu, planificateurDuRestaurant } from '../helpers/planification.rules';
import { DirectionService } from './direction.service';

/** Ce que le lot lit d'une commande. */
type CommandeDuLot = Pick<Order, 'id' | 'address' | 'status' | 'delivery_service'>;

/**
 * LES LOTS SOUS LE PLANIFICATEUR v2 (conception 3.11 et 5.5).
 *
 *  - Flotte interne : plus de lot. Au passage en v2, les lots en attente d'un
 *    restaurant en v2 sont vidés aussitôt (`libererLotsV2`) : leurs commandes
 *    sont rendues au planificateur, qui crée ou complète les courses tout de
 *    suite, par direction.
 *  - Commandes Turbo d'origine : leur groupe part chez Turbo à la création et
 *    ne grossit plus. Elles gardent le lot actuel (fenêtre courte), mais la
 *    règle « même direction » (direction.rules.ts) remplace le rayon de
 *    1 500 m, pour l'entrée dans un lot comme pour l'anticipation des
 *    commandes en préparation.
 *
 * Sans état ; ne lève jamais à cause de Google (la règle de direction a son
 * repli sans carte).
 */
@Injectable()
export class LotsV2Service {
  private readonly logger = new Logger(LotsV2Service.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly direction: DirectionService,
  ) {}

  private async positionRestaurant(restaurantId: string): Promise<ILatLng | null> {
    const r = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { latitude: true, longitude: true },
    });
    return r?.latitude && r?.longitude ? { lat: r.latitude, lng: r.longitude } : null;
  }

  /**
   * Une commande Turbo d'origine peut-elle rejoindre ce lot ? Même plafond et
   * même interdiction de mélanger les flottes que le lot d'avant ; puis le
   * groupe entier (commandes prêtes du lot et la nouvelle) doit aller dans la
   * même direction.
   */
  async compatibleParDirection(
    existants: readonly CommandeDuLot[],
    candidat: Pick<Order, 'id' | 'address' | 'delivery_service'> & { restaurant_id: string },
    reglages: { maxOrdersPerCourse: number },
  ): Promise<boolean> {
    if (existants.length >= reglages.maxOrdersPerCourse) return false;
    const pretes = existants.filter((o) => o.status === OrderStatus.READY);
    if (pretes.some((o) => o.delivery_service !== candidat.delivery_service)) return false;
    if (pretes.length === 0) return true;

    const restaurant = await this.positionRestaurant(candidat.restaurant_id);
    const lus = await this.direction.reglages();
    const clients = await this.direction.clients(
      restaurant,
      [...pretes, candidat].map((o) => ({ id: o.id, address: o.address })),
      lus.google,
    );
    const verdict = await this.direction.verdictGroupe(restaurant, clients, lus);
    if (!verdict.valide) {
      this.logger.debug(`Lot Turbo : commande ${candidat.id.slice(0, 8)} refusée (${verdict.libelle})`);
    }
    return verdict.valide;
  }

  /**
   * Anticipation du lot Turbo : une commande Turbo d'origine du même
   * restaurant, EN PRÉPARATION, à livrer et sans course, va-t-elle dans la
   * même direction ? Si oui, le lot garde sa fenêtre longue.
   */
  async aCommandeEnPreparationMemeDirection(
    candidat: Pick<Order, 'id' | 'address' | 'delivery_service'> & { restaurant_id: string },
  ): Promise<boolean> {
    const enPreparation = await this.prisma.order.findMany({
      where: {
        restaurant_id: candidat.restaurant_id,
        status: OrderStatus.IN_PROGRESS,
        type: OrderType.DELIVERY,
        delivery_service: candidat.delivery_service,
        entity_status: { not: EntityStatus.DELETED },
        id: { not: candidat.id },
        delivery: null,
      },
      select: { id: true, address: true },
      take: 20,
    });
    if (enPreparation.length === 0) return false;

    const restaurant = await this.positionRestaurant(candidat.restaurant_id);
    const lus = await this.direction.reglages();
    const [client, ...autres] = await this.direction.clients(
      restaurant,
      [candidat, ...enPreparation].map((o) => ({ id: o.id, address: o.address })),
      lus.google,
    );
    if (!client.position) return false;
    for (const autre of autres) {
      if (!autre.position) continue;
      const verdict = await this.direction.verdictPaire(restaurant, client, autre, lus);
      if (verdict.compatible) return true;
    }
    return false;
  }

  /**
   * Passage en v2 : les lots en attente de la flotte interne des restaurants
   * en v2 sont vidés aussitôt. Le lot est clos (EXPIRED, sans course) et ses
   * commandes rendues au planificateur, qui les reprend à son passage.
   * Les lots Turbo d'origine ne sont pas touchés.
   *
   * @returns les restaurants dont des commandes ont été rendues (pour demander un passage).
   */
  async libererLotsV2(planificateur: PlanificateurLu, maintenant = new Date()): Promise<string[]> {
    const lots = await this.prisma.courseBatch.findMany({
      where: { status: CourseBatchStatus.PENDING },
      select: {
        id: true,
        restaurant_id: true,
        orders: { select: { id: true, delivery_service: true } },
      },
    });
    const restaurants = new Set<string>();
    for (const lot of lots) {
      if (planificateurDuRestaurant(planificateur, lot.restaurant_id) !== 'v2') continue;
      const turbo = lot.orders.length > 0 && lot.orders.every((o) => o.delivery_service === DeliveryService.TURBO);
      if (turbo) continue;

      // Réservation : un seul serveur clôt le lot.
      const clos = await this.prisma.courseBatch.updateMany({
        where: { id: lot.id, status: CourseBatchStatus.PENDING },
        data: { status: CourseBatchStatus.EXPIRED, flushed_at: maintenant },
      });
      if (clos.count !== 1) continue;
      await this.prisma.order.updateMany({ where: { batch_id: lot.id, delivery: null }, data: { batch_id: null } });
      restaurants.add(lot.restaurant_id);
      this.logger.log(
        `Lot ${lot.id.slice(0, 8)} vidé (planificateur v2) : ${lot.orders.length} commande(s) rendue(s) au planificateur.`,
      );
    }
    return [...restaurants];
  }
}
