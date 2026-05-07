import { Injectable, Logger } from '@nestjs/common';
import {
  CourseBatchStatus,
  CourseStatut,
  DeliveryStatut,
  EntityStatus,
  OrderStatus,
  type CourseBatch,
  type Order,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { CourseEvent } from '../events/course.event';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { haversineMeters, nearestNeighborOrder, parseOrderLatLng, type ILatLng } from '../helpers/geo.helper';
import { CourseOfferService } from './course-offer.service';

/**
 * Service de regroupement intelligent — Phase P3.
 *
 * Objectif : éviter le modèle "1 Order READY = 1 Course" qui envoie 3 livreurs
 * pour 3 commandes voisines. On agrège les orders READY d'un même restaurant
 * dans une fenêtre temporelle (`course.batch_window_seconds`, default 180 s)
 * tant que la distance entre destinations reste ≤ `course.max_detour_meters`
 * et le plafond `course.max_orders_per_course` n'est pas atteint.
 *
 * Les batches sont persistés en DB (table `CourseBatch`) pour :
 *   - Survivre à un redémarrage backend
 *   - Permettre à plusieurs instances backend de concourir sans race critique
 *   - Garder la trace d'audit (statut PENDING/FLUSHED/EXPIRED)
 */
@Injectable()
export class CourseGroupingService {
  private readonly logger = new Logger(CourseGroupingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CourseSettingsHelper,
    private readonly courseOfferService: CourseOfferService,
    private readonly courseEvent: CourseEvent,
  ) {}

  // ============================================================
  // POINT D'ENTRÉE — appelé depuis OrderBridgeListener sur READY
  // ============================================================

  /**
   * Tente de rattacher l'Order à un batch existant du même restaurant.
   * Sinon crée un nouveau batch avec TTL.
   * Si après ajout le batch atteint le plafond → flush immédiat (early flush).
   */
  async tryGroupOrder(orderId: string): Promise<{ batchId: string; flushed: boolean }> {
    const settings = await this.settings.load();

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        restaurant_id: true,
        address: true,
        batch_id: true,
        created_at: true,
      },
    });

    if (!order) {
      throw new Error(`Order ${orderId} introuvable`);
    }
    if (order.status !== OrderStatus.READY) {
      this.logger.warn(`Order ${orderId} n'est pas READY (${order.status}) — skip grouping`);
      return { batchId: '', flushed: false };
    }
    if (order.batch_id) {
      this.logger.warn(`Order ${orderId} a déjà un batch (${order.batch_id}) — skip`);
      return { batchId: order.batch_id, flushed: false };
    }

    // 1. Chercher un batch PENDING du même restaurant encore ouvert
    const candidate = await this.prisma.courseBatch.findFirst({
      where: {
        restaurant_id: order.restaurant_id,
        status: CourseBatchStatus.PENDING,
        expires_at: { gt: new Date() },
      },
      include: {
        orders: {
          select: { id: true, address: true, created_at: true, status: true },
        },
      },
    });

    // 2. Si batch compatible → attacher (flush géré par le cron, qui respectera le min_wait)
    if (candidate && this.isCompatible(candidate.orders, order, settings)) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { batch_id: candidate.id },
      });
      const newSize = candidate.orders.length + 1;
      this.logger.log(
        `Order ${order.id} attachée au batch ${candidate.id} (${newSize}/${settings.maxOrdersPerCourse})`,
      );
      return { batchId: candidate.id, flushed: false };
    }

    // 3. Sinon créer un nouveau batch — TTL adaptatif via lookahead IN_PROGRESS
    let ttlSeconds = settings.batchWindowSeconds; // par défaut TTL max (3 min)

    if (settings.lookaheadInProgress) {
      const hasCandidateInProgress = await this.hasCompatibleOrderInProgress(
        order.restaurant_id,
        order.address,
        order.id,
        settings,
      );
      if (!hasCandidateInProgress) {
        // Aucune order en prépa compatible → on attend juste le min_wait,
        // pas la peine de bloquer cette commande 3 min pour rien.
        ttlSeconds = settings.batchMinWaitSeconds;
        this.logger.debug(
          `Aucune order IN_PROGRESS compatible pour resto ${order.restaurant_id.slice(0, 8)} → TTL court (${ttlSeconds}s)`,
        );
      }
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const batch = await this.prisma.courseBatch.create({
      data: {
        restaurant_id: order.restaurant_id,
        expires_at: expiresAt,
        status: CourseBatchStatus.PENDING,
        orders: { connect: [{ id: order.id }] },
      },
    });
    this.logger.log(
      `Nouveau batch ${batch.id} créé pour order ${order.id} (flush dans ${ttlSeconds}s)`,
    );
    return { batchId: batch.id, flushed: false };
  }

  /**
   * Lookahead : check s'il existe au moins 1 Order IN_PROGRESS du même restaurant
   * dont la destination est compatible (distance < max_detour) avec la nouvelle Order.
   * Si oui → on garde le TTL max pour augmenter les chances de grouping.
   */
  private async hasCompatibleOrderInProgress(
    restaurantId: string,
    candidateAddress: unknown,
    candidateOrderId: string,
    settings: { maxDetourMeters: number },
  ): Promise<boolean> {
    const candidateCoords = parseOrderLatLng(candidateAddress);
    if (!candidateCoords) return false; // sans coords, on ne peut pas trancher → fallback prudent

    const inProgress = await this.prisma.order.findMany({
      where: {
        restaurant_id: restaurantId,
        status: OrderStatus.IN_PROGRESS,
        entity_status: { not: EntityStatus.DELETED },
        id: { not: candidateOrderId },
        delivery: null, // pas déjà dans une Course
      },
      select: { id: true, address: true },
      take: 20, // safety
    });

    for (const o of inProgress) {
      const c = parseOrderLatLng(o.address);
      if (!c) continue;
      if (haversineMeters(candidateCoords, c) <= settings.maxDetourMeters) return true;
    }
    return false;
  }

  // ============================================================
  // CRON — appelé toutes les 10s par CourseBatchTask
  // ============================================================

  /**
   * Flush les batches PENDING qui sont prêts.
   *
   * Règles de flush :
   *   1. **Jamais** avant `batch_min_wait_seconds` écoulé depuis création (anti-précipitation
   *      — laisse le temps à d'autres orders d'arriver, même si on a atteint le plafond)
   *   2. APRÈS le min_wait : flush si `expires_at` dépassé OU si saturé
   */
  async flushMatureBatches(): Promise<number> {
    const settings = await this.settings.load();
    const now = new Date();
    const minWaitMs = settings.batchMinWaitSeconds * 1000;

    // On fetch tous les PENDING + leur taille pour décider en mémoire
    const pending = await this.prisma.courseBatch.findMany({
      where: { status: CourseBatchStatus.PENDING },
      select: {
        id: true,
        created_at: true,
        expires_at: true,
        orders: { where: { status: OrderStatus.READY }, select: { id: true } },
      },
    });

    let flushed = 0;
    for (const batch of pending) {
      const ageMs = now.getTime() - batch.created_at.getTime();
      const minWaitPassed = ageMs >= minWaitMs;
      if (!minWaitPassed) continue;

      const isExpired = batch.expires_at <= now;
      const isSaturated = batch.orders.length >= settings.maxOrdersPerCourse;
      if (!isExpired && !isSaturated) continue;

      try {
        await this.flushBatch(batch.id);
        flushed++;
      } catch (err) {
        this.logger.error(`Flush batch ${batch.id} échoué`, err);
      }
    }
    return flushed;
  }

  // ============================================================
  // FLUSH — crée la Course à partir d'un batch
  // ============================================================

  /**
   * Flush un batch : crée la Course via `createFromReadyOrders` avec les orders
   * réordonnées par nearest-neighbor depuis le restaurant. Marque le batch FLUSHED.
   *
   * Si le batch ne contient plus aucune order éligible (toutes annulées pendant
   * la fenêtre) → marque EXPIRED sans créer de Course.
   */
  async flushBatch(batchId: string): Promise<void> {
    const batch = await this.prisma.courseBatch.findUnique({
      where: { id: batchId },
      include: {
        orders: {
          where: {
            status: OrderStatus.READY,
            entity_status: { not: EntityStatus.DELETED },
            delivery: null, // pas déjà dans une Course
          },
          select: { id: true, address: true, created_at: true },
        },
        restaurant: {
          select: { id: true, latitude: true, longitude: true },
        },
      },
    });

    if (!batch) {
      this.logger.warn(`flushBatch: batch ${batchId} introuvable`);
      return;
    }
    if (batch.status !== CourseBatchStatus.PENDING) {
      this.logger.debug(`flushBatch: batch ${batchId} déjà ${batch.status}`);
      return;
    }

    // Aucune order éligible (toutes annulées pendant la fenêtre)
    if (batch.orders.length === 0) {
      await this.prisma.courseBatch.update({
        where: { id: batchId },
        data: { status: CourseBatchStatus.EXPIRED, flushed_at: new Date() },
      });
      this.logger.log(`Batch ${batchId} expiré (0 order éligible)`);
      return;
    }

    // Calculer l'ordre optimal des livraisons
    const orderedIds = this.optimizeOrderSequence(batch.orders, {
      lat: batch.restaurant.latitude ?? 0,
      lng: batch.restaurant.longitude ?? 0,
    });

    // Créer la Course via le service existant
    const course = await this.courseOfferService.createFromReadyOrders({
      restaurantId: batch.restaurant_id,
      orderIds: orderedIds,
    });

    await this.prisma.courseBatch.update({
      where: { id: batchId },
      data: {
        status: CourseBatchStatus.FLUSHED,
        flushed_at: new Date(),
        course_id: course.id,
      },
    });

    this.logger.log(
      `Batch ${batchId} flushé → Course ${course.reference} (${orderedIds.length} livraisons)`,
    );
  }

  // ============================================================
  // RE-BALANCING — fusion / transfert de courses non récupérées
  // ============================================================

  /**
   * Parcourt les courses **encore ajustables** (PENDING_ASSIGNMENT, ACCEPTED,
   * AT_RESTAURANT — donc pas encore IN_DELIVERY) et tente de :
   *
   *   - **Fusion totale** : si toutes les deliveries d'une course "source" plus
   *     récente peuvent rentrer dans une course "target" plus ancienne du même
   *     restaurant (en respectant distance + plafond), on transfère tout et la
   *     source passe CANCELLED avec raison "merged_into_{target.id}".
   *
   *   - **Transfert partiel** : si seulement une partie des deliveries peuvent
   *     rejoindre target, on transfère celles-là, source garde le reste.
   *
   * Pour chaque course modifiée et déjà acceptée par un livreur, on émet un event
   * `course:updated` pour que son mobile rafraîchisse la liste de deliveries.
   *
   * Appelé par `CourseBatchTask` toutes les `rebalance_interval_seconds`.
   */
  async rebalanceActiveCourses(): Promise<{ merged: number; transferred: number }> {
    const settings = await this.settings.load();
    if (!settings.rebalanceEnabled) return { merged: 0, transferred: 0 };

    const ADJUSTABLE: CourseStatut[] = [
      CourseStatut.PENDING_ASSIGNMENT,
      CourseStatut.ACCEPTED,
      CourseStatut.AT_RESTAURANT,
    ];

    // Fetch courses ajustables avec leurs deliveries non terminales
    const courses = await this.prisma.course.findMany({
      where: { statut: { in: ADJUSTABLE } },
      include: {
        deliveries: {
          where: { statut: { in: [DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE] } },
          select: {
            id: true,
            sequence_order: true,
            order: {
              select: {
                id: true,
                address: true,
                created_at: true,
                status: true,
              },
            },
          },
        },
      },
    });

    if (courses.length < 2) return { merged: 0, transferred: 0 };

    // Grouper par restaurant
    const byRestaurant = new Map<string, typeof courses>();
    for (const c of courses) {
      const arr = byRestaurant.get(c.restaurant_id) ?? [];
      arr.push(c);
      byRestaurant.set(c.restaurant_id, arr);
    }

    let totalMerged = 0;
    let totalTransferred = 0;
    const touchedCourseIds = new Set<string>();

    for (const restaurantCourses of byRestaurant.values()) {
      if (restaurantCourses.length < 2) continue;

      // Trier par created_at ASC : les plus anciennes deviennent cibles
      restaurantCourses.sort(
        (a, b) => a.created_at.getTime() - b.created_at.getTime(),
      );

      for (let i = 0; i < restaurantCourses.length - 1; i++) {
        const target = restaurantCourses[i];
        if (target.deliveries.length >= settings.maxOrdersPerCourse) continue;

        for (let j = i + 1; j < restaurantCourses.length; j++) {
          const source = restaurantCourses[j];
          if (source.deliveries.length === 0) continue;

          // Pour chaque delivery de source, tester si compatible avec target
          const transferable = source.deliveries.filter((d) =>
            this.canTransferDelivery(target.deliveries, d, settings),
          );

          for (const d of transferable) {
            if (target.deliveries.length >= settings.maxOrdersPerCourse) break;
            await this.transferDelivery(d.id, target.id);
            target.deliveries.push(d);
            source.deliveries = source.deliveries.filter((sd) => sd.id !== d.id);
            touchedCourseIds.add(target.id);
            touchedCourseIds.add(source.id);
            totalTransferred++;
          }

          // Si source vide après transferts → fusion totale
          if (source.deliveries.length === 0) {
            await this.markCourseMerged(source.id, target.id);
            touchedCourseIds.add(source.id);
            totalMerged++;
          }
        }
      }
    }

    // Notifier les livreurs / backoffice des courses modifiées
    if (touchedCourseIds.size > 0) {
      await this.emitUpdatedEvents([...touchedCourseIds]);
    }

    if (totalTransferred > 0 || totalMerged > 0) {
      this.logger.log(
        `Re-balance : ${totalTransferred} delivery(ies) transférée(s), ${totalMerged} course(s) fusionnée(s)`,
      );
    }
    return { merged: totalMerged, transferred: totalTransferred };
  }

  /**
   * Test de compatibilité d'une delivery candidate vs les deliveries déjà
   * dans la course cible. Critères : distance < `max_detour_meters` pour
   * chaque destination existante.
   */
  private canTransferDelivery(
    targetDeliveries: { order: { address: unknown } }[],
    candidate: { order: { address: unknown } },
    settings: { maxDetourMeters: number },
  ): boolean {
    const candidateCoords = parseOrderLatLng(candidate.order.address);
    if (!candidateCoords) return false;

    for (const td of targetDeliveries) {
      const tCoords = parseOrderLatLng(td.order.address);
      if (!tCoords) continue;
      if (haversineMeters(candidateCoords, tCoords) > settings.maxDetourMeters) {
        return false;
      }
    }
    return true;
  }

  /** Transfert effectif d'une Delivery vers une autre Course (ré-attribue sequence_order). */
  private async transferDelivery(deliveryId: string, targetCourseId: string): Promise<void> {
    const targetMaxSeq = await this.prisma.delivery.aggregate({
      where: { course_id: targetCourseId },
      _max: { sequence_order: true },
    });
    const newSeq = (targetMaxSeq._max.sequence_order ?? 0) + 1;

    await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { course_id: targetCourseId, sequence_order: newSeq },
    });
  }

  /** Marque une course CANCELLED avec raison "merged_into_X". */
  private async markCourseMerged(sourceCourseId: string, targetCourseId: string): Promise<void> {
    await this.prisma.course.update({
      where: { id: sourceCourseId },
      data: {
        statut: CourseStatut.CANCELLED,
        cancelled_at: new Date(),
        cancelled_by: 'system',
        cancelled_reason: `Fusionnée automatiquement avec course ${targetCourseId}`,
      },
    });
  }

  /**
   * Émet `courseStatutChanged` pour chaque course modifiée pendant le rebalance.
   * Le mobile invalidera ses queries et rafraîchira l'UI livreur.
   */
  private async emitUpdatedEvents(courseIds: string[]): Promise<void> {
    for (const id of courseIds) {
      try {
        const course = await this.prisma.course.findUnique({
          where: { id },
          include: COURSE_FULL_INCLUDE,
        });
        if (!course) continue;
        // Pas de changement de statut réel — on réutilise courseStatutChanged
        // pour déclencher l'invalidation côté mobile (le hook écoute déjà).
        await this.courseEvent.courseStatutChanged({
          course,
          previous_statut: course.statut,
          new_statut: course.statut,
        });
      } catch (err) {
        this.logger.warn(`Émission updated event échouée pour ${id}: ${(err as Error).message}`);
      }
    }
  }

  // ============================================================
  // HELPERS PRIVÉS
  // ============================================================

  /**
   * Décide si une nouvelle Order peut rejoindre un batch existant.
   * Critères :
   *   1. Plafond `maxOrdersPerCourse` pas atteint
   *   2. Distance max entre la nouvelle destination et CHAQUE destination
   *      déjà présente ≤ `maxDetourMeters`
   *
   * Note : on ne vérifie PAS la durée totale du trajet ici (coûteux via Google
   * Directions à chaque ajout). Vérification faite au flush final.
   */
  private isCompatible(
    existing: readonly Pick<Order, 'id' | 'address' | 'status'>[],
    candidate: Pick<Order, 'id' | 'address'>,
    settings: { maxOrdersPerCourse: number; maxDetourMeters: number },
  ): boolean {
    if (existing.length >= settings.maxOrdersPerCourse) return false;

    const candidateCoords = parseOrderLatLng(candidate.address);
    if (!candidateCoords) return false;

    for (const prev of existing) {
      if (prev.status !== OrderStatus.READY) continue; // on ignore les annulées dans le batch
      const prevCoords = parseOrderLatLng(prev.address);
      if (!prevCoords) continue;
      const distance = haversineMeters(candidateCoords, prevCoords);
      if (distance > settings.maxDetourMeters) {
        this.logger.debug(
          `Candidat refusé : ${Math.round(distance)}m > ${settings.maxDetourMeters}m max`,
        );
        return false;
      }
    }
    return true;
  }

  /**
   * Ordonne les orders pour minimiser le trajet total restaurant → clients.
   *
   * Heuristique :
   *   1. **Seed** = order avec le plus grand temps d'attente (`created_at` le plus ancien)
   *      → priorité client (qui attend depuis le plus longtemps passe en 1er)
   *   2. Ensuite **nearest-neighbor** depuis la position courante (TSP approximé)
   */
  private optimizeOrderSequence(
    orders: readonly Pick<Order, 'id' | 'address' | 'created_at'>[],
    restaurantCoords: ILatLng,
  ): string[] {
    // Filtrer ceux qui ont des coords valides
    const withCoords: { id: string; coords: ILatLng; createdAt: Date }[] = [];
    const withoutCoords: string[] = [];
    for (const o of orders) {
      const coords = parseOrderLatLng(o.address);
      if (coords) {
        withCoords.push({ id: o.id, coords, createdAt: o.created_at });
      } else {
        withoutCoords.push(o.id);
      }
    }

    if (withCoords.length === 0) {
      // Aucune coord → on garde l'ordre d'arrivée
      return orders.map((o) => o.id);
    }

    // Seed = le plus ancien (plus grand wait time)
    withCoords.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const [seed, ...rest] = withCoords;

    // Nearest-neighbor depuis le seed (pas depuis le restaurant) — car le
    // restaurant est le point commun de départ mais le séquençage démarre sur
    // la commande la plus prioritaire, puis on enchaîne au plus proche.
    const remainingIds = nearestNeighborOrder(seed.coords, rest);
    const ordered = [seed.id, ...remainingIds];

    // Les orders sans coords rejoignent la fin (ordre d'arrivée)
    return [...ordered, ...withoutCoords];
  }
}
