import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseStatut,
  DeliveryFailureReason,
  DeliveryStatut,
  OrderStatus,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { DelivererQueueService } from 'src/modules/deliverers/services/deliverer-queue.service';

import { ConfirmDeliveryDto } from '../dto/confirm-delivery.dto';
import { FailDeliveryDto } from '../dto/fail-delivery.dto';
import { RateCustomerDto } from '../dto/rate-customer.dto';
import { CourseEvent } from '../events/course.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';

/**
 * Service : transitions de statut sur les Delivery individuelles.
 * Auto-complétion de la Course parent quand toutes les Delivery sont terminées.
 */
@Injectable()
export class DeliveryActionService {
  private readonly logger = new Logger(DeliveryActionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseEvent: CourseEvent,
    private readonly queueService: DelivererQueueService,
    // P-push livreur : push "Course terminée — bravo !" à la fin
    private readonly pushService: DelivererPushService,
  ) {}

  /** Le livreur démarre une livraison vers ce client (PENDING → IN_ROUTE) */
  async startDelivery(deliveryId: string, delivererId: string) {
    const delivery = await this.assertOwned(deliveryId, delivererId, DeliveryStatut.PENDING);

    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { statut: DeliveryStatut.IN_ROUTE, in_route_at: new Date() },
    });

    await this.emitDeliveryStatut(updated, delivery.statut);
    return updated;
  }

  /** Livreur arrivé à l'adresse client (IN_ROUTE → ARRIVED) */
  async markArrived(deliveryId: string, delivererId: string) {
    const delivery = await this.assertOwned(deliveryId, delivererId, DeliveryStatut.IN_ROUTE);

    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { statut: DeliveryStatut.ARRIVED, arrived_at: new Date() },
    });

    await this.emitDeliveryStatut(updated, delivery.statut);
    return updated;
  }

  /**
   * Confirmation de livraison via PIN client (ARRIVED → DELIVERED).
   * Valide le PIN fourni contre celui généré à la création de la Delivery.
   *
   * **Cascade Order — dépend du paiement** :
   *   - `paied === true`  (ONLINE ou espèce encaissée d'avance)
   *       → Order `COMPLETED` + `completed_at = now` — la commande est finie.
   *   - `paied === false` (OFFLINE pas encore encaissée)
   *       → Order reste en `COLLECTED` + `collected_at = now` seulement.
   *       La commande apparaîtra dans la colonne « Collectées » du backoffice
   *       jusqu'à ce que la caissière appelle `markPaidCash` (livreur rentre
   *       au restaurant et verse l'argent → `COMPLETED` à ce moment-là).
   *       Si le livreur tarde trop à encaisser, le regroupement côté
   *       backoffice (`group-orders.ts`) la bascule en « Problèmes » au
   *       dépassement du seuil `OVERDUE_COLLECTED_UNPAID_MIN`.
   */
  async confirmDelivery(deliveryId: string, delivererId: string, dto: ConfirmDeliveryDto) {
    const delivery = await this.assertOwned(deliveryId, delivererId, DeliveryStatut.ARRIVED);

    if (delivery.delivery_pin !== dto.pin) {
      throw new BadRequestException('PIN invalide');
    }

    const now = new Date();
    const isPaid = delivery.order.paied;
    const orderUpdate = isPaid
      ? {
          status: OrderStatus.COMPLETED,
          collected_at: now,
          completed_at: now,
        }
      : {
          status: OrderStatus.COLLECTED,
          collected_at: now,
        };

    const [updated] = await this.prisma.$transaction([
      this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { statut: DeliveryStatut.DELIVERED, delivered_at: now },
      }),
      this.prisma.order.update({
        where: { id: delivery.order_id },
        data: orderUpdate,
      }),
    ]);

    await this.emitDeliveryStatut(updated, delivery.statut);
    await this.checkCourseCompletion(delivery.course_id);
    return updated;
  }

  /** Échec de livraison (client absent, refus, etc.) */
  async failDelivery(deliveryId: string, delivererId: string, dto: FailDeliveryDto) {
    const delivery = await this.prisma.delivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException('Delivery non trouvée');
    await this.assertOwnership(delivery.course_id, delivererId);

    // OTHER nécessite une note
    if (dto.reason === DeliveryFailureReason.OTHER && !dto.note?.trim()) {
      throw new BadRequestException('Une note est requise pour le motif OTHER');
    }

    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.delivery.update({
        where: { id: deliveryId },
        data: {
          statut: DeliveryStatut.FAILED,
          failed_at: now,
          failure_reason: dto.reason,
          failure_note: dto.note,
        },
      }),
      // Order annulée avec traçabilité du motif (délivré au livreur)
      this.prisma.order.update({
        where: { id: delivery.order_id },
        data: {
          status: OrderStatus.CANCELLED,
          cancelled_at: now,
          cancelled_by: 'deliverer',
          cancelled_reason: dto.note ?? `Livraison échouée : ${dto.reason}`,
        },
      }),
    ]);

    await this.emitDeliveryStatut(updated, delivery.statut);
    await this.checkCourseCompletion(delivery.course_id);
    return updated;
  }

  /**
   * Notation du client par le livreur après une livraison.
   *
   * Règles :
   *  - La livraison doit appartenir au livreur.
   *  - Le statut doit être terminal (DELIVERED ou FAILED) — on ne note pas
   *    une livraison encore en cours.
   *  - Une seule note par livraison (idempotent côté UI : si déjà notée,
   *    on retourne 400 pour que le client masque le bouton).
   */
  async rateCustomer(deliveryId: string, delivererId: string, dto: RateCustomerDto) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { course: { select: { deliverer_id: true } } },
    });
    if (!delivery) throw new NotFoundException('Delivery non trouvée');
    if (delivery.course.deliverer_id !== delivererId) {
      throw new ForbiddenException("Cette livraison ne vous est pas affectée");
    }

    const TERMINAL_FOR_RATING: DeliveryStatut[] = [
      DeliveryStatut.DELIVERED,
      DeliveryStatut.FAILED,
    ];
    if (!TERMINAL_FOR_RATING.includes(delivery.statut)) {
      throw new BadRequestException(
        'La livraison doit être terminée (DELIVERED ou FAILED) pour pouvoir être notée',
      );
    }

    if (delivery.customer_rating !== null) {
      throw new BadRequestException('Cette livraison a déjà été notée');
    }

    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        customer_rating: dto.rating,
        customer_rating_note: dto.note ?? null,
        customer_rated_at: new Date(),
      },
    });

    this.logger.log(
      `Delivery ${deliveryId} notée ${dto.rating}/5 par livreur ${delivererId}`,
    );
    return updated;
  }

  // ============================================================
  // HELPERS PRIVÉS
  // ============================================================

  /**
   * Vérifie ownership + statut attendu. Inclut l'order (champs paid / payment_method)
   * pour que `confirmDelivery` puisse décider si la commande passe `COMPLETED`
   * ou reste `COLLECTED` en attendant l'encaissement caissière.
   */
  private async assertOwned(deliveryId: string, delivererId: string, expected: DeliveryStatut) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        course: true,
        order: { select: { id: true, paied: true, payment_method: true } },
      },
    });
    if (!delivery) throw new NotFoundException('Delivery non trouvée');
    if (delivery.course.deliverer_id !== delivererId) {
      throw new ForbiddenException("Cette livraison ne vous est pas affectée");
    }
    if (delivery.course.statut !== CourseStatut.IN_DELIVERY) {
      throw new BadRequestException('La course doit être en phase IN_DELIVERY');
    }
    if (delivery.statut !== expected) {
      throw new BadRequestException(`Statut delivery attendu ${expected}, actuel ${delivery.statut}`);
    }
    return delivery;
  }

  private async assertOwnership(courseId: string, delivererId: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course non trouvée');
    if (course.deliverer_id !== delivererId) {
      throw new ForbiddenException("Cette livraison ne vous est pas affectée");
    }
  }

  /**
   * Vérifie si toutes les Delivery de la Course sont terminées (DELIVERED/FAILED/CANCELLED).
   * Si oui → Course passe en COMPLETED + émet event.
   */
  private async checkCourseCompletion(courseId: string) {
    const deliveries = await this.prisma.delivery.findMany({
      where: { course_id: courseId },
      select: { statut: true },
    });

    const TERMINAL: DeliveryStatut[] = [
      DeliveryStatut.DELIVERED,
      DeliveryStatut.FAILED,
      DeliveryStatut.CANCELLED,
    ];
    const allTerminal = deliveries.every((d) => TERMINAL.includes(d.statut));

    if (!allTerminal) return;

    const completed = await this.prisma.course.update({
      where: { id: courseId },
      data: { statut: CourseStatut.COMPLETED, completed_at: new Date() },
      include: COURSE_FULL_INCLUDE,
    });

    const success_count = deliveries.filter((d) => d.statut === DeliveryStatut.DELIVERED).length;
    const fail_count = deliveries.length - success_count;

    // P5 : remettre le livreur en queue FIFO (si pas en pause).
    if (completed.deliverer_id) {
      await this.queueService.onComplete(completed.deliverer_id);
    }

    await this.courseEvent.courseCompleted({ course: completed, success_count, fail_count });

    // P-push livreur : confirmation visuelle + sonore de la fin de course.
    if (completed.deliverer_id) {
      this.pushService.notifyCourseCompleted({
        delivererId: completed.deliverer_id,
        courseReference: completed.reference,
        courseId: completed.id,
      });
    }

    this.logger.log(
      `Course ${completed.reference} COMPLETED (${success_count} livrée(s), ${fail_count} échec(s))`,
    );
  }

  private async emitDeliveryStatut(delivery: any, previous: DeliveryStatut) {
    const course = await this.prisma.course.findUnique({
      where: { id: delivery.course_id },
      select: { reference: true },
    });
    await this.courseEvent.deliveryStatutChanged({
      delivery,
      course_id: delivery.course_id,
      course_reference: course?.reference ?? '',
      previous_statut: previous,
      new_statut: delivery.statut,
    });
  }
}
