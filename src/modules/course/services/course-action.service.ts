import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CourseOfferStatus,
  CourseStatut,
  DeliveryStatut,
  OrderStatus,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { DelivererQueueService } from 'src/modules/deliverers/services/deliverer-queue.service';

import { CancelCourseDto } from '../dto/cancel-course.dto';
import { ConfirmDeliveryDto } from '../dto/confirm-delivery.dto';
import { FailDeliveryDto } from '../dto/fail-delivery.dto';
import { RefuseOfferDto } from '../dto/refuse-offer.dto';
import { ValidatePickupDto } from '../dto/validate-pickup.dto';
import { CourseEvent } from '../events/course.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { CourseOfferService } from './course-offer.service';

/**
 * Service : transitions de statut d'une Course + actions sur les Delivery.
 * Utilise CourseOfferService pour le retry après refus.
 */
@Injectable()
export class CourseActionService {
  private readonly logger = new Logger(CourseActionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseEvent: CourseEvent,
    private readonly offerService: CourseOfferService,
    private readonly queueService: DelivererQueueService,
    // P-push livreur : envoi de push notifications aux livreurs sur les events critiques
    private readonly pushService: DelivererPushService,
  ) {}

  // ============================================================
  // OFFER : accept / refuse
  // ============================================================

  /** Le livreur accepte une offer → devient sa course active */
  async acceptOffer(courseId: string, delivererId: string) {
    const offer = await this.prisma.courseOfferAttempt.findFirst({
      where: {
        course_id: courseId,
        deliverer_id: delivererId,
        status: CourseOfferStatus.PENDING,
        expires_at: { gt: new Date() },
      },
    });
    if (!offer) {
      throw new BadRequestException('Offer invalide, expirée ou déjà traitée');
    }

    const [, course] = await this.prisma.$transaction([
      this.prisma.courseOfferAttempt.update({
        where: { id: offer.id },
        data: { status: CourseOfferStatus.ACCEPTED, responded_at: new Date() },
      }),
      this.prisma.course.update({
        where: { id: courseId },
        data: {
          deliverer_id: delivererId,
          statut: CourseStatut.ACCEPTED,
          assigned_at: new Date(),
          offer_expires_at: null,
        },
        include: COURSE_FULL_INCLUDE,
      }),
    ]);

    // P5 : sortie de la queue FIFO (le livreur est maintenant "en activité").
    await this.queueService.onAccept(delivererId);

    await this.courseEvent.courseAssigned({ course });

    // P-push livreur : confirmation d'acceptation (utile si l'app était fermée
    // au moment du tap accept, ou par sécurité si le sheet d'offre se ferme mal).
    this.pushService.notifyCourseAssigned({
      delivererId,
      courseReference: course.reference,
      restaurantName: (course as any).restaurant?.name ?? 'le restaurant',
      courseId: course.id,
    });

    this.logger.log(`Course ${course.reference} acceptée par ${delivererId}`);
    return course;
  }

  /** Le livreur refuse une offer → retry sur prochain livreur */
  async refuseOffer(courseId: string, delivererId: string, dto: RefuseOfferDto) {
    const offer = await this.prisma.courseOfferAttempt.findFirst({
      where: {
        course_id: courseId,
        deliverer_id: delivererId,
        status: CourseOfferStatus.PENDING,
      },
    });
    if (!offer) {
      throw new BadRequestException('Offer invalide ou déjà traitée');
    }

    await this.prisma.courseOfferAttempt.update({
      where: { id: offer.id },
      data: {
        status: CourseOfferStatus.REFUSED,
        responded_at: new Date(),
        refusal_reason: dto.reason,
      },
    });

    await this.prisma.course.update({
      where: { id: courseId },
      data: { refusal_count: { increment: 1 } },
    });

    // P5 : pénalité queue + check auto-pause éventuelle (logique interne)
    await this.queueService.onRefuse(delivererId);

    await this.offerService.offerNextDeliverer(courseId);
    this.logger.log(`Course ${courseId} refusée par ${delivererId}, retry lancé`);
    return { success: true };
  }

  // ============================================================
  // COURSE : transitions phase "restaurant"
  // ============================================================

  /** Livreur arrivé au restaurant (ACCEPTED → AT_RESTAURANT) */
  async markAtRestaurant(courseId: string, delivererId: string) {
    const course = await this.assertOwnedCourse(courseId, delivererId, CourseStatut.ACCEPTED);
    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: {
        statut: CourseStatut.AT_RESTAURANT,
        at_restaurant_at: new Date(),
      },
      include: COURSE_FULL_INCLUDE,
    });
    await this.courseEvent.courseStatutChanged({
      course: updated,
      previous_statut: CourseStatut.ACCEPTED,
      new_statut: CourseStatut.AT_RESTAURANT,
    });
    return updated;
  }

  /** Colis récupérés au resto (AT_RESTAURANT → IN_DELIVERY + Orders → PICKED_UP) */
  async markPickedUp(courseId: string, delivererId: string) {
    const course = await this.assertOwnedCourse(courseId, delivererId, CourseStatut.AT_RESTAURANT);

    const now = new Date();
    const [updatedCourse] = await this.prisma.$transaction([
      this.prisma.course.update({
        where: { id: courseId },
        data: { statut: CourseStatut.IN_DELIVERY, picked_up_at: now },
        include: COURSE_FULL_INCLUDE,
      }),
      // Propage le statut PICKED_UP + timestamp sur chaque Order (côté cuisine/client)
      this.prisma.order.updateMany({
        where: { delivery: { course_id: courseId } },
        data: { status: OrderStatus.PICKED_UP, picked_up_at: now },
      }),
    ]);

    await this.courseEvent.courseStatutChanged({
      course: updatedCourse,
      previous_statut: CourseStatut.AT_RESTAURANT,
      new_statut: CourseStatut.IN_DELIVERY,
    });
    return updatedCourse;
  }

  /** Annulation de la course par le livreur ou admin */
  async cancelCourse(courseId: string, cancelledBy: string, dto: CancelCourseDto) {
    const course = await this.prisma.course.findUniqueOrThrow({
      where: { id: courseId },
      include: COURSE_FULL_INCLUDE,
    });

    const terminal: CourseStatut[] = [
      CourseStatut.COMPLETED,
      CourseStatut.CANCELLED,
      CourseStatut.EXPIRED,
    ];
    if (terminal.includes(course.statut)) {
      throw new BadRequestException('Course déjà terminée');
    }

    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.course.update({
        where: { id: courseId },
        data: {
          statut: CourseStatut.CANCELLED,
          cancelled_at: now,
          cancelled_by: cancelledBy,
          cancelled_reason: dto.reason,
        },
        include: COURSE_FULL_INCLUDE,
      }),
      // Propage CANCELLED aux Deliveries non terminales
      this.prisma.delivery.updateMany({
        where: {
          course_id: courseId,
          statut: { notIn: [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED, DeliveryStatut.CANCELLED] },
        },
        data: { statut: DeliveryStatut.CANCELLED },
      }),
      // Propage CANCELLED + traçabilité aux Orders dont la Delivery n'est pas terminale
      this.prisma.order.updateMany({
        where: {
          delivery: {
            course_id: courseId,
            statut: { notIn: [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED, DeliveryStatut.CANCELLED] },
          },
          status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] },
        },
        data: {
          status: OrderStatus.CANCELLED,
          cancelled_at: now,
          cancelled_by: cancelledBy,
          cancelled_reason: dto.reason ?? 'Course annulée',
        },
      }),
    ]);

    await this.courseEvent.courseCancelled({ course: updated, cancelled_by: cancelledBy, reason: dto.reason });

    // P-push livreur : alerte si un livreur était assigné (course CANCELLED en cours d'exécution).
    // Le mapping `cancelled_by` → label humain pour le push :
    //   - "admin" / "system" / "restaurant" → label tel quel
    //   - "deliverer" → c'est lui-même qui a annulé, pas la peine de notifier
    if (updated.deliverer_id && cancelledBy !== 'deliverer') {
      const labelByWho: Record<string, string> = {
        admin: "l'administration",
        system: 'le système',
        restaurant: 'le restaurant',
      };
      this.pushService.notifyCourseCancelled({
        delivererId: updated.deliverer_id,
        courseReference: updated.reference,
        cancelledBy: labelByWho[cancelledBy] ?? cancelledBy,
        courseId: updated.id,
      });
    }

    return updated;
  }

  // ============================================================
  // VALIDATION CAISSIÈRE (via pickup_code)
  // ============================================================

  /**
   * Flow unique déclenché par la caissière dans le backoffice :
   * elle saisit le pickup_code dicté par le livreur → on enchaîne en cascade :
   *   Course ACCEPTED/AT_RESTAURANT → IN_DELIVERY
   *   Orders READY → PICKED_UP (+ picked_up_at)
   *   Remplace l'ancienne action livreur `markPickedUp` (supprimée côté mobile).
   *
   * Préconditions : toutes les Orders liées doivent être READY (sinon 400).
   */
  async validatePickupByCashier(dto: ValidatePickupDto) {
    const activeStatuts: CourseStatut[] = [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT];

    const course = await this.prisma.course.findFirst({
      where: { pickup_code: dto.pickup_code, statut: { in: activeStatuts } },
      include: COURSE_FULL_INCLUDE,
      orderBy: { assigned_at: 'desc' },
    });

    if (!course) {
      throw new NotFoundException('Aucune course active trouvée pour ce code de retrait');
    }

    // Toutes les commandes doivent être READY
    const notReady = course.deliveries.filter((d) => d.order.status !== OrderStatus.READY);
    if (notReady.length > 0) {
      throw new BadRequestException(
        `${notReady.length} commande(s) sur ${course.deliveries.length} ne sont pas encore prête(s)`,
      );
    }

    const now = new Date();
    const previousStatut = course.statut;
    const [updated] = await this.prisma.$transaction([
      this.prisma.course.update({
        where: { id: course.id },
        data: {
          statut: CourseStatut.IN_DELIVERY,
          // Si le livreur n'a pas encore déclenché at_restaurant (pas de GPS ou GPS tardif),
          // on le marque au moment de la validation pour garder la traçabilité
          at_restaurant_at: course.at_restaurant_at ?? now,
          picked_up_at: now,
        },
        include: COURSE_FULL_INCLUDE,
      }),
      // Orders : READY → PICKED_UP + timestamp
      this.prisma.order.updateMany({
        where: { delivery: { course_id: course.id } },
        data: { status: OrderStatus.PICKED_UP, picked_up_at: now },
      }),
    ]);

    // Émet l'event WS pour que le mobile livreur et le backoffice se synchronisent
    await this.courseEvent.courseStatutChanged({
      course: updated,
      previous_statut: previousStatut,
      new_statut: CourseStatut.IN_DELIVERY,
    });

    // P-push livreur : alerte "tu peux partir, la caissière a validé".
    // Critique pour les livreurs qui ne regardent pas leur écran en attendant.
    if (updated.deliverer_id) {
      this.pushService.notifyPickupValidated({
        delivererId: updated.deliverer_id,
        courseReference: updated.reference,
        courseId: updated.id,
      });
    }

    this.logger.log(
      `Course ${updated.reference} validée par caissière (code ${dto.pickup_code}) — ${course.deliveries.length} order(s) → PICKED_UP`,
    );

    return updated;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /** Vérifie que la course appartient au livreur + est dans le bon statut */
  private async assertOwnedCourse(courseId: string, delivererId: string, expected: CourseStatut) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course non trouvée');
    if (course.deliverer_id !== delivererId) {
      throw new ForbiddenException("Cette course ne vous est pas affectée");
    }
    if (course.statut !== expected) {
      throw new BadRequestException(`Statut attendu ${expected}, actuel ${course.statut}`);
    }
    return course;
  }
}
