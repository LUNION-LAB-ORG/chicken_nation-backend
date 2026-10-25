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
import { STATUTS_COURSE_TERMINEE, messageCommandesPasPretes } from '../helpers/code-retrait.rules';
import { MESSAGE_COURSE_PAS_A_TOI } from '../helpers/depart.rules';
import { recalculerFraisCourse } from '../helpers/frais-course';
import { CancelCourseDto } from '../dto/cancel-course.dto';
import { ConfirmDeliveryDto } from '../dto/confirm-delivery.dto';
import { FailDeliveryDto } from '../dto/fail-delivery.dto';
import { RefuseOfferDto } from '../dto/refuse-offer.dto';
import { ValidatePickupDto } from '../dto/validate-pickup.dto';
import { CourseEvent } from '../events/course.event';
import { retenueEnCours, texteRetenue } from '../helpers/application-plan.rules';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { commandesConfirmees } from '../helpers/recuperation.rules';
import {
  STATUTS_LIVRAISON_TERMINEE,
  WHERE_COURSE_ENCORE_A_REMETTRE,
  messageValidationImpossible,
} from '../helpers/remise-course.rules';
import { CourseOfferService } from './course-offer.service';
import { CourseQueryService } from './course-query.service';
import { DepartCourseService } from './depart-course.service';
import { GardeOffresService } from './garde-offres.service';

/** Course lue avec le détail commun (livraisons, commandes, restaurant, livreur). */
type CourseDetaillee = Prisma.CourseGetPayload<{ include: typeof COURSE_FULL_INCLUDE }>;

/** Refus d'une offre déjà expirée, close ou traitée (texte montré au livreur). */
export const MESSAGE_OFFRE_PLUS_EN_ATTENTE = "Cette offre n'est plus en attente.";

/** Refus d'annuler une course terminée, annulée ou expirée (y compris par une annulation simultanée). */
export const MESSAGE_COURSE_DEJA_TERMINEE = 'Course déjà terminée';

/** Une autre annulation (ou la fin de la course) est passée entre la lecture et l'écriture. */
class CourseDejaTerminee extends Error {}

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
   *
   * Rejeu (course déjà à lui : réponse perdue, erreur rejouée par l'appli,
   * double toucher) : la course est rendue, sans nouvel événement ni
   * notification.
   */
  async acceptOffer(courseId: string, delivererId: string) {
    const { course, rejeu } = await this.garde.reserverAcceptation(courseId, delivererId);

    // P5 : sortie de la queue FIFO (le livreur est maintenant "en activité").
    // La course est réservée : une panne ici ne rend plus d'erreur au livreur,
    // sinon l'appli rejoue l'acceptation. Sans risque au rejeu (même écriture).
    await this.queueService
      .onAccept(delivererId)
      .catch((e) => this.logger.warn(`Sortie de la file du livreur ${delivererId.slice(0, 8)} impossible : ${e?.message}`));
    if (rejeu) return course;

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

  /**
   * Livreur arrivé au restaurant (ACCEPTED → AT_RESTAURANT).
   *
   * Écriture CONDITIONNÉE (course encore acceptée par ce livreur) : quand le
   * serveur déclare l'arrivée d'après la position au même instant, un seul
   * des deux passe (une seule annonce « Attends », un seul passage du
   * planificateur) ; une course annulée entre-temps ne revient jamais au
   * restaurant.
   */
  async markAtRestaurant(courseId: string, delivererId: string) {
    // Arrivée déjà déclarée par le serveur d'après la position : réponse normale.
    const dejaAuRestaurant = async () => {
      const deja = await this.prisma.course.findUnique({ where: { id: courseId }, select: { statut: true, deliverer_id: true } });
      return deja?.deliverer_id === delivererId && deja.statut === CourseStatut.AT_RESTAURANT;
    };
    const relire = () => this.prisma.course.findUniqueOrThrow({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
    if (await dejaAuRestaurant()) return relire();

    await this.assertOwnedCourse(courseId, delivererId, CourseStatut.ACCEPTED);
    const { count } = await this.prisma.course.updateMany({
      where: { id: courseId, deliverer_id: delivererId, statut: CourseStatut.ACCEPTED },
      data: {
        statut: CourseStatut.AT_RESTAURANT,
        at_restaurant_at: new Date(),
      },
    });
    if (count !== 1) {
      if (await dejaAuRestaurant()) return relire();
      // Annulée, relancée ou reprise entre la lecture et l'écriture : le message habituel.
      await this.assertOwnedCourse(courseId, delivererId, CourseStatut.ACCEPTED);
      throw new ConflictException('La course a changé. Réessaie.');
    }
    const updated = await relire();
    await this.courseEvent.courseStatutChanged({
      course: updated,
      previous_statut: CourseStatut.ACCEPTED,
      new_statut: CourseStatut.AT_RESTAURANT,
    });
    return updated;
  }

  /**
   * ANNULATION MANUELLE d'une course (administration). Règle du client :
   * annuler une course n'annule JAMAIS une commande, une commande ne s'annule
   * que manuellement. Après l'annulation, aucune commande ne reste sur la
   * course :
   *  - la course est réservée par une écriture conditionnée (pas encore
   *    terminée) : deux annulations en même temps, une seule passe, l'autre
   *    reçoit 400 ;
   *  - le livreur n'a plus de route pour annuler (relecture du 25/10) : une
   *    course qu'il abandonne est relancée par l'annulation automatique. La
   *    garde reste ici : une annulation « deliverer » exige son identifiant
   *    (`delivererId`, du jeton) et ne passe que sur SA course, celle qu'il a
   *    acceptée, sinon 403 (la condition porte aussi sur le livreur) ;
   *  - ses livraisons pas terminées sont annulées ; les commandes déjà livrées
   *    ne bougent pas ;
   *  - course interne : une commande remise au livreur et pas livrée revient
   *    prête au comptoir, puis toutes les commandes prêtes repartent dans une
   *    NOUVELLE course, à référence neuve (`relancerCourseAnnulee`, comme
   *    l'annulation automatique et la relance après une annulation de Turbo) ;
   *  - course confiée à Turbo : rien n'est relancé d'office, leur livreur est
   *    peut-être en route (jamais deux livreurs sur une commande) ; les
   *    commandes restent à relancer depuis le backoffice, comme après une
   *    annulation venue de Turbo ;
   *  - paiements et encaissements ne sont jamais touchés ;
   *  - livreur, backoffice et restaurant prévenus (`course:cancelled`) ; le
   *    DispatchListener clôt les offres et remet le livreur dans la file.
   *
   * Avant : l'écriture sur les commandes suivait, dans la même transaction,
   * l'annulation des livraisons et filtrait sur une livraison pas annulée :
   * elle ne trouvait jamais rien (code mort depuis c7ed9de). Les commandes
   * restaient accrochées à la course annulée.
   */
  async cancelCourse(courseId: string, cancelledBy: string, dto: CancelCourseDto, delivererId?: string) {
    const parLeLivreur = cancelledBy === 'deliverer';
    if (parLeLivreur && !delivererId) throw new ForbiddenException(MESSAGE_COURSE_PAS_A_TOI);

    const now = new Date();
    let annulation: { updated: CourseDetaillee; confieeATurbo: boolean };
    try {
      annulation = await this.prisma.$transaction(async (tx) => {
        const reservee = await tx.course.updateMany({
          where: {
            id: courseId,
            ...(parLeLivreur ? { deliverer_id: delivererId } : {}),
            statut: { notIn: STATUTS_COURSE_TERMINEE },
          },
          data: {
            statut: CourseStatut.CANCELLED,
            cancelled_at: now,
            cancelled_by: cancelledBy,
            cancelled_reason: dto.reason,
          },
        });
        if (reservee.count !== 1) {
          // Le refus dit pourquoi : la course d'un autre passe avant son état.
          const lue = await tx.course.findUnique({ where: { id: courseId }, select: { deliverer_id: true } });
          if (!lue) throw new NotFoundException('Course non trouvée');
          if (parLeLivreur && lue.deliverer_id !== delivererId) {
            throw new ForbiddenException(MESSAGE_COURSE_PAS_A_TOI);
          }
          throw new CourseDejaTerminee();
        }

        // Lu après la réservation : la ligne de la course est verrouillée.
        const course = await tx.course.findUniqueOrThrow({
          where: { id: courseId },
          select: {
            turbo_escalated_at: true,
            deliveries: {
              where: { statut: { notIn: STATUTS_LIVRAISON_TERMINEE } },
              select: { id: true, order_id: true },
            },
          },
        });
        const confieeATurbo = course.turbo_escalated_at !== null;
        const enCours = course.deliveries;
        if (enCours.length > 0) {
          await tx.delivery.updateMany({
            where: { id: { in: enCours.map((d) => d.id) }, statut: { notIn: STATUTS_LIVRAISON_TERMINEE } },
            data: { statut: DeliveryStatut.CANCELLED },
          });
          // Remise au livreur interne, pas livrée : elle revient au comptoir
          // pour repartir. Chez Turbo, leur livreur la garde (ses webhooks la
          // livrent et l'encaissent).
          if (!confieeATurbo) {
            await tx.order.updateMany({
              where: { id: { in: enCours.map((d) => d.order_id) }, status: OrderStatus.PICKED_UP },
              data: { status: OrderStatus.READY, picked_up_at: null },
            });
          }
        }
        const detail = await tx.course.findUniqueOrThrow({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
        return { updated: detail, confieeATurbo };
      });
    } catch (err) {
      if (err instanceof CourseDejaTerminee) throw new BadRequestException(MESSAGE_COURSE_DEJA_TERMINEE);
      throw err;
    }
    const { updated, confieeATurbo } = annulation;

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

    if (confieeATurbo) {
      this.logger.warn(
        `Course ${updated.reference} confiée à Turbo, annulée (${cancelledBy}) : commandes laissées à relancer depuis le backoffice.`,
      );
    } else {
      await this.relancerApresAnnulation(updated);
    }

    return updated;
  }

  /**
   * Commandes prêtes d'une course interne annulée : nouvelle course, référence
   * neuve, recherche de livreur (réservation atomique des livraisons dans
   * `relancerCourseAnnulee`). Un échec laisse la course annulée et ses
   * commandes à relancer depuis le backoffice : il est noté, jamais remonté.
   */
  private async relancerApresAnnulation(course: { id: string; reference: string }): Promise<void> {
    try {
      const relance = await this.offerService.relancerCourseAnnulee(course.id);
      if (!relance.ok) return; // rien à relancer (tout est livré) ou déjà relancée
      // Les livraisons relancées ont quitté la course : ses frais suivent.
      await recalculerFraisCourse(this.prisma, course.id).catch(() => undefined);
      this.logger.log(`Course ${course.reference} annulée : ${relance.message}`);
    } catch (err) {
      this.logger.error(
        `Course ${course.reference} annulée, relance de ses commandes impossible : ${(err as Error)?.message}`,
      );
    }
  }

  // ============================================================
  // RÉCUPÉRATION À LA CAISSE (code dicté, ou groupe de la course)
  // ============================================================

  /**
   * Flow unique déclenché par la caissière dans le backoffice :
   * elle saisit le pickup_code dicté par le livreur → on enchaîne en cascade :
   *   Course ACCEPTED/AT_RESTAURANT → IN_DELIVERY
   *   Orders READY → PICKED_UP (+ picked_up_at)
   *   Remplace l'ancienne action livreur « colis récupérés » (route retirée le 25/10).
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
    // Retenue en cours (la caisse remet dès le code) : il attend encore la
    // commande en cuisine, « Attends 4 min / Départ 12 h 34 », jamais « Tu
    // peux partir » (essai du 25/10). Fenêtre fermée d'office : il part.
    if (updated.deliverer_id) {
      const retenue = updated.parti_at ? null : retenueEnCours(updated, now);
      if (retenue) {
        const texte = texteRetenue({ jusqua: retenue.jusqua, maintenant: now });
        this.pushService.notifyCourseAttente({
          delivererId: updated.deliverer_id,
          courseId: updated.id,
          titre: texte.titre,
          corps: texte.corps,
          jusqua: retenue.jusqua,
          attendues: retenue.attendues,
        });
      } else {
        this.pushService.notifyPickupValidated({
          delivererId: updated.deliverer_id,
          courseReference: updated.reference,
          courseId: updated.id,
        });
      }
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
