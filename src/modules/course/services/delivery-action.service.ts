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
  PaiementStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { DelivererQueueService } from 'src/modules/deliverers/services/deliverer-queue.service';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';
import {
  libelleEncaissements,
  normaliserEncaissements,
} from 'src/turbo/constantes/turbo.constante';

import { ConfirmDeliveryDto } from '../dto/confirm-delivery.dto';
import { FailDeliveryDto } from '../dto/fail-delivery.dto';
import { RateCustomerDto } from '../dto/rate-customer.dto';
import { CourseEvent } from '../events/course.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { DepartCourseService } from './depart-course.service';

/**
 * Livraisons qui peuvent encore échouer : pas terminées. PENDING compris : la
 * livraison suivante d'une tournée attend que l'appli la démarre, et le
 * livreur doit pouvoir signaler un problème si ce démarrage n'est pas passé.
 */
const LIVRAISONS_EN_COURS: DeliveryStatut[] = [DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED];

/** Commandes qu'un échec de livraison ne touche plus : terminée, collectée, déjà annulée. */
const COMMANDES_CLOSES: OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.COLLECTED, OrderStatus.CANCELLED];

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
    // Cloche staff « encaissement à confirmer » (livraison non payée)
    private readonly notificationsSender: NotificationsSenderService,
    // Planificateur v2 : démarrer une livraison, c'est quitter le restaurant.
    private readonly depart?: DepartCourseService,
  ) {}

  /**
   * Le livreur démarre une livraison vers ce client (PENDING → IN_ROUTE).
   * Déjà en route (démarrée par le serveur au départ du restaurant, ou appel
   * répété) : rendue telle quelle, sans erreur. Commande ajoutée après le
   * retrait et pas encore remise : 409. Course pas encore partie : le départ
   * est enregistré d'abord (DepartCourseService).
   */
  async startDelivery(deliveryId: string, delivererId: string) {
    const delivery = await this.assertOwned(deliveryId, delivererId, [DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE]);
    if (delivery.statut === DeliveryStatut.IN_ROUTE) return this.lireSansCode(deliveryId);

    await this.depart?.avantDemarrageLivraison(delivery);

    const updated = await this.prisma.delivery
      .update({
        // Conditionnée : le serveur a pu la démarrer au même instant (départ).
        where: { id: deliveryId, statut: DeliveryStatut.PENDING },
        // Le livreur ne doit JAMAIS lire le code : c'est le client qui le lui
        // dicte, et c'est ce qui prouve la remise. Sans cette omission, la
        // reponse de la route lui donnait de quoi valider sans voir personne.
        omit: { delivery_pin: true },
        data: { statut: DeliveryStatut.IN_ROUTE, in_route_at: new Date() },
      })
      .catch((err) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return null;
        throw err;
      });
    if (!updated) return this.lireSansCode(deliveryId);

    await this.emitDeliveryStatut(updated, delivery.statut);
    return updated;
  }

  /** Livraison relue sans le code du client. */
  private lireSansCode(deliveryId: string) {
    return this.prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId }, omit: { delivery_pin: true } });
  }

  /**
   * Livreur arrivé à l'adresse client (IN_ROUTE → ARRIVED). Écriture
   * CONDITIONNÉE : si le serveur déclare l'arrivée d'après la position au
   * même instant, un seul des deux passe (le client n'est prévenu qu'une fois).
   */
  async markArrived(deliveryId: string, delivererId: string) {
    const delivery = await this.assertOwned(deliveryId, delivererId, [DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED]);
    // Arrivée déjà déclarée (par le serveur d'après la position, ou deux
    // touchers) : réponse normale, rien ne change.
    if (delivery.statut === DeliveryStatut.ARRIVED) return this.lireSansCode(deliveryId);

    const { count } = await this.prisma.delivery.updateMany({
      where: {
        id: deliveryId,
        statut: DeliveryStatut.IN_ROUTE,
        course: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
      },
      data: { statut: DeliveryStatut.ARRIVED, arrived_at: new Date() },
    });
    if (count !== 1) return this.livraisonChangee(deliveryId, DeliveryStatut.ARRIVED);
    // Le livreur ne doit JAMAIS lire le code : c'est le client qui le lui
    // dicte, et c'est ce qui prouve la remise. Sans cette omission, la
    // reponse de la route lui donnait de quoi valider sans voir personne.
    const updated = await this.lireSansCode(deliveryId);

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
    // Rejeu avec le bon code (réponse perdue, double toucher) : la livraison
    // est rendue telle quelle. Avant, le 400 qui suivait poussait le livreur
    // vers « Problème » sur une commande déjà remise.
    const deja = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { statut: true, delivery_pin: true, course: { select: { deliverer_id: true } } },
    });
    if (deja?.statut === DeliveryStatut.DELIVERED && deja.course.deliverer_id === delivererId && deja.delivery_pin === dto.pin) {
      return this.lireSansCode(deliveryId);
    }

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

    // Écritures CONDITIONNÉES sur l'état lu : un « Problème » validé au même
    // instant n'est jamais effacé par la confirmation (ni l'inverse).
    const ecrite = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          statut: DeliveryStatut.ARRIVED,
          course: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
        },
        data: { statut: DeliveryStatut.DELIVERED, delivered_at: now },
      });
      if (count !== 1) return false;
      await tx.order.updateMany({
        where: { id: delivery.order_id, status: { notIn: COMMANDES_CLOSES } },
        data: orderUpdate,
      });
      return true;
    });
    if (!ecrite) return this.livraisonChangee(deliveryId, DeliveryStatut.DELIVERED);
    const updated = await this.lireSansCode(deliveryId);

    // ENCAISSEMENT À LA LIVRAISON : commande non payée → le livreur a choisi le
    // moyen de paiement du client dans l'app. On enregistre un Paiement
    // EN ATTENTE — le backoffice le confirme (bouton), ce qui marque la
    // commande payée et la termine. Même mécanique que la flotte Turbo :
    // codes fermés, défaut espèces, un seul PENDING par commande (index
    // unique partiel — le doublon concurrent tombe en P2002 = no-op).
    if (!isPaid) {
      await this.enregistrerEncaissementLivreur(delivery.order, dto).catch((e) =>
        this.logger.error(
          `Encaissement livreur non enregistré pour ${delivery.order.reference}: ${(e as Error)?.message}`,
        ),
      );
    }

    await this.emitDeliveryStatut(updated, delivery.statut);
    await this.checkCourseCompletion(delivery.course_id);
    return updated;
  }

  /** Enregistre l'encaissement déclaré par le livreur INTERNE (Paiement PENDING + cloche). */
  private async enregistrerEncaissementLivreur(
    order: {
      id: string;
      reference: string;
      amount: number;
      restaurant_id: string;
      customer_id: string;
    },
    dto: ConfirmDeliveryDto,
  ): Promise<void> {
    const dejaDeclare = await this.prisma.paiement.findFirst({
      where: { order_id: order.id, status: PaiementStatus.PENDING },
      select: { id: true },
    });
    if (dejaDeclare) return;

    // PAIEMENT PARTAGÉ : liste `encaissements` (une ligne par moyen, agrégée),
    // sinon champ simple, sinon espèces pour le montant total.
    const lignes = normaliserEncaissements(
      {
        encaissements: dto.encaissements,
        moyenPaiement: dto.moyen_paiement,
        montantEncaisse: dto.montant_encaisse,
      },
      order.amount,
    );

    try {
      const horodatage = Date.now();
      await this.prisma.$transaction(
        lignes.map((ligne, i) =>
          this.prisma.paiement.create({
            data: {
              reference: `LIVREUR-${order.reference}-${horodatage}-${i}`,
              amount: ligne.montant,
              total: ligne.montant,
              fees: 0,
              mode: ligne.mode,
              source: ligne.source,
              status: PaiementStatus.PENDING,
              order_id: order.id,
              client_id: order.customer_id,
            },
          }),
        ),
      );
    } catch (err: any) {
      // Index unique (1 PENDING par commande ET par moyen) : un lot concurrent
      // a déjà gagné — la transaction du perdant est annulée en bloc.
      if (err?.code === 'P2002') return;
      throw err;
    }

    const detail = libelleEncaissements(lignes);
    const total = lignes.reduce((somme, l) => somme + l.montant, 0);

    this.logger.log(
      `Encaissement livreur interne enregistré (EN ATTENTE) — commande ${order.reference} : ${detail}.`,
    );

    this.notificationsSender
      .sendTurboPaymentPendingBell({
        reference: order.reference,
        restaurantId: order.restaurant_id,
        montant: total,
        moyenLabel:
          lignes.length > 1
            ? lignes.map((l) => `${l.label} (${l.montant.toLocaleString('fr-FR')} XOF)`).join(' + ')
            : lignes[0].label,
        livreurLabel: 'le livreur Chicken Nation',
      })
      .catch(() => undefined);
  }

  /** Échec de livraison (client absent, refus, etc.) */
  /**
   * Échec de livraison (client absent, refus, etc.), sur une livraison en
   * cours d'une course partie seulement : jamais une livraison déjà confirmée
   * (sa commande payée et terminée passait annulée, points et coupon rendus),
   * ni une course pas encore récupérée ou annulée. Écritures conditionnées sur
   * l'état lu ; rejeu (réponse perdue, double toucher) rendu tel quel.
   */
  async failDelivery(deliveryId: string, delivererId: string, dto: FailDeliveryDto) {
    const deja = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { statut: true, course: { select: { deliverer_id: true } } },
    });
    if (deja?.statut === DeliveryStatut.FAILED && deja.course.deliverer_id === delivererId) {
      return this.lireSansCode(deliveryId);
    }

    const delivery = await this.assertOwned(deliveryId, delivererId, LIVRAISONS_EN_COURS);

    // OTHER nécessite une note
    if (dto.reason === DeliveryFailureReason.OTHER && !dto.note?.trim()) {
      throw new BadRequestException('Une note est requise pour le motif OTHER');
    }

    const now = new Date();
    const ecrite = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          statut: { in: LIVRAISONS_EN_COURS },
          course: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
        },
        data: {
          statut: DeliveryStatut.FAILED,
          failed_at: now,
          failure_reason: dto.reason,
          failure_note: dto.note,
        },
      });
      if (count !== 1) return false;
      // Order annulée avec traçabilité du motif (délivré au livreur), sauf si
      // elle est déjà terminée ou annulée.
      await tx.order.updateMany({
        where: { id: delivery.order_id, status: { notIn: COMMANDES_CLOSES } },
        data: {
          status: OrderStatus.CANCELLED,
          cancelled_at: now,
          cancelled_by: 'deliverer',
          cancelled_reason: dto.note ?? `Livraison échouée : ${dto.reason}`,
        },
      });
      return true;
    });
    if (!ecrite) return this.livraisonChangee(deliveryId, DeliveryStatut.FAILED);
    const updated = await this.lireSansCode(deliveryId);

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
      // Le livreur ne doit JAMAIS lire le code : c'est le client qui le lui
      // dicte, et c'est ce qui prouve la remise. Sans cette omission, la
      // reponse de la route lui donnait de quoi valider sans voir personne.
      omit: { delivery_pin: true },
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
  private async assertOwned(deliveryId: string, delivererId: string, expected: DeliveryStatut | DeliveryStatut[]) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        course: true,
        order: {
          select: {
            id: true,
            paied: true,
            payment_method: true,
            // Encaissement à la livraison (commande non payée)
            reference: true,
            // Commande ajoutée après le retrait : pas encore remise tant qu'elle est prête.
            status: true,
            amount: true,
            restaurant_id: true,
            customer_id: true,
          },
        },
      },
    });
    if (!delivery) throw new NotFoundException('Delivery non trouvée');
    if (delivery.course.deliverer_id !== delivererId) {
      throw new ForbiddenException("Cette livraison ne vous est pas affectée");
    }
    if (delivery.course.statut !== CourseStatut.IN_DELIVERY) {
      throw new BadRequestException('La course doit être en phase IN_DELIVERY');
    }
    const attendus = Array.isArray(expected) ? expected : [expected];
    if (!attendus.includes(delivery.statut)) {
      throw new BadRequestException(`Statut delivery attendu ${attendus.join(' ou ')}, actuel ${delivery.statut}`);
    }
    return delivery;
  }

  /**
   * L'écriture conditionnée n'a rien trouvé : la livraison a changé entre la
   * lecture et l'écriture. Déjà dans l'état visé (double toucher) : rendue
   * telle quelle, sans événement ; sinon 400, rien n'est écrit.
   */
  private async livraisonChangee(deliveryId: string, visee: DeliveryStatut) {
    const relue = await this.lireSansCode(deliveryId);
    if (relue.statut === visee) return relue;
    throw new BadRequestException(`Statut delivery changé entre-temps, actuel ${relue.statut}`);
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

    // Réservation : deux fins de livraison au même instant ne terminent la
    // course (événement, remise en file, notification) qu'une fois.
    const { count } = await this.prisma.course.updateMany({
      where: { id: courseId, statut: CourseStatut.IN_DELIVERY },
      data: { statut: CourseStatut.COMPLETED, completed_at: new Date() },
    });
    if (count !== 1) return;
    const completed = await this.prisma.course.findUniqueOrThrow({
      where: { id: courseId },
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
      select: { reference: true, restaurant_id: true },
    });
    await this.courseEvent.deliveryStatutChanged({
      delivery,
      course_id: delivery.course_id,
      course_reference: course?.reference ?? '',
      restaurant_id: course?.restaurant_id ?? null,
      previous_statut: previous,
      new_statut: delivery.statut,
    });
  }
}
