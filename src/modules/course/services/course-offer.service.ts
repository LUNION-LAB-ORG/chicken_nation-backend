import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Course,
  CourseOfferStatus,
  CourseStatut,
  DeliveryStatut,
  EntityStatus,
  OrderStatus,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererScoringSettingsHelper } from 'src/modules/deliverers/helpers/deliverer-scoring-settings.helper';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { DelivererQueueService } from 'src/modules/deliverers/services/deliverer-queue.service';
import { DelivererScoringService } from 'src/modules/deliverers/services/deliverer-scoring.service';

import { CourseEvent } from '../events/course.event';
import { CourseHelper } from '../helpers/course.helper';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';

interface CreateCourseFromOrdersInput {
  restaurantId: string;
  orderIds: string[];
}

/**
 * Service : création d'une Course à partir d'orders READY + algo d'affectation livreur.
 *
 * Séparé de CourseActionService pour respecter la séparation des responsabilités
 * (création/assignation vs transitions de statut une fois acceptée).
 */
@Injectable()
export class CourseOfferService {
  private readonly logger = new Logger(CourseOfferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseEvent: CourseEvent,
    private readonly helper: CourseHelper,
    private readonly settings: CourseSettingsHelper,
    private readonly scoringService: DelivererScoringService,
    private readonly queueService: DelivererQueueService,
    private readonly scoringSettings: DelivererScoringSettingsHelper,
    // P-push livreur : push "Nouvelle course !" CRITIQUE — l'événement le plus
    // important pour le livreur (vibration + son fort, ouvre directement le sheet).
    private readonly pushService: DelivererPushService,
  ) {}

  /**
   * Crée une Course à partir d'orders READY du même restaurant.
   * Génère les Delivery individuelles avec PIN client.
   * Déclenche immédiatement la recherche de livreur (offerNextDeliverer).
   */
  async createFromReadyOrders(input: CreateCourseFromOrdersInput): Promise<Course> {
    // 1. Récupérer et valider les orders
    const orders = await this.prisma.order.findMany({
      where: {
        id: { in: input.orderIds },
        restaurant_id: input.restaurantId,
        status: OrderStatus.READY,
        entity_status: { not: EntityStatus.DELETED },
        delivery: null, // pas déjà dans une Course
      },
      select: { id: true, delivery_fee: true, address: true },
    });

    if (orders.length === 0) {
      throw new BadRequestException('Aucune order éligible trouvée');
    }

    const totalFee = orders.reduce((sum, o) => sum + o.delivery_fee, 0);

    // 2. Créer la Course (retry sur collision unique sur reference)
    let course: Course | null = null;
    for (let attempt = 0; attempt < 3 && !course; attempt++) {
      try {
        course = await this.prisma.course.create({
          data: {
            reference: this.helper.generateReference(),
            pickup_code: this.helper.generatePickupCode(),
            restaurant_id: input.restaurantId,
            statut: CourseStatut.PENDING_ASSIGNMENT,
            total_delivery_fee: totalFee,
            deliveries: {
              create: orders.map((order, index) => ({
                order_id: order.id,
                sequence_order: index + 1,
                delivery_pin: this.helper.generateDeliveryPin(),
                statut: DeliveryStatut.PENDING,
              })),
            },
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002' && err?.meta?.target?.includes('reference')) continue;
        throw err;
      }
    }
    if (!course) throw new HttpException('Génération reference impossible', 500);

    this.logger.log(`Course ${course.reference} créée pour ${orders.length} order(s)`);

    // 3. Démarrer l'affectation
    await this.offerNextDeliverer(course.id);

    return course;
  }

  /**
   * Trouve le prochain livreur candidat et lui envoie une offer.
   * Si plus de candidats → marque la Course EXPIRED.
   *
   * **A1 Fix** : avant de chercher un nouveau candidat, on vérifie qu'aucune
   * offer PENDING n'est déjà active pour cette course. Évite que deux process
   * parallèles (cron expireOffers + rebalance + admin retry) ne créent deux
   * offers simultanées pour la même course.
   */
  async offerNextDeliverer(courseId: string): Promise<void> {
    const course = await this.prisma.course.findUniqueOrThrow({ where: { id: courseId } });

    if (course.statut !== CourseStatut.PENDING_ASSIGNMENT) {
      return; // déjà assignée/annulée
    }

    // A1 Fix : skip si une offer PENDING est déjà active sur cette course.
    // Sans ce check, le cron d'expiration peut re-trigger un offerNextDeliverer
    // pendant qu'un autre process (admin retry, rebalance) a déjà créé une
    // offer fraîche → 2 offers PENDING coexistent pour la même course.
    const activePending = await this.prisma.courseOfferAttempt.findFirst({
      where: {
        course_id: courseId,
        status: CourseOfferStatus.PENDING,
        expires_at: { gt: new Date() }, // pas encore expirée
      },
      select: { id: true, deliverer_id: true, expires_at: true },
    });
    if (activePending) {
      this.logger.debug(
        `offerNextDeliverer skipped : course=${course.reference} a déjà une offer PENDING (deliverer=${activePending.deliverer_id.slice(0, 8)}, expire ${activePending.expires_at.toISOString()})`,
      );
      return;
    }

    // Seuil de refus : au-delà, on expire la course au lieu de continuer à chercher
    const { maxRefusalCount } = await this.settings.load();
    if (course.refusal_count >= maxRefusalCount) {
      await this.prisma.course.update({
        where: { id: courseId },
        data: { statut: CourseStatut.EXPIRED, offer_expires_at: null },
      });
      this.logger.warn(
        `Course ${course.reference} : seuil de refus atteint (${course.refusal_count}/${maxRefusalCount}), EXPIRED`,
      );
      return;
    }

    // Livreurs ayant déjà refusé/expiré cette course : on les exclut
    const previousAttempts = await this.prisma.courseOfferAttempt.findMany({
      where: { course_id: courseId },
      select: { deliverer_id: true },
    });
    const excludedIds = previousAttempts.map((a) => a.deliverer_id);

    const candidate = await this.findBestDeliverer(course.restaurant_id, excludedIds);

    if (!candidate) {
      // Plus de livreurs disponibles → la course expire
      await this.prisma.course.update({
        where: { id: courseId },
        data: { statut: CourseStatut.EXPIRED, offer_expires_at: null },
      });
      this.logger.warn(`Course ${course.reference} : plus de livreur candidat, EXPIRED`);
      return;
    }

    await this.offerToDeliverer(courseId, candidate.id, candidate.isChainBonus);
  }

  /**
   * Sélection du meilleur livreur (Phase P4 — scoring multi-critères).
   *
   * Délégué au `DelivererScoringService` qui calcule un score composite :
   *   queue FIFO (équité) + distance GPS (efficacité) + chaînage (bonus fin
   *   imminente) + préférence véhicule − malus de refus récents.
   *
   * **P6d — Shadow mode** : si `deliverer.scoring_shadow_mode = true`, on calcule
   * quand même la décision du scoring pour la logger, puis on fallback sur
   * l'ancien algo `last_login_at DESC` pour la décision réelle. Permet de
   * valider la qualité du scoring sans risquer de perturber la prod.
   *
   * Poids configurables via `deliverer.score_weight_*` (admin → backoffice).
   */
  private async findBestDeliverer(restaurantId: string, excludedIds: string[]) {
    const { scoringShadowMode } = await this.scoringSettings.load();

    if (scoringShadowMode) {
      // Calcul scoring en parallèle de la décision legacy pour comparer.
      const [scoringBest, legacyBest] = await Promise.all([
        this.scoringService.pickBestCandidate({ restaurantId, excludeIds: excludedIds }),
        this.findBestDelivererLegacy(restaurantId, excludedIds),
      ]);

      const scoringId = scoringBest?.delivererId ?? null;
      const legacyId = legacyBest?.id ?? null;
      const diverge = scoringId !== legacyId;
      this.logger.warn(
        `[SHADOW MODE] scoring=${scoringId?.slice(0, 8) ?? 'null'} · legacy=${legacyId?.slice(0, 8) ?? 'null'}${diverge ? ' 🔀 DIVERGE' : ''}`,
      );
      return legacyBest ? { id: legacyBest.id, isChainBonus: false } : null;
    }

    const best = await this.scoringService.pickBestCandidate({
      restaurantId,
      excludeIds: excludedIds,
    });
    if (!best) return null;
    return {
      id: best.delivererId,
      // Composante chain > 0 ⇔ candidat sélectionné via le pool chainable
      // (sa course actuelle se termine imminemment + restaurant proche).
      isChainBonus: best.components.chain > 0,
    };
  }

  /** Ancien algo (avant P4) — conservé pour le shadow mode P6d. */
  private async findBestDelivererLegacy(restaurantId: string, excludedIds: string[]) {
    const now = new Date();
    return this.prisma.deliverer.findFirst({
      where: {
        restaurant_id: restaurantId,
        is_operational: true,
        status: 'ACTIVE',
        entity_status: EntityStatus.ACTIVE,
        id: { notIn: excludedIds },
        // Exclure les livreurs en pause manuelle ou en pause automatique (refus répétés)
        AND: [
          { OR: [{ pause_until: null }, { pause_until: { lt: now } }] },
          { OR: [{ auto_pause_until: null }, { auto_pause_until: { lt: now } }] },
        ],
        courses: {
          none: {
            statut: {
              in: [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY],
            },
          },
        },
      },
      orderBy: { last_login_at: 'desc' },
      select: { id: true },
    });
  }

  /**
   * Crée une CourseOfferAttempt + push WS pour proposer la course à un livreur.
   *
   * **A1 Fix** : transaction atomique avec :
   *   1. check préalable d'une PENDING déjà active pour le couple (course, deliverer)
   *   2. fallback gracieux sur P2002 (violation du partial unique index DB)
   * Garantit l'idempotence même sous appels concurrents.
   *
   * @param isChainBonus `true` si la sélection vient du pool chainable
   *   (livreur en fin de course imminente, restaurant proche). Diffusé au mobile
   *   pour afficher un badge explicatif "Chaînage" sur l'écran d'offre.
   */
  /**
   * @param forceResend `true` (admin force-assign) : si une offer PENDING existe déjà
   * pour ce couple course+livreur, on ré-émet quand même le WS au lieu de silencer.
   * Permet à l'admin de "relancer" la notification si le livreur n'a pas vu la première.
   */
  async offerToDeliverer(
    courseId: string,
    delivererId: string,
    isChainBonus = false,
    forceResend = false,
  ): Promise<void> {
    const { offerDurationSeconds } = await this.settings.load();
    const expiresAt = new Date(Date.now() + offerDurationSeconds * 1000);

    let course;
    let wasExisting = false;

    try {
      course = await this.prisma.$transaction(async (tx) => {
        // Check intra-transaction : aucune offer PENDING pour ce couple.
        // Le partial unique index DB est la garantie ultime, mais ce check
        // évite l'exception P2002 dans le cas nominal.
        const existing = await tx.courseOfferAttempt.findFirst({
          where: {
            course_id: courseId,
            deliverer_id: delivererId,
            status: CourseOfferStatus.PENDING,
          },
          select: { id: true },
        });

        if (existing) {
          if (!forceResend) {
            this.logger.warn(
              `offerToDeliverer SKIP : doublon évité (course=${courseId.slice(0, 8)}, deliverer=${delivererId.slice(0, 8)}, existing=${existing.id.slice(0, 8)})`,
            );
            return null;
          }
          // Admin force-assign : offer déjà PENDING → on ré-émet le WS sans créer de doublon
          this.logger.log(
            `offerToDeliverer RESEND (force) : offer PENDING existante re-notifiée (course=${courseId.slice(0, 8)}, deliverer=${delivererId.slice(0, 8)})`,
          );
          wasExisting = true;
          // Retourner le course complet pour ré-émettre l'event
          return tx.course.findUnique({
            where: { id: courseId },
            include: COURSE_FULL_INCLUDE,
          });
        }

        await tx.courseOfferAttempt.create({
          data: {
            course_id: courseId,
            deliverer_id: delivererId,
            status: CourseOfferStatus.PENDING,
            expires_at: expiresAt,
          },
        });

        return tx.course.update({
          where: { id: courseId },
          data: { offer_expires_at: expiresAt },
          include: COURSE_FULL_INCLUDE,
        });
      });
    } catch (err: any) {
      // Garde-fou : si malgré le check intra-tx, l'index DB rejette l'insert
      // (course race entre deux transactions concurrentes), on log et on sort
      // proprement sans propager.
      if (err?.code === 'P2002' && err?.meta?.target?.includes('CourseOfferAttempt_pending_unique')) {
        this.logger.warn(
          `offerToDeliverer SKIP : violation partial unique index (course=${courseId.slice(0, 8)}, deliverer=${delivererId.slice(0, 8)})`,
        );
        return;
      }
      throw err;
    }

    if (!course) return; // doublon évité silencieusement

    await this.courseEvent.offerNew({
      course,
      deliverer_id: delivererId,
      offer_id: courseId, // simplification : on utilise course_id
      // Pour un re-send : réutiliser l'expiry actuelle (non modifiée)
      expires_at: wasExisting ? (course as any).offer_expires_at ?? expiresAt : expiresAt,
      is_chain_bonus: isChainBonus,
    });

    // P-push livreur : push CRITIQUE pour réveiller le livreur même app fermée.
    // L'event WS est instantané (mobile ouverte) MAIS sans push, un livreur
    // qui a fermé son app rate l'offre. Le tap sur la notif → app ouverte
    // sur l'accueil où le sheet "Nouvelle demande" s'affiche via le WS.
    this.pushService.notifyNewCourseOffer({
      delivererId,
      courseReference: course.reference,
      restaurantName: (course as any).restaurant?.name ?? 'le restaurant',
      courseId: course.id,
    });

    this.logger.log(
      `Course ${course.reference} proposée à ${delivererId}${isChainBonus ? ' [CHAIN]' : ''} (expire ${expiresAt.toISOString()})`,
    );
  }

  /**
   * Marque les offers PENDING échues comme EXPIRED et déclenche le retry.
   * Appelée par CourseTask (cron) toutes les 10s.
   */
  async expirePendingOffers(): Promise<number> {
    const now = new Date();
    const expired = await this.prisma.courseOfferAttempt.findMany({
      where: { status: CourseOfferStatus.PENDING, expires_at: { lte: now } },
      select: { id: true, course_id: true, deliverer_id: true },
    });

    if (expired.length === 0) return 0;

    await this.prisma.courseOfferAttempt.updateMany({
      where: { id: { in: expired.map((e) => e.id) } },
      data: { status: CourseOfferStatus.EXPIRED, responded_at: now },
    });

    // P5 : pénalité queue pour chaque livreur qui a laissé l'offer expirer (ignore).
    // Traité comme un refus silencieux. Les erreurs sur un livreur ne bloquent pas
    // le traitement des autres.
    for (const e of expired) {
      try {
        await this.queueService.onOfferExpired(e.deliverer_id);
      } catch (err) {
        this.logger.warn(
          `Pénalité queue échouée pour ${e.deliverer_id}: ${(err as Error).message}`,
        );
      }
    }

    // Incrémenter refusal_count + retry pour chaque course
    const courseIds = [...new Set(expired.map((e) => e.course_id))];
    for (const cid of courseIds) {
      await this.prisma.course.update({
        where: { id: cid },
        data: { refusal_count: { increment: 1 } },
      });
      await this.offerNextDeliverer(cid);
    }

    this.logger.log(`${expired.length} offer(s) expirée(s) traitée(s)`);
    return expired.length;
  }

  /**
   * Relance une Course EXPIRED : reset les tentatives précédentes pour que TOUS
   * les livreurs redeviennent candidats (y compris ceux qui avaient refusé).
   * Usage : admin backoffice via bouton "Relancer" sur une course expirée.
   *
   * - Vide `courseOfferAttempt` pour cette course (historique reset)
   * - Reset `refusal_count` à 0
   * - Repasse `statut` à PENDING_ASSIGNMENT
   * - Relance `offerNextDeliverer` pour trouver un livreur
   *
   * @throws BadRequestException si la course n'est pas EXPIRED
   */
  async retryExpiredCourse(courseId: string): Promise<void> {
    const course = await this.prisma.course.findUniqueOrThrow({ where: { id: courseId } });

    if (course.statut !== CourseStatut.EXPIRED) {
      throw new BadRequestException(
        `Seules les courses EXPIRED peuvent être relancées (statut actuel : ${course.statut})`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.courseOfferAttempt.deleteMany({ where: { course_id: courseId } }),
      this.prisma.course.update({
        where: { id: courseId },
        data: {
          statut: CourseStatut.PENDING_ASSIGNMENT,
          refusal_count: 0,
          offer_expires_at: null,
        },
      }),
    ]);

    this.logger.log(`Course ${course.reference} relancée manuellement par admin — reset des tentatives`);

    await this.offerNextDeliverer(courseId);
  }

  /** Accès direct au helper pour les autres services du module */
  getHelper() {
    return this.helper;
  }
}
