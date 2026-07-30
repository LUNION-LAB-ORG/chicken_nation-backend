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
  DeliveryService,
  DeliveryStatut,
  EntityStatus,
  OrderStatus,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';
import { TurboService } from 'src/turbo/services/turbo.service';
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
    // Alerte cloche staff quand aucun livreur n'est trouvé (NotificationsModule
    // est @Global : pas d'import de module nécessaire).
    private readonly notificationsSender: NotificationsSenderService,
    // Flotte externe : sous-traitance quand la flotte interne est saturée.
    private readonly turboService: TurboService,
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
      select: { id: true, delivery_fee: true, address: true, delivery_service: true },
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

    // 3. Démarrer l'affectation — bifurcation par flotte (le batching ne
    //    mélange jamais les services dans une même course) :
    //    - TURBO          → envoi du GROUPE à Turbo (protocole unifié : code de
    //                       retrait + referenceCourse, un livreur accepte en bloc) ;
    //    - CHICKEN_NATION → offres aux livreurs internes (inchangé).
    const isTurboNative = orders.every(
      (o) => o.delivery_service === DeliveryService.TURBO,
    );
    if (isTurboNative) {
      await this.escalateToTurbo(course.id, 0, { nativeTurbo: true });
    } else {
      await this.offerNextDeliverer(course.id);
    }

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
      // AUCUN livreur disponible (tous occupés / hors service / en pause, ou
      // tous ont déjà refusé). On NE l'expire PLUS en silence : la course RESTE
      // en PENDING_ASSIGNMENT, `retryUnassignedCourses` (cron) re-cherchera un
      // livreur, alertera le staff après `no_deliverer_alert_after_min`, et
      // n'expirera qu'au-delà de `no_deliverer_max_wait_min`.
      await this.prisma.course.update({
        where: { id: courseId },
        data: { offer_expires_at: null },
      });
      this.logger.warn(
        `Course ${course.reference} : aucun livreur candidat pour l'instant — maintenue en attente (relance auto)`,
      );
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
   * RELANCES de l'offre pendant la fenêtre d'acceptation (cron, 10 s).
   *
   * Une notification unique ne laisse au livreur QU'UNE chance de voir l'offre :
   * s'il est distrait à cet instant (téléphone en poche, moteur allumé, casque),
   * la course lui échappe alors qu'il était disponible — c'est la première cause
   * d'offres manquées. On le re-sollicite donc à 30 s et 60 s, avec le temps
   * restant affiché pour créer l'urgence.
   *
   * Idempotent et sûr à deux backends : le compteur `reminders_sent` est
   * incrémenté par un claim atomique (conditionné sur sa valeur précédente),
   * donc une relance ne part JAMAIS deux fois.
   */
  async remindPendingOffers(): Promise<number> {
    const now = new Date();
    /** Secondes écoulées depuis l'envoi déclenchant une relance. */
    const PALIERS = [30, 60];

    const offers = await this.prisma.courseOfferAttempt.findMany({
      where: { status: CourseOfferStatus.PENDING, expires_at: { gt: now } },
      select: {
        id: true,
        deliverer_id: true,
        offered_at: true,
        expires_at: true,
        reminders_sent: true,
        course: {
          select: { id: true, reference: true, restaurant: { select: { name: true } } },
        },
      },
      take: 100, // garde-fou
    });

    let sent = 0;
    for (const offer of offers) {
      const ecoule = (now.getTime() - offer.offered_at.getTime()) / 1000;
      const dus = PALIERS.filter((p) => ecoule >= p).length;
      if (dus <= offer.reminders_sent) continue;

      // Claim atomique : un seul backend envoie la relance.
      const claim = await this.prisma.courseOfferAttempt.updateMany({
        where: {
          id: offer.id,
          reminders_sent: offer.reminders_sent,
          status: CourseOfferStatus.PENDING,
        },
        data: { reminders_sent: dus },
      });
      if (claim.count !== 1) continue;

      const restant = Math.max(
        1,
        Math.round((offer.expires_at.getTime() - now.getTime()) / 1000),
      );
      this.pushService.notifyCourseOfferReminder({
        delivererId: offer.deliverer_id,
        courseReference: offer.course.reference,
        restaurantName: offer.course.restaurant?.name ?? 'Le restaurant',
        courseId: offer.course.id,
        secondsLeft: restant,
      });
      sent++;
    }

    return sent;
  }

  /**
   * RELANCE des courses restées SANS LIVREUR (cron, toutes les 30 s).
   *
   * Une course tombe ici quand `offerNextDeliverer` n'a trouvé aucun candidat
   * (tous occupés / hors service / en pause). Au lieu d'expirer en silence, elle
   * reste PENDING_ASSIGNMENT et on :
   *   1. re-cherche un livreur à chaque passage (un livreur se libère → il est pris)
   *   2. ALERTE le staff (cloche) une seule fois passé `no_deliverer_alert_after_min`
   *   3. expire pour de bon au-delà de `no_deliverer_max_wait_min` (anti-zombie)
   *
   * Les courses ayant une offer PENDING active sont ignorées (`offerNextDeliverer`
   * sort tout seul, mais on évite le bruit).
   */
  async retryUnassignedCourses(): Promise<number> {
    const settings = await this.settings.load();
    const now = new Date();

    const waiting = await this.prisma.course.findMany({
      where: {
        statut: CourseStatut.PENDING_ASSIGNMENT,
        // Déjà sous-traitée à Turbo → plus aucune recherche de livreur interne
        // (la course vit désormais au rythme des webhooks Turbo).
        turbo_escalated_at: null,
        // Aucune offer en cours : soit jamais proposée, soit toutes échues.
        offer_attempts: {
          none: { status: CourseOfferStatus.PENDING, expires_at: { gt: now } },
        },
      },
      select: {
        id: true,
        reference: true,
        created_at: true,
        no_deliverer_alerted_at: true,
        restaurant_id: true,
        offer_expires_at: true,
        deliveries: {
          select: { order: { select: { delivery_service: true } } },
        },
      },
      orderBy: { created_at: 'asc' }, // la plus ancienne d'abord (équité client)
      take: 50, // garde-fou
    });

    let retried = 0;
    for (const course of waiting) {
      const waitingMin = (now.getTime() - course.created_at.getTime()) / 60000;

      // 1. Garde-fou anti-zombie : au-delà du plafond, on expire réellement.
      //    Claim ATOMIQUE (conditionné sur le statut) : deux backends tournent
      //    en parallèle sur la même base, un update non conditionné écraserait
      //    une course entre-temps acceptée par un livreur.
      if (waitingMin >= settings.noDelivererMaxWaitMin) {
        const claimed = await this.prisma.course.updateMany({
          where: { id: course.id, statut: CourseStatut.PENDING_ASSIGNMENT },
          data: { statut: CourseStatut.EXPIRED, offer_expires_at: null },
        });
        if (claimed.count === 1) {
          this.logger.warn(
            `Course ${course.reference} : aucun livreur depuis ${Math.round(waitingMin)} min → EXPIRED`,
          );
        }
        continue;
      }

      // 1bis. COURSE TURBO D'ORIGINE encore non transmise (échec d'envoi au
      //       flush) : on RE-TENTE l'envoi du groupe — jamais d'offres internes
      //       sur ces courses. `offer_expires_at` = « pas avant » (cadence ~2
      //       min posée à l'échec précédent) ; cloche coupée sur les relances
      //       (la première tentative a déjà alerté). L'alerte staff (étape 3)
      //       reste active si rien ne passe.
      const isTurboNative =
        course.deliveries.length > 0 &&
        course.deliveries.every(
          (d) => d.order.delivery_service === DeliveryService.TURBO,
        );
      if (isTurboNative) {
        if (!course.offer_expires_at || course.offer_expires_at <= now) {
          const escalated = await this.escalateToTurbo(course.id, Math.round(waitingMin), {
            nativeTurbo: true,
            muteFailureBell: true,
          });
          if (escalated) {
            retried++;
            continue;
          }
        }
        // Alerte staff « toujours rien » — même claim atomique que l'interne.
        if (
          !course.no_deliverer_alerted_at &&
          waitingMin >= settings.noDelivererAlertAfterMin
        ) {
          const alertClaim = await this.prisma.course.updateMany({
            where: { id: course.id, no_deliverer_alerted_at: null },
            data: { no_deliverer_alerted_at: now },
          });
          if (alertClaim.count === 1) {
            this.notificationsSender
              .sendCourseNoDelivererBell({
                courseId: course.id,
                reference: course.reference,
                restaurantId: course.restaurant_id,
                waitingMinutes: Math.round(waitingMin),
              })
              .catch((e) =>
                this.logger.warn(`Alerte « course Turbo en attente » non envoyée : ${e?.message}`),
              );
          }
        }
        continue; // jamais d'offres internes pour une course TURBO
      }

      // 2. SATURATION INTERNE → bascule sur la flotte externe Turbo.
      //    Se produit AVANT l'alerte staff : si Turbo prend la course, il n'y a
      //    plus rien à signaler. L'alerte reste le filet si Turbo échoue aussi.
      if (
        settings.turboFallbackEnabled &&
        waitingMin >= settings.turboFallbackAfterMin
      ) {
        const escalated = await this.escalateToTurbo(course.id, Math.round(waitingMin));
        if (escalated) continue; // sous-traitée : plus de recherche interne
        // Turbo indisponible → on poursuit (alerte + relance interne)
      }

      // 3. Alerte staff — UNE SEULE FOIS, y compris avec 2 backends : le claim
      //    atomique (`no_deliverer_alerted_at: null`) désigne un seul gagnant.
      if (
        !course.no_deliverer_alerted_at &&
        waitingMin >= settings.noDelivererAlertAfterMin
      ) {
        const alertClaim = await this.prisma.course.updateMany({
          where: { id: course.id, no_deliverer_alerted_at: null },
          data: { no_deliverer_alerted_at: now },
        });
        if (alertClaim.count === 1) {
          this.notificationsSender
            .sendCourseNoDelivererBell({
              courseId: course.id,
              reference: course.reference,
              restaurantId: course.restaurant_id,
              waitingMinutes: Math.round(waitingMin),
            })
            .catch((e) =>
              this.logger.warn(`Alerte « aucun livreur » non envoyée : ${e?.message}`),
            );
        }
      }

      // 4. Nouvelle tentative d'affectation (best-effort, on n'interrompt pas la boucle).
      try {
        await this.offerNextDeliverer(course.id);
        retried++;
      } catch (err) {
        this.logger.warn(
          `Relance affectation échouée pour ${course.reference}: ${(err as Error).message}`,
        );
      }
    }

    return retried;
  }

  /**
   * SATURATION INTERNE → sous-traite la course à la flotte externe TURBO.
   *
   * Décisions produit actées :
   *   - **Turbo choisit le livreur** (BIRD rayon 3-5 km / score, puis ASSIGNÉ du
   *     site le plus proche). CN ne réimplémente PAS son dispatcher : on appelle
   *     `creerCourse` et Turbo applique sa règle avec ses données temps réel.
   *   - **Dégroupage** : l'API Turbo prend UNE commande par course → on émet une
   *     course Turbo par commande de la course interne.
   *
   * ⚠️ On NE réutilise PAS `cancelCourse` : il annulerait les COMMANDES CLIENTS.
   * Ici les commandes restent vivantes (READY) — ce sont les webhooks Turbo qui
   * piloteront ensuite leur statut (PICKED_UP → COMPLETED).
   *
   * Renvoie `true` si au moins une commande est passée chez Turbo. Si Turbo est
   * injoignable, renvoie `false` : la course reste en recherche interne + alerte
   * staff (on ne perd jamais la commande).
   */
  /**
   * BASCULE MANUELLE vers Turbo, déclenchée depuis le back office.
   *
   * Même mécanique que la bascule automatique, mais a l'initiative d'un humain :
   * le staff voit qu'aucun livreur interne ne se libérera (fin de service, pic
   * d'activité) et n'attend pas le délai automatique.
   */
  async basculerVersTurbo(courseId: string): Promise<{ ok: boolean; message: string }> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        reference: true,
        statut: true,
        turbo_escalated_at: true,
        created_at: true,
        deliveries: { select: { order: { select: { delivery_service: true } } } },
      },
    });
    if (!course) throw new NotFoundException('Course introuvable');

    if (course.turbo_escalated_at) {
      return { ok: false, message: 'Cette course est déjà confiée à Turbo.' };
    }
    if (course.statut !== CourseStatut.PENDING_ASSIGNMENT) {
      throw new BadRequestException(
        "Seule une course en recherche de livreur peut être confiée à Turbo. " +
          "Annulez d'abord l'affectation en cours.",
      );
    }

    const attente = Math.max(
      0,
      Math.round((Date.now() - course.created_at.getTime()) / 60000),
    );
    // Course TURBO d'origine (relance manuelle pendant la fenêtre de retry) :
    // un échec ne doit PAS rebasculer ses commandes en interne.
    const isTurboNative =
      course.deliveries.length > 0 &&
      course.deliveries.every((d) => d.order.delivery_service === DeliveryService.TURBO);
    const ok = await this.escalateToTurbo(courseId, attente, { nativeTurbo: isTurboNative });
    return ok
      ? { ok: true, message: `Course ${course.reference} confiée à Turbo.` }
      : {
          ok: false,
          message:
            "Turbo n'a pas accepté la course. Elle reste en recherche interne, réessayez plus tard.",
        };
  }

  /**
   * RETOUR EN INTERNE, déclenché depuis le back office.
   *
   * Reprend une course confiée a Turbo pour la reproposer aux livreurs Chicken
   * Nation. Séquence sécurisée « jamais deux livreurs » :
   *   1. gardes locales (aucun livreur Turbo connu via webhooks) ;
   *   2. ANNULATION du groupe CHEZ TURBO (`/annuler`, contrat validé) — 409 =
   *      un livreur a déjà accepté chez eux → reprise REFUSÉE ; issue
   *      incertaine (réseau) → reprise REFUSÉE aussi (leur course est
   *      peut-être vivante) ;
   *   3. bascule locale + ROTATION de la référence : la dédup Turbo consomme
   *      définitivement toute referenceCourse déjà reçue (même annulée) — un
   *      futur « Confier à Turbo » doit donc partir avec une référence VIERGE,
   *      sinon il serait accepté en replay no-op (groupe mort, aucun livreur).
   */
  async revenirEnInterne(courseId: string): Promise<{ ok: boolean; message: string }> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        reference: true,
        statut: true,
        turbo_escalated_at: true,
        restaurant: { select: { apikey: true } },
        deliveries: { select: { order_id: true, turbo_courier_id: true } },
      },
    });
    if (!course) throw new NotFoundException('Course introuvable');

    if (!course.turbo_escalated_at) {
      return { ok: false, message: "Cette course n'a pas été confiée à Turbo." };
    }
    if (course.statut !== CourseStatut.PENDING_ASSIGNMENT) {
      throw new BadRequestException(
        "Un livreur Turbo a déjà pris cette course : impossible de la reprendre sans " +
          "risquer deux livreurs sur la même commande. Annulez-la plutôt.",
      );
    }
    const dejaAffectee = course.deliveries.some((d) => d.turbo_courier_id);
    if (dejaAffectee) {
      throw new BadRequestException(
        'Un livreur Turbo est déjà affecté à cette course. Reprise impossible.',
      );
    }

    // 2. Annuler le groupe CHEZ TURBO avant toute bascule locale.
    const annulation = await this.turboService.annulerCourseGroupe({
      referenceCourse: course.reference,
      apikey: course.restaurant.apikey ?? '',
    });
    if (!annulation.ok) {
      if (annulation.courierAssigned) {
        return {
          ok: false,
          message:
            'Turbo refuse l\'annulation : un livreur a déjà accepté la mission chez eux. Reprise impossible.',
        };
      }
      return {
        ok: false,
        message:
          "Impossible de confirmer l'annulation côté Turbo (réseau). Reprise refusée pour " +
          'éviter deux livreurs sur la même commande — réessayez dans un instant.',
      };
    }

    // 3. Bascule locale + rotation de référence (dédup Turbo — cf. docstring).
    const ancienneReference = course.reference;
    let rotated = false;
    for (let attempt = 0; attempt < 3 && !rotated; attempt++) {
      try {
        await this.prisma.$transaction([
          this.prisma.order.updateMany({
            where: { id: { in: course.deliveries.map((d) => d.order_id) } },
            data: { delivery_service: DeliveryService.CHICKEN_NATION },
          }),
          this.prisma.course.update({
            where: { id: courseId },
            data: {
              turbo_escalated_at: null,
              no_deliverer_alerted_at: null,
              reference: this.helper.generateReference(),
            },
          }),
        ]);
        rotated = true;
      } catch (err: any) {
        if (err?.code === 'P2002' && err?.meta?.target?.includes('reference')) continue;
        throw err;
      }
    }
    if (!rotated) throw new HttpException('Génération reference impossible', 500);

    // Relance immédiate de la recherche interne.
    await this.offerNextDeliverer(courseId).catch(() => undefined);

    this.logger.log(
      `Course ${ancienneReference} reprise en interne depuis Turbo (groupe annulé chez eux, nouvelle référence attribuée).`,
    );
    return {
      ok: true,
      message: `Course ${ancienneReference} reprise en interne — le groupe Turbo a été annulé automatiquement.`,
    };
  }

  /**
   * Envoie la course à Turbo (groupe). Deux usages :
   *  - **fallback** (défaut) : saturation interne — en cas d'échec certain, les
   *    commandes REVIENNENT en recherche interne (rollback CHICKEN_NATION) ;
   *  - **nativeTurbo** : la course est en service TURBO dès l'origine — en cas
   *    d'échec certain, les commandes RESTENT en TURBO et le cron re-tente
   *    l'envoi (cadence `offer_expires_at`, inutilisé par les offres internes
   *    sur ces courses). Jamais de repli interne implicite : la flotte a été
   *    choisie par la zone ou par l'admin.
   */
  private async escalateToTurbo(
    courseId: string,
    waitingMinutes: number,
    opts: { nativeTurbo?: boolean; muteFailureBell?: boolean } = {},
  ): Promise<boolean> {
    const { nativeTurbo = false, muteFailureBell = false } = opts;

    // Claim ATOMIQUE : un seul backend sous-traite (2 instances // même base).
    const claim = await this.prisma.course.updateMany({
      where: {
        id: courseId,
        statut: CourseStatut.PENDING_ASSIGNMENT,
        turbo_escalated_at: null,
      },
      data: { turbo_escalated_at: new Date() },
    });
    if (claim.count !== 1) return false; // déjà traitée par l'autre instance

    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        reference: true,
        restaurant: { select: { id: true, apikey: true, name: true } },
        deliveries: {
          where: {
            statut: { notIn: [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED, DeliveryStatut.CANCELLED] },
          },
          select: { id: true, order: { select: { id: true, reference: true } } },
        },
      },
    });
    if (!course || course.deliveries.length === 0) {
      // Plus rien à sous-traiter → on relâche le claim.
      await this.prisma.course.updateMany({
        where: { id: courseId },
        data: { turbo_escalated_at: null },
      });
      return false;
    }

    const apikey = course.restaurant.apikey ?? '';
    const orderIds = course.deliveries.map((d) => d.order.id);

    // ⚠️ ORDRE CRITIQUE : `TurboService.creerCourse` REFUSE toute commande dont
    // `delivery_service` n'est pas déjà TURBO (garde interne). Il faut donc
    // basculer le champ AVANT l'appel, sinon la sous-traitance échoue en
    // silence à tous les coups.
    await this.prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { delivery_service: DeliveryService.TURBO },
    });

    // ENVOI PAR GROUPE : un seul appel portant les N commandes de la course, plus
    // le CODE DE RETRAIT et la référence CN. Turbo en fait un groupe de courses
    // (1 course = 1 commande chez eux) qu'un même livreur accepte en bloc, et le
    // livreur annonce notre code au restaurant → process CN inchangé.
    let sent: string[] = [];
    let uncertain = false;
    try {
      const res = await this.turboService.creerCourseGroupe({
        courseId,
        apikey,
        muteFailureBell,
      });
      sent = res.sentOrderIds;
      uncertain = res.uncertain === true;
    } catch (err) {
      uncertain = true; // exception inattendue : on ne peut rien affirmer
      this.logger.warn(
        `Bascule Turbo : groupe ${course.reference} échoué — ${(err as Error).message}`,
      );
    }

    // ⚠️ DOUBLE ENVOI DE LIVREUR — issue INCERTAINE (timeout/coupure) : Turbo a
    // peut-être créé le groupe sans que la réponse nous parvienne. Repartir en
    // recherche interne enverrait un livreur CN sur une commande déjà prise par
    // un livreur Turbo. On GARDE donc la sous-traitance et on fait trancher un
    // humain, au lieu de risquer deux livreurs sur la même commande.
    if (sent.length === 0 && uncertain) {
      this.logger.error(
        `⚠️ Bascule Turbo INCERTAINE pour ${course.reference} — maintenue sous-traitée (vérification manuelle requise).`,
      );
      this.notificationsSender
        .sendTurboPickupSyncFailedBell({
          reference: course.reference,
          restaurantId: course.restaurant.id,
        })
        .catch(() => undefined);
      return true; // sous-traitée « en doute » : plus aucune recherche interne
    }

    const failed = orderIds.filter((id) => !sent.includes(id));

    // ÉCHEC TOTAL CERTAIN (Turbo a répondu une erreur — le groupe n'existe pas).
    if (sent.length === 0) {
      if (nativeTurbo) {
        // Course en service TURBO d'origine : PAS de repli interne implicite.
        // On relâche le claim et on programme la prochaine tentative du cron
        // (`offer_expires_at` = « pas avant » — inutilisé par les offres
        // internes sur une course TURBO).
        await this.prisma.course.updateMany({
          where: { id: courseId },
          data: {
            turbo_escalated_at: null,
            offer_expires_at: new Date(Date.now() + 120_000),
          },
        });
        this.logger.error(
          `Envoi Turbo ÉCHOUÉ pour ${course.reference} (course TURBO) — nouvelle tentative dans ~2 min`,
        );
        return false;
      }

      // Fallback interne : rollback COMPLET, la recherche interne reprend et
      // le staff sera alerté. Aucune commande n'est perdue.
      await this.prisma.$transaction([
        this.prisma.order.updateMany({
          where: { id: { in: orderIds } },
          data: { delivery_service: DeliveryService.CHICKEN_NATION },
        }),
        this.prisma.course.updateMany({
          where: { id: courseId },
          data: { turbo_escalated_at: null },
        }),
      ]);
      this.logger.error(
        `Bascule Turbo ÉCHOUÉE pour ${course.reference} — retour à la recherche interne`,
      );
      return false;
    }

    // Échec PARTIEL : commandes non transmises (généralement annulées entre
    // temps). En fallback interne, elles repassent côté livreurs CN pour ne pas
    // rester orphelines ; en course TURBO d'origine, elles restent TURBO (pas
    // de repli implicite) et seront re-tentées ou traitées manuellement.
    if (failed.length > 0 && !nativeTurbo) {
      await this.prisma.order.updateMany({
        where: { id: { in: failed } },
        data: { delivery_service: DeliveryService.CHICKEN_NATION },
      });
      this.logger.warn(
        `Bascule Turbo partielle sur ${course.reference} : ${failed.length} commande(s) restée(s) en interne`,
      );
    } else if (failed.length > 0) {
      this.logger.warn(
        `Envoi Turbo partiel sur ${course.reference} (course TURBO) : ${failed.length} commande(s) non transmise(s)`,
      );
    }

    // La Course CN reste VIVANTE (pas d'annulation) : elle continue de suivre le
    // cycle de vie normal, piloté cette fois par les webhooks Turbo
    // (courier_assigned → ACCEPTED, pickup → AT_RESTAURANT, etc.). Le staff et le
    // client gardent donc exactement le même suivi qu'avec un livreur interne.
    // `turbo_escalated_at` (déjà posé par le claim) exclut la course de la
    // recherche de livreur interne.

    if (nativeTurbo) {
      // Course TURBO d'origine : envoi NORMAL, pas une bascule de secours — on
      // ne dérange pas le staff. Le process restaurant est inchangé (le livreur
      // Turbo annonce le code de retrait à la caissière).
      this.logger.log(
        `Course ${course.reference} envoyée à Turbo : ${sent.length} commande(s) (service TURBO).`,
      );
      return true;
    }

    this.notificationsSender
      .sendCourseTurboFallbackBell({
        reference: course.reference,
        restaurantId: course.restaurant.id,
        waitingMinutes,
        orderCount: sent.length,
      })
      .catch((e) => this.logger.warn(`Info « bascule Turbo » non envoyée : ${e?.message}`));

    this.logger.log(
      `Course ${course.reference} sous-traitée à Turbo : ${sent.length} commande(s) après ${waitingMinutes} min sans livreur interne`,
    );
    return true;
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

  /**
   * RELANCE une course ANNULÉE (typiquement annulée par Turbo — découplage :
   * les commandes restent vivantes) en créant une **NOUVELLE course**.
   *
   * ⚠️ Contrat Turbo : une `referenceCourse` déjà envoyée ne doit JAMAIS être
   * réutilisée, même annulée (leur déduplication porte dessus — un renvoi de la
   * même référence serait accepté en no-op silencieux : aucun livreur ne
   * viendrait jamais). On génère donc une course neuve (référence + code de
   * retrait) et on y DÉPLACE les livraisons encore relançables — même mécanique
   * que le re-balancing, qui préserve la relation 1-1 commande↔livraison.
   *
   * L'affectation repart selon la flotte des commandes (offres internes ou
   * envoi du groupe à Turbo).
   */
  async relancerCourseAnnulee(
    courseId: string,
  ): Promise<{ ok: boolean; message: string; newCourseId?: string }> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        reference: true,
        statut: true,
        restaurant_id: true,
        deliveries: {
          select: {
            id: true,
            statut: true,
            order: {
              select: {
                id: true,
                status: true,
                delivery_fee: true,
                delivery_service: true,
                entity_status: true,
              },
            },
          },
        },
      },
    });
    if (!course) throw new NotFoundException('Course introuvable');

    // Cibles : les livraisons ANNULÉES dont la commande est toujours vivante
    // (READY). Couvre les DEUX portées d'annulation Turbo : groupe entier
    // (course CANCELLED) ET annulation partielle (course encore vivante avec
    // une livraison annulée dedans). Les commandes annulées manuellement ou
    // supprimées sont exclues d'office.
    const relancables = course.deliveries.filter(
      (d) =>
        d.statut === DeliveryStatut.CANCELLED &&
        d.order.status === OrderStatus.READY &&
        d.order.entity_status !== EntityStatus.DELETED,
    );
    if (relancables.length === 0) {
      return {
        ok: false,
        message:
          'Aucune livraison annulée avec une commande encore active sur cette course. ' +
          'Annulez ou traitez les commandes individuellement.',
      };
    }

    // Nouvelle course (retry sur collision de référence, comme à la création).
    const totalFee = relancables.reduce((sum, d) => sum + d.order.delivery_fee, 0);
    let nouvelle: Course | null = null;
    for (let attempt = 0; attempt < 3 && !nouvelle; attempt++) {
      try {
        nouvelle = await this.prisma.course.create({
          data: {
            reference: this.helper.generateReference(),
            pickup_code: this.helper.generatePickupCode(),
            restaurant_id: course.restaurant_id,
            statut: CourseStatut.PENDING_ASSIGNMENT,
            total_delivery_fee: totalFee,
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002' && err?.meta?.target?.includes('reference')) continue;
        throw err;
      }
    }
    if (!nouvelle) throw new HttpException('Génération reference impossible', 500);

    // Déplacer les livraisons — CLAIM ATOMIQUE : chaque update est conditionné
    // sur le rattachement d'origine (course_id) ET le statut CANCELLED. Deux
    // relances concurrentes (double-clic, 2 backends) : la seconde perd le
    // claim (count=0) → rollback complet + suppression de sa course vide.
    // Sans ce claim, deux groupes Turbo seraient créés pour les MÊMES
    // commandes → deux livreurs (invariant absolu du projet).
    // On repart PROPRE (statut, tentatives de code, identité du livreur Turbo
    // précédent, raison d'annulation) — le PIN client est CONSERVÉ (déjà
    // communiqué au client à la création de la commande).
    let claimPerdu = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        for (const [index, d] of relancables.entries()) {
          const claimed = await tx.delivery.updateMany({
            where: {
              id: d.id,
              course_id: course.id,
              statut: DeliveryStatut.CANCELLED,
            },
            data: {
              course_id: nouvelle!.id,
              sequence_order: index + 1,
              statut: DeliveryStatut.PENDING,
              in_route_at: null,
              arrived_at: null,
              turbo_course_id: null,
              turbo_courier_id: null,
              turbo_courier_name: null,
              turbo_courier_phone: null,
              turbo_courier_lat: null,
              turbo_courier_lng: null,
              turbo_courier_location_at: null,
              turbo_code_attempts: 0,
              turbo_cancelled_reason: null,
            },
          });
          if (claimed.count !== 1) {
            throw new Error('RELANCE_CLAIM_PERDU');
          }
        }
      });
    } catch (err) {
      if ((err as Error)?.message !== 'RELANCE_CLAIM_PERDU') throw err;
      claimPerdu = true;
    }

    if (claimPerdu) {
      // La transaction a tout annulé — la course neuve est vide, on la retire.
      await this.prisma.course
        .delete({ where: { id: nouvelle.id } })
        .catch(() => undefined);
      return {
        ok: false,
        message: 'Course déjà relancée par un autre opérateur.',
      };
    }

    // Affectation selon la flotte (le batching ne mélange jamais les services,
    // donc toutes les livraisons relançables partagent celui de la première).
    const isTurboNative = relancables.every(
      (d) => d.order.delivery_service === DeliveryService.TURBO,
    );
    if (isTurboNative) {
      await this.escalateToTurbo(nouvelle.id, 0, { nativeTurbo: true });
    } else {
      await this.offerNextDeliverer(nouvelle.id).catch(() => undefined);
    }

    this.logger.log(
      `Course ${course.reference} (annulée) relancée → nouvelle course ${nouvelle.reference} (${relancables.length} livraison(s)).`,
    );
    return {
      ok: true,
      message: `Nouvelle course ${nouvelle.reference} créée (${relancables.length} commande(s) relancée(s)).`,
      newCourseId: nouvelle.id,
    };
  }

  /** Accès direct au helper pour les autres services du module */
  getHelper() {
    return this.helper;
  }
}
