import {
  BadRequestException,
  ConflictException,
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
  Prisma,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { DelivererQueueService } from 'src/modules/deliverers/services/deliverer-queue.service';
import { MapsService } from 'src/modules/maps/maps.service';
import { ComptePersonnel } from 'src/modules/users/helpers/personnel-scope.helper';
import { TurboService } from 'src/turbo/services/turbo.service';

import { parseOrderLatLng } from '../helpers/geo.helper';
import { messageCommandesPasPretes } from '../helpers/code-retrait.rules';
import { CancelCourseDto } from '../dto/cancel-course.dto';
import { ConfirmDeliveryDto } from '../dto/confirm-delivery.dto';
import { FailDeliveryDto } from '../dto/fail-delivery.dto';
import { RefuseOfferDto } from '../dto/refuse-offer.dto';
import { ValidatePickupDto } from '../dto/validate-pickup.dto';
import { CourseEvent } from '../events/course.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { commandesConfirmees } from '../helpers/recuperation.rules';
import { WHERE_COURSE_ENCORE_A_REMETTRE, messageValidationImpossible } from '../helpers/remise-course.rules';
import { CourseOfferService } from './course-offer.service';
import { CourseQueryService } from './course-query.service';
import { DepartCourseService } from './depart-course.service';
import { GardeOffresService } from './garde-offres.service';

/** Course lue avec le détail commun (livraisons, commandes, restaurant, livreur). */
type CourseDetaillee = Prisma.CourseGetPayload<{ include: typeof COURSE_FULL_INCLUDE }>;

/** Refus d'une offre déjà expirée, close ou traitée (texte montré au livreur). */
export const MESSAGE_OFFRE_PLUS_EN_ATTENTE = "Cette offre n'est plus en attente.";

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
    // Sous-traitance : confirmation du retrait caissière vers la flotte externe.
    private readonly turboService: TurboService,
    // Estimation de la tournée (trafic + arrêts) pour détecter les retards.
    private readonly maps: MapsService,
    // Recherche de la course par code de retrait : la même que l'aperçu caisse.
    private readonly queryService: CourseQueryService,
    // Acceptation conditionnelle (règle unique des offres) : garde-offres.service.ts.
    private readonly garde: GardeOffresService,
    // Planificateur v2 : fenêtre d'ajout après le retrait, retrait complémentaire.
    private readonly depart?: DepartCourseService,
  ) {}

  // ============================================================
  // OFFER : accept / refuse
  // ============================================================

  /**
   * Le livreur accepte une offer → devient sa course active.
   *
   * Mise à jour CONDITIONNELLE (GardeOffresService) : course encore en
   * recherche, pas confiée à Turbo, offre encore en attente pour ce livreur ;
   * sinon 409 « Cette course n'est plus disponible. » et offre close.
   */
  async acceptOffer(courseId: string, delivererId: string) {
    const course = await this.garde.reserverAcceptation(courseId, delivererId);

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
      throw new BadRequestException(MESSAGE_OFFRE_PLUS_EN_ATTENTE);
    }

    // Écriture CONDITIONNÉE : l'offre a pu expirer (tâche de 10 s) ou être
    // close par le serveur entre la lecture et l'écriture. Sans condition, le
    // refus l'écrasait et le livreur payait deux pénalités (expiration + refus).
    const refusee = await this.prisma.courseOfferAttempt.updateMany({
      where: { id: offer.id, status: CourseOfferStatus.PENDING },
      data: {
        status: CourseOfferStatus.REFUSED,
        responded_at: new Date(),
        refusal_reason: dto.reason,
      },
    });
    if (refusee.count !== 1) {
      throw new BadRequestException(MESSAGE_OFFRE_PLUS_EN_ATTENTE);
    }

    await this.prisma.course.update({
      where: { id: courseId },
      data: { refusal_count: { increment: 1 } },
    });

    // P5 : pénalité queue + check auto-pause éventuelle (logique interne)
    await this.queueService.onRefuse(delivererId);
    void this.courseEvent.offerRefused({
      course_id: courseId,
      deliverer_id: delivererId,
      raison: dto.reason ?? null,
    });

    await this.offerService.offerNextDeliverer(courseId);
    this.logger.log(`Course ${courseId} refusée par ${delivererId}, retry lancé`);
    return { success: true };
  }

  // ============================================================
  // COURSE : transitions phase "restaurant"
  // ============================================================

  /** Livreur arrivé au restaurant (ACCEPTED → AT_RESTAURANT) */
  async markAtRestaurant(courseId: string, delivererId: string) {
    // Arrivée déjà déclarée par le serveur d'après la position : réponse normale.
    const deja = await this.prisma.course.findUnique({ where: { id: courseId }, select: { statut: true, deliverer_id: true } });
    if (deja?.deliverer_id === delivererId && deja.statut === CourseStatut.AT_RESTAURANT) {
      return this.prisma.course.findUniqueOrThrow({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
    }
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
    let [updatedCourse] = await this.prisma.$transaction([
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

    // Fenêtre d'ajout après le retrait fermée d'office si elle ne doit pas
    // s'ouvrir ; l'événement qui suit porte alors la course relue (partie).
    if (await this.depart?.fermerFenetreALaValidation(courseId, now, { annoncer: false })) {
      updatedCourse =
        (await this.prisma.course.findUnique({ where: { id: courseId }, include: COURSE_FULL_INCLUDE })) ?? updatedCourse;
    }

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
    // Une annulation AUTOMATIQUE n'annule jamais une commande de client (« une
    // commande ne s'annule que manuellement ») : la tâche passe par
    // AnnulationAutoService, ceci n'est qu'un garde-fou.
    const annulerLesCommandes = cancelledBy !== 'system';
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
      ...(annulerLesCommandes
        ? [
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
          ]
        : []),
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
  // RÉCUPÉRATION À LA CAISSE (code dicté, ou groupe de la course)
  // ============================================================

  /**
   * Flow unique déclenché par la caissière dans le backoffice :
   * elle saisit le pickup_code dicté par le livreur → on enchaîne en cascade :
   *   Course ACCEPTED/AT_RESTAURANT → IN_DELIVERY
   *   Orders READY → PICKED_UP (+ picked_up_at)
   *   Remplace l'ancienne action livreur `markPickedUp` (supprimée côté mobile).
   *
   * Préconditions : toutes les Orders liées doivent être READY (sinon 400).
   *
   * La course est cherchée dans le restaurant de la caissière (ou celui choisi
   * par un compte du siège), parmi les courses de la journée de service :
   * même recherche que l'aperçu (`CourseQueryService.findByActivePickupCode`).
   * Course SOUS-TRAITÉE encore PENDING_ASSIGNMENT comprise : le livreur Turbo
   * peut se présenter AVANT que leurs webhooks n'aient fait avancer la course.
   *
   * Route gardée pour la caisse Sunmi et le repli de l'écran : toutes les
   * commandes lues sont remises.
   */
  async validatePickupByCashier(dto: ValidatePickupDto, user: ComptePersonnel | undefined) {
    const course = await this.queryService.findByActivePickupCode(
      dto.pickup_code,
      user,
      dto.restaurant_id,
    );
    return this.remettreCourse(
      course,
      user,
      course.deliveries.map((d) => d.order.id),
      `code ${dto.pickup_code}`,
    );
  }

  /**
   * Récupération confirmée sans code (conception du 24/10, 11.1) : le livreur
   * dit son code, la caissière touche le groupe de la course et confirme les
   * commandes que sa fenêtre montre. Même règle « à remettre » que le code
   * (`findARemettreParId`), même cœur (`remettreCourse`). Une commande qui
   * n'est plus dans la course : 409, la fenêtre est relue.
   */
  async confirmerRecuperation(courseId: string, orderIds: string[], user: ComptePersonnel | undefined) {
    const course = await this.queryService.findARemettreParId(courseId, user);
    return this.remettreCourse(course, user, commandesConfirmees(orderIds, course.deliveries), 'groupe de la course');
  }

  /**
   * Cœur commun de la remise d'une course au livreur par la caisse (code ou
   * groupe de la course). `orderIds` : les commandes que la caisse remet, toutes
   * des commandes de la course.
   *
   *  - retrait normal (ACCEPTED, AT_RESTAURANT, Turbo en recherche) : toutes les
   *    commandes de la course doivent être prêtes ; seules celles de `orderIds`
   *    passent PICKED_UP, une commande prête ajoutée entre-temps devient un
   *    ajout après le retrait (`marquerAjoutsPendantLaRemise`) ;
   *  - retrait complémentaire et sac oublié (IN_DELIVERY) : les commandes
   *    prêtes de `orderIds` (`DepartCourseService.remettreComplement`).
   *
   * @param origine  Pour le journal du serveur : « code 421 », « groupe de la course ».
   */
  async remettreCourse(
    course: CourseDetaillee,
    user: ComptePersonnel | undefined,
    orderIds: string[],
    origine: string,
  ) {
    // Planificateur v2 : course déjà récupérée, livreur encore au restaurant,
    // commande ajoutée après le retrait. Seules les commandes prêtes sont
    // remises, avec le même code ; la course reste en livraison.
    if (course.statut === CourseStatut.IN_DELIVERY && this.depart) {
      const remises = new Set(orderIds);
      const complete = await this.depart.remettreComplement({
        ...course,
        deliveries: course.deliveries.filter((d) => remises.has(d.order.id)),
      });
      void this.estimerDureeTournee(complete.id).catch(() => undefined);
      return complete;
    }

    // Toutes les commandes doivent être READY. Le refus nomme les commandes
    // et leur statut : la caissière sait laquelle attendre.
    const notReady = course.deliveries.filter((d) => d.order.status !== OrderStatus.READY);
    if (notReady.length > 0) {
      throw new BadRequestException(messageCommandesPasPretes(notReady.map((d) => d.order)));
    }

    const now = new Date();
    const previousStatut = course.statut;
    // Écriture CONDITIONNÉE : la course doit être encore à remettre. Le bouton
    // de la caisse « Livreur a récupéré » (CourseEnLivraisonService) peut la
    // faire partir en même temps : un seul des deux la remet, l'autre reçoit
    // 409. Le GPS ou un webhook Turbo qui la fait avancer (« au restaurant »)
    // ne bloque pas la validation.
    let [updated] = await this.prisma.$transaction([
      this.prisma.course.update({
        where: { id: course.id, AND: [WHERE_COURSE_ENCORE_A_REMETTRE] },
        data: {
          statut: CourseStatut.IN_DELIVERY,
          // Si le livreur n'a pas encore déclenché at_restaurant (pas de GPS ou GPS tardif),
          // on le marque au moment de la validation pour garder la traçabilité
          at_restaurant_at: course.at_restaurant_at ?? now,
          picked_up_at: now,
        },
        include: COURSE_FULL_INCLUDE,
      }),
      // Orders : READY → PICKED_UP + timestamp. Seulement celles que la caisse
      // remet : une commande ajoutée à la course pendant la saisie (planificateur)
      // n'a pas été remise ; elle reste à remettre avec le même code.
      this.prisma.order.updateMany({
        where: { id: { in: orderIds }, delivery: { course_id: course.id } },
        data: { status: OrderStatus.PICKED_UP, picked_up_at: now },
      }),
    ]).catch(async (err) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        const relue = await this.prisma.course
          .findUnique({ where: { id: course.id }, select: { statut: true } })
          .catch(() => null);
        throw new ConflictException(messageValidationImpossible(relue?.statut));
      }
      throw err;
    });

    // Commande ajoutée pendant la saisie : traitée comme un ajout après le
    // retrait (remise avec le même code, ou retirée au départ du livreur).
    await this.depart?.marquerAjoutsPendantLaRemise(course.id, orderIds);
    // Fenêtre d'ajout après le retrait fermée d'office si elle ne doit pas
    // s'ouvrir (ancienne appli, Turbo, réglage coupé, restaurant en v1).
    // L'événement qui suit porte la course relue (partie, première livraison démarrée).
    if (await this.depart?.fermerFenetreALaValidation(updated.id, now, { annoncer: false })) {
      updated =
        (await this.prisma.course.findUnique({ where: { id: updated.id }, include: COURSE_FULL_INCLUDE })) ??
        { ...updated, parti_at: now };
    }

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

    // Fige la durée ESTIMÉE de la tournée (trafic + arrêts) au moment du retrait.
    // Sans cette référence, aucun retard ne peut être détecté : on ne s'en rend
    // compte qu'au moment où le client réclame. Best-effort.
    void this.estimerDureeTournee(updated.id).catch(() => undefined);

    // Course SOUS-TRAITÉE : on signale le retrait à Turbo (leur groupe passe
    // « récupéré » → picked_up). C'est CN qui reste la source de vérité sur la
    // remise des plats, exactement comme pour un livreur interne.
    // Best-effort : ne bloque jamais la validation (les plats sont déjà remis).
    //
    // ⚠️ La clé API est lue par une requête DÉDIÉE : `COURSE_FULL_INCLUDE` est
    // diffusé aux mobiles et au backoffice par WebSocket — y ajouter `apikey`
    // la divulguerait à tous les clients connectés.
    if (updated.turbo_escalated_at) {
      void (async () => {
        const resto = await this.prisma.restaurant.findUnique({
          where: { id: updated.restaurant_id },
          select: { apikey: true },
        });
        await this.turboService.confirmerRetrait({
          referenceCourse: updated.reference,
          apikey: resto?.apikey ?? '',
          restaurantId: updated.restaurant_id,
        });
      })().catch(() => undefined);
    }

    this.logger.log(
      `Course ${updated.reference} validée par caissière (${origine}, restaurant ${updated.restaurant_id}, compte ${user?.id ?? 'inconnu'}) — ${orderIds.length} order(s) → PICKED_UP`,
    );

    return updated;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /** Vérifie que la course appartient au livreur + est dans le bon statut */
  /**
   * Calcule et fige la durée prévisionnelle de la tournée : restaurant → tous
   * les clients, trafic réel et arrêts compris. Sert de référence à la détection
   * des retards. Silencieux en cas d'échec : une estimation manquante ne doit
   * jamais empêcher une course de partir.
   */
  async estimerDureeTournee(courseId: string): Promise<void> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        restaurant: { select: { latitude: true, longitude: true } },
        deliveries: {
          // Une livraison annulée (détachée, annulée par Turbo) ne fait pas partie de la tournée.
          where: { statut: { not: DeliveryStatut.CANCELLED } },
          orderBy: { sequence_order: 'asc' },
          select: { order: { select: { address: true } } },
        },
      },
    });
    if (!course?.restaurant?.latitude || !course.restaurant.longitude) return;

    const etapes = course.deliveries
      .map((d) => parseOrderLatLng(d.order.address))
      .filter((c): c is { lat: number; lng: number } => c !== null)
      .map((c) => ({ latitude: c.lat, longitude: c.lng }));
    if (etapes.length === 0) return;

    const directions = await this.maps.getDirections({
      originLat: course.restaurant.latitude,
      originLng: course.restaurant.longitude,
      destLat: etapes[etapes.length - 1].latitude,
      destLng: etapes[etapes.length - 1].longitude,
      waypoints: etapes.slice(0, -1),
    });
    if (!directions) return;

    const minutes = Math.round(
      (directions.totalDurationWithStopsSeconds ?? directions.totalDurationSeconds) / 60,
    );
    await this.prisma.course.update({
      where: { id: courseId },
      data: { estimated_duration_min: minutes },
    });
    this.logger.log(`Course ${courseId.slice(0, 8)} : tournée estimée à ${minutes} min.`);
  }

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
