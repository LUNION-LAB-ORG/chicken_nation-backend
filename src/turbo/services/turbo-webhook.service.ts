import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WebhookResponseDto } from '../dto/turbo-webhook.dto';
import { WebhookEvent } from '../enums/webhook-event.enum';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { PrismaService } from 'src/database/services/prisma.service';
import { CourseStatut, DeliveryStatut, OrderStatus, PaiementStatus } from '@prisma/client';
import { OrderChannels } from 'src/modules/order/enums/order-channels';
import { CourseChannels } from 'src/modules/course/enums/course-channels';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';
import { resoudreMoyenPaiement } from '../constantes/turbo.constante';

/**
 * Réception des webhooks de suivi de livraison Turbo (Turbo → CN).
 *
 * ⚠️ Contrat Turbo : `{ alias, data: { numero, courierId, ... } }` où
 * `numero` = RÉFÉRENCE de la commande CN (jamais l'UUID — CN n'envoie que la
 * référence à la création). On retrouve donc la commande par `reference`.
 * Sur `created`, `courierId` porte l'id de la COURSE (aucun livreur assigné) →
 * on ne l'interprète JAMAIS comme un livreur.
 *
 * ── Suivi COMPLET (sous-traitance) ──────────────────────────────────────────
 * Une commande confiée à Turbo doit être suivie AUSSI FINEMENT qu'une livraison
 * interne. Chaque événement met donc à jour les TROIS entités :
 *   • `Order`   → statut client (app cliente + backoffice)
 *   • `Delivery`→ étape fine + identité/position du livreur Turbo
 *   • `Course`  → cycle de vie identique à l'interne (ACCEPTED → AT_RESTAURANT
 *                 → IN_DELIVERY → COMPLETED)
 *
 * Les positions GPS sont relayées sur le MÊME canal que le suivi interne
 * (`delivery:location`) : l'app cliente suit un livreur Turbo sans aucune
 * modification.
 *
 * Tolérant : jamais d'exception (donc plus de 500/400), idempotent, no-op si la
 * commande est absente.
 */
@Injectable()
export class TurboWebhookService {
  private readonly logger = new Logger(TurboWebhookService.name);

  /** Tentatives autorisées sur le code client avant blocage (anti-brute-force). */
  private static readonly MAX_CODE_ATTEMPTS = 5;

  constructor(
    private readonly appGateway: AppGateway,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly notificationsSender: NotificationsSenderService,
  ) { }

  private ack(event: WebhookEvent, process = true): WebhookResponseDto {
    return { event, received: true, process };
  }

  /**
   * 🔒 Authentification du webhook. Jusqu'ici, TOUTE clé non vide était
   * acceptée : n'importe qui pouvait marquer une commande livrée ou annulée.
   * On exige désormais une clé appartenant à un restaurant connu.
   *
   * Bascule en DEUX TEMPS pour ne pas casser l'intégration en cours :
   *   • par défaut (souple) : une clé inconnue est journalisée en ERREUR mais
   *     l'événement est traité — on observe ce que Turbo envoie réellement ;
   *   • `TURBO_WEBHOOK_STRICT=true` : la clé inconnue est REJETÉE.
   * Une fois les journaux confirmés, passer la variable à `true`.
   */
  async verifierCleApi(apiKey?: string): Promise<{ known: boolean; reject: boolean }> {
    const strict = process.env.TURBO_WEBHOOK_STRICT === 'true';
    if (!apiKey) return { known: false, reject: true };

    const resto = await this.prisma.restaurant.findFirst({
      where: { apikey: apiKey },
      select: { id: true },
    });
    if (resto) return { known: true, reject: false };

    this.logger.error(
      `🔒 Webhook Turbo : clé API INCONNUE (${apiKey.slice(0, 6)}…) — ${strict ? 'REJETÉ' : 'toléré (mode souple)'}.`,
    );
    return { known: false, reject: strict };
  }

  /** Retrouve la commande CN par la RÉFÉRENCE portée par `data.numero`. */
  private async resolveOrder(numero?: string) {
    if (!numero) return null;
    return this.prisma.order.findFirst({
      where: { reference: numero },
      include: {
        restaurant: true,
        customer: { include: { notification_settings: true } },
      },
    });
  }

  /**
   * Webhook PÉRIMÉ ? Après une RELANCE, la même livraison vit sur une NOUVELLE
   * course (référence neuve). Un webhook rejoué de l'ANCIENNE course (annulée)
   * ne doit pas toucher la nouvelle : quand Turbo fournit `referenceCourse` et
   * qu'elle ne correspond plus à la course actuelle de la livraison, l'événement
   * est ignoré. Tolérant : sans `referenceCourse`, on traite normalement.
   */
  private isStaleForCourse(
    delivery: { course?: { reference?: string | null } | null },
    data: any,
  ): boolean {
    const refCourse = data?.referenceCourse ? String(data.referenceCourse) : null;
    const current = delivery.course?.reference ?? null;
    return Boolean(refCourse && current && refCourse !== current);
  }

  /**
   * Retrouve la LIVRAISON CN (et sa course) rattachée à la commande. Absente si
   * la commande a été envoyée à Turbo dès la création (flux « Turbo direct »,
   * sans course interne) — dans ce cas seul l'Order est suivi.
   */
  private async resolveDelivery(numero?: string) {
    if (!numero) return null;
    return this.prisma.delivery.findFirst({
      where: { order: { reference: numero } },
      include: { course: true, order: { select: { id: true, customer_id: true } } },
    });
  }

  private statusMessage(status: OrderStatus): string {
    switch (status) {
      case OrderStatus.PICKED_UP:
        return 'Commande en livraison';
      case OrderStatus.COLLECTED:
        return 'Commande livrée';
      case OrderStatus.COMPLETED:
        return 'Commande terminée';
      case OrderStatus.CANCELLED:
        return 'Commande annulée';
      default:
        return 'Statut mis à jour';
    }
  }

  /**
   * Fait progresser la COURSE CN sur son cycle de vie normal. Idempotent et
   * ANTI-RETOUR : on n'applique la transition que si elle avance (un webhook
   * rejoué ou arrivé dans le désordre ne fait jamais reculer la course).
   */
  private async advanceCourse(courseId: string, next: CourseStatut): Promise<void> {
    const ORDER: CourseStatut[] = [
      CourseStatut.PENDING_ASSIGNMENT,
      CourseStatut.ACCEPTED,
      CourseStatut.AT_RESTAURANT,
      CourseStatut.IN_DELIVERY,
      CourseStatut.COMPLETED,
    ];
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, statut: true },
    });
    if (!course) return;

    const from = ORDER.indexOf(course.statut);
    const to = ORDER.indexOf(next);
    if (from === -1 || to === -1 || to <= from) return; // terminal, inconnu ou recul

    const now = new Date();
    await this.prisma.course.update({
      where: { id: courseId },
      data: {
        statut: next,
        ...(next === CourseStatut.ACCEPTED && { assigned_at: now }),
        ...(next === CourseStatut.IN_DELIVERY && { picked_up_at: now }),
        ...(next === CourseStatut.COMPLETED && { completed_at: now }),
      },
    });
    this.appGateway.emitToBackoffice(CourseChannels.COURSE_STATUT_CHANGED, {
      course_id: courseId,
      statut: next,
      source: 'turbo',
    });
  }

  /** Met à jour l'étape fine de la livraison CN (miroir du suivi interne). */
  private async advanceDelivery(
    deliveryId: string,
    next: DeliveryStatut,
    customerId?: string | null,
    orderId?: string,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        statut: next,
        ...(next === DeliveryStatut.IN_ROUTE && { in_route_at: now }),
        ...(next === DeliveryStatut.ARRIVED && { arrived_at: now }),
        ...(next === DeliveryStatut.DELIVERED && { delivered_at: now }),
      },
    });
    // Même canal que le suivi interne → l'app cliente n'a rien à changer.
    if (customerId) {
      this.appGateway.emitToUser(
        customerId,
        'customer',
        CourseChannels.CUSTOMER_DELIVERY_STATUT_CHANGED,
        { orderId, deliveryStatut: next, source: 'turbo' },
      );
    }
  }

  /**
   * Applique un nouveau statut à la commande (idempotent) et propage :
   *  - temps réel UI (AppGateway → client, backoffice, restaurant) ;
   *  - effets métier via l'EventEmitter (fidélité, notifications…).
   */
  private async syncStatus(
    numero: string,
    newStatus: OrderStatus,
    alias: WebhookEvent,
  ): Promise<WebhookResponseDto> {
    const order = await this.resolveOrder(numero);
    if (!order) {
      this.logger.warn(`Webhook Turbo ${alias} : commande « ${numero} » introuvable.`);
      return this.ack(alias, false);
    }
    if (order.status === newStatus) {
      return this.ack(alias); // déjà à ce statut → rien à faire
    }

    // ANTI-RÉGRESSION : un webhook rejoué ou arrivé dans le désordre ne fait
    // JAMAIS reculer la commande, et ne ressuscite jamais un état terminal
    // (une commande annulée manuellement ou terminée le reste).
    if (
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.COMPLETED
    ) {
      return this.ack(alias);
    }
    const RANK: Partial<Record<OrderStatus, number>> = {
      [OrderStatus.PENDING]: 0,
      [OrderStatus.ACCEPTED]: 1,
      [OrderStatus.IN_PROGRESS]: 2,
      [OrderStatus.READY]: 3,
      [OrderStatus.PICKED_UP]: 4,
      [OrderStatus.COLLECTED]: 5,
      [OrderStatus.COMPLETED]: 6,
    };
    const from = RANK[order.status];
    const to = RANK[newStatus];
    if (from !== undefined && to !== undefined && to <= from) {
      return this.ack(alias); // recul → no-op
    }

    const previousStatus = order.status;
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: newStatus,
        updated_at: new Date(),
        ...(newStatus === OrderStatus.PICKED_UP && { picked_up_at: new Date() }),
        ...(newStatus === OrderStatus.COLLECTED && { collected_at: new Date() }),
        ...(newStatus === OrderStatus.COMPLETED && {
          collected_at: order.collected_at ?? new Date(),
          completed_at: new Date(),
        }),
        ...(newStatus === OrderStatus.CANCELLED && {
          cancelled_at: new Date(),
          cancelled_reason: 'Annulée par Turbo',
        }),
      },
      include: {
        restaurant: true,
        customer: { include: { notification_settings: true } },
      },
    });

    // Temps réel UI — même canal/payload que les mises à jour de statut normales.
    const statusData = {
      order: updated,
      message: this.statusMessage(newStatus),
      previousStatus,
    };
    this.appGateway.emitToUser(updated.customer_id, 'customer', OrderChannels.ORDER_STATUS_UPDATED, statusData);
    this.appGateway.emitToBackoffice(OrderChannels.ORDER_STATUS_UPDATED, statusData);
    this.appGateway.emitToRestaurant(updated.restaurant_id, OrderChannels.ORDER_STATUS_UPDATED, statusData);

    // Effets métier (fidélité sur COMPLETED, notifications…) : même événement que
    // partout ailleurs → réutilise les listeners existants. Le listener Turbo
    // n'agit que sur READY → pas de boucle.
    this.eventEmitter.emit(OrderChannels.ORDER_STATUS_UPDATED, {
      order: updated,
      expo_token: updated.customer?.notification_settings?.expo_push_token,
    });

    this.logger.log(`Webhook Turbo ${alias} → commande ${numero} : ${previousStatus} → ${newStatus}.`);
    return this.ack(alias);
  }

  // ── Handlers par événement ────────────────────────────────────────────────

  /**
   * Course créée côté Turbo. La commande est DÉJÀ READY (c'est ce qui a
   * déclenché l'envoi). `courierId` = id de la COURSE Turbo, PAS un livreur :
   * on le mémorise pour la traçabilité (rapprochement, support, litiges).
   */
  async handleDeliveryCreated(data: any): Promise<WebhookResponseDto> {
    const delivery = await this.resolveDelivery(data?.numero);
    if (delivery && data?.courierId) {
      await this.prisma.delivery.update({
        where: { id: delivery.id },
        data: { turbo_course_id: String(data.courierId) },
      });
    }
    this.logger.log(`Course Turbo confirmée pour la commande ${data?.numero}.`);
    return this.ack(WebhookEvent.DELIVERY_CREATED);
  }

  /**
   * Un livreur Turbo est affecté : on enregistre son identité (qui livre,
   * comment le joindre) et la course CN passe ACCEPTED — exactement comme si un
   * livreur interne avait accepté.
   *
   * Les champs d'identité sont lus de façon TOLÉRANTE : le contrat Turbo peut
   * les nommer différemment (ou ne pas encore les envoyer) — dans ce cas seul
   * l'identifiant est stocké et l'affichage retombe sur « Livreur Turbo ».
   */
  async handleCourierAssigned(data: any): Promise<WebhookResponseDto> {
    const delivery = await this.resolveDelivery(data?.numero);
    if (!delivery) {
      this.logger.warn(`Webhook Turbo courier_assigned : livraison « ${data?.numero} » introuvable.`);
      return this.ack(WebhookEvent.DELIVERY_COURIER_ASSIGNED, false);
    }
    if (this.isStaleForCourse(delivery, data)) {
      return this.ack(WebhookEvent.DELIVERY_COURIER_ASSIGNED); // webhook d'une ancienne course
    }

    const name =
      data?.courierName ?? data?.nomComplet ?? data?.courier?.nomComplet ?? data?.courier?.name ?? null;
    const phone =
      data?.courierPhone ?? data?.contact ?? data?.courier?.contact ?? data?.courier?.telephone ?? null;
    const courierId = data?.courierId ?? data?.courier?.id ?? null;

    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        ...(courierId && { turbo_courier_id: String(courierId) }),
        ...(name && { turbo_courier_name: String(name) }),
        ...(phone && { turbo_courier_phone: String(phone) }),
      },
    });

    if (delivery.course_id) {
      await this.advanceCourse(delivery.course_id, CourseStatut.ACCEPTED);
    }

    this.logger.log(
      `Livreur Turbo assigné (commande ${data?.numero})${name ? ` : ${name}` : ''}.`,
    );
    return this.ack(WebhookEvent.DELIVERY_COURIER_ASSIGNED);
  }

  /** Le livreur Turbo est en route vers le restaurant / sur place. */
  async handlePickupStarted(data: any): Promise<WebhookResponseDto> {
    const delivery = await this.resolveDelivery(data?.numero);
    if (delivery && this.isStaleForCourse(delivery, data)) {
      return this.ack(WebhookEvent.DELIVERY_PICKUP_STARTED);
    }
    if (delivery?.course_id) {
      await this.advanceCourse(delivery.course_id, CourseStatut.AT_RESTAURANT);
    }
    // La commande reste READY tant que les plats ne sont pas récupérés.
    return this.ack(WebhookEvent.DELIVERY_PICKUP_STARTED);
  }

  /** Plats récupérés au restaurant → la tournée démarre. */
  async handlePickedUp(data: any): Promise<WebhookResponseDto> {
    const delivery = await this.resolveDelivery(data?.numero);
    if (delivery && this.isStaleForCourse(delivery, data)) {
      return this.ack(WebhookEvent.DELIVERY_PICKED_UP);
    }
    if (delivery) {
      if (delivery.course_id) {
        await this.advanceCourse(delivery.course_id, CourseStatut.IN_DELIVERY);
      }
      await this.advanceDelivery(
        delivery.id,
        DeliveryStatut.IN_ROUTE,
        delivery.order?.customer_id,
        delivery.order_id,
      );
    }
    return this.syncStatus(data?.numero, OrderStatus.PICKED_UP, WebhookEvent.DELIVERY_PICKED_UP);
  }

  /** En route vers le client (même étape métier que picked_up côté commande). */
  async handleInTransit(data: any): Promise<WebhookResponseDto> {
    const delivery = await this.resolveDelivery(data?.numero);
    if (delivery && this.isStaleForCourse(delivery, data)) {
      return this.ack(WebhookEvent.DELIVERY_IN_TRANSIT);
    }
    if (delivery) {
      if (delivery.course_id) {
        await this.advanceCourse(delivery.course_id, CourseStatut.IN_DELIVERY);
      }
      await this.advanceDelivery(
        delivery.id,
        DeliveryStatut.IN_ROUTE,
        delivery.order?.customer_id,
        delivery.order_id,
      );
    }
    return this.syncStatus(data?.numero, OrderStatus.PICKED_UP, WebhookEvent.DELIVERY_IN_TRANSIT);
  }

  /**
   * ENCAISSEMENT À LA LIVRAISON : le livreur Turbo a encaissé le client et nous
   * transmet le moyen de paiement (contrat : code fermé `cash` / `orange-ci` /
   * `mtn-ci` / `moov-ci` / `wave` / `card` — CN dérive la catégorie comptable).
   *
   * On enregistre un Paiement **PENDING** : la commande passe COLLECTED et ne se
   * termine qu'après confirmation humaine au backoffice (bouton → SUCCESS →
   * COMPLETED). Idempotent : un seul encaissement Turbo en attente par commande
   * (webhook rejoué = no-op).
   */
  private async enregistrerEncaissementLivreur(
    order: {
      id: string;
      reference: string;
      amount: number;
      restaurant_id: string;
      customer_id: string;
    },
    data: any,
  ): Promise<void> {
    const dejaDeclare = await this.prisma.paiement.findFirst({
      where: { order_id: order.id, status: PaiementStatus.PENDING },
      select: { id: true },
    });
    if (dejaDeclare) return;

    const moyen = resoudreMoyenPaiement(data?.moyenPaiement ?? data?.modePaiement);
    const montantBrut = Number(data?.montantEncaisse ?? data?.montant);
    const montant =
      Number.isFinite(montantBrut) && montantBrut > 0 ? montantBrut : order.amount;

    try {
      await this.prisma.paiement.create({
        data: {
          reference: `TURBO-${order.reference}-${Date.now()}`,
          amount: montant,
          total: montant,
          fees: 0,
          mode: moyen.mode,
          source: moyen.source,
          status: PaiementStatus.PENDING,
          order_id: order.id,
          client_id: order.customer_id,
        },
      });
    } catch (err: any) {
      // Index unique partiel (1 PENDING par commande) : un create concurrent
      // (webhook rejoué, valider-code + delivered, 2 backends) a déjà gagné.
      if (err?.code === 'P2002') return;
      throw err;
    }

    this.logger.log(
      `Encaissement livreur Turbo enregistré (EN ATTENTE) — commande ${order.reference} : ${montant} XOF en ${moyen.label}.`,
    );

    this.notificationsSender
      .sendTurboPaymentPendingBell({
        reference: order.reference,
        restaurantId: order.restaurant_id,
        montant,
        moyenLabel: moyen.label,
      })
      .catch(() => undefined);
  }

  /**
   * Livrée : on clôt la livraison, puis la course SI toutes ses livraisons sont
   * terminées (une course peut avoir été partiellement sous-traitée).
   *
   * Commande DÉJÀ PAYÉE → COMPLETED (comme avant). NON payée → COLLECTED +
   * enregistrement de l'encaissement livreur EN ATTENTE : plus jamais de refus
   * « la commande n'a pas été payée » côté Turbo, et jamais de COMPLETED sans
   * paiement tracé — le backoffice confirme, la commande se termine.
   */
  async handleDelivered(data: any): Promise<WebhookResponseDto> {
    const delivery = await this.resolveDelivery(data?.numero);
    if (delivery && this.isStaleForCourse(delivery, data)) {
      return this.ack(WebhookEvent.DELIVERY_DELIVERED); // webhook d'une ancienne course
    }
    if (delivery) {
      await this.advanceDelivery(
        delivery.id,
        DeliveryStatut.DELIVERED,
        delivery.order?.customer_id,
        delivery.order_id,
      );
      if (delivery.course_id) {
        const restantes = await this.prisma.delivery.count({
          where: {
            course_id: delivery.course_id,
            statut: { notIn: [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED, DeliveryStatut.CANCELLED] },
          },
        });
        if (restantes === 0) {
          await this.advanceCourse(delivery.course_id, CourseStatut.COMPLETED);
        }
      }
    }

    const order = await this.resolveOrder(data?.numero);
    if (!order) {
      this.logger.warn(`Webhook Turbo delivered : commande « ${data?.numero} » introuvable.`);
      return this.ack(WebhookEvent.DELIVERY_DELIVERED, false);
    }

    // État terminal → no-op complet : pas de régression de statut ET pas de
    // paiement fantôme sur une commande annulée/terminée (webhook rejoué).
    if (
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.COMPLETED
    ) {
      return this.ack(WebhookEvent.DELIVERY_DELIVERED);
    }

    if (order.paied) {
      return this.syncStatus(data?.numero, OrderStatus.COMPLETED, WebhookEvent.DELIVERY_DELIVERED);
    }

    await this.enregistrerEncaissementLivreur(order, data);
    return this.syncStatus(data?.numero, OrderStatus.COLLECTED, WebhookEvent.DELIVERY_DELIVERED);
  }

  /**
   * ANNULATION CÔTÉ TURBO — DÉCOUPLÉE de la commande.
   *
   * Avant : leur annulation annulait la COMMANDE CN. Désormais seule la
   * course/livraison CN est annulée, avec la RAISON transmise (`data.raison`),
   * affichée au staff (drawer + détail commande). La commande reste VIVANTE :
   * le staff décide — relancer une livraison (nouvelle course, nouvelle
   * référence) ou annuler la commande manuellement comme aujourd'hui.
   *
   * Deux portées (contrat) :
   *  - `numero` renseigné → annulation d'UNE commande du groupe ;
   *  - sinon `referenceCourse` → annulation du groupe ENTIER.
   * Claims conditionnés sur le statut : idempotent, anti-régression (une
   * livraison déjà livrée n'est jamais « dé-livrée »), sûr avec 2 backends.
   */
  async handleCancelled(data: any): Promise<WebhookResponseDto> {
    const raison =
      String(data?.raison ?? data?.reason ?? data?.motif ?? '').trim().slice(0, 500) ||
      'Raison non transmise par Turbo';

    const TERMINAL_DELIVERY: DeliveryStatut[] = [
      DeliveryStatut.DELIVERED,
      DeliveryStatut.FAILED,
      DeliveryStatut.CANCELLED,
    ];

    // ── Portée COMMANDE : data.numero identifie une livraison précise ────────
    const delivery = await this.resolveDelivery(data?.numero);
    if (delivery && this.isStaleForCourse(delivery, data)) {
      // Rejeu de l'annulation d'une ANCIENNE course déjà relancée : la
      // nouvelle course est vivante chez Turbo — ne surtout pas l'annuler.
      return this.ack(WebhookEvent.DELIVERY_CANCELLED);
    }
    if (delivery) {
      const claim = await this.prisma.delivery.updateMany({
        where: { id: delivery.id, statut: { notIn: TERMINAL_DELIVERY } },
        data: { statut: DeliveryStatut.CANCELLED, turbo_cancelled_reason: raison },
      });

      if (claim.count === 1 && delivery.course_id) {
        await this.cancelCourseIfNoDeliveryLeft(delivery.course_id, raison);
        this.notifierAnnulationTurbo(delivery.course_id, [String(data?.numero)], raison);
      }
      // ⚠️ La COMMANDE n'est plus touchée : décision humaine (relance ou
      // annulation manuelle depuis le backoffice).
      return this.ack(WebhookEvent.DELIVERY_CANCELLED);
    }

    // ── Portée GROUPE : referenceCourse sans numero résolvable ───────────────
    const referenceCourse = data?.referenceCourse ?? data?.reference;
    if (referenceCourse) {
      const course = await this.prisma.course.findFirst({
        where: { reference: String(referenceCourse) },
        select: {
          id: true,
          deliveries: {
            where: { statut: { notIn: TERMINAL_DELIVERY } },
            select: { id: true, order: { select: { reference: true } } },
          },
        },
      });
      if (course) {
        const cancelled = await this.prisma.delivery.updateMany({
          where: { course_id: course.id, statut: { notIn: TERMINAL_DELIVERY } },
          data: { statut: DeliveryStatut.CANCELLED, turbo_cancelled_reason: raison },
        });
        await this.cancelCourseIfNoDeliveryLeft(course.id, raison);
        // Cloche uniquement si l'événement a réellement changé quelque chose
        // (un webhook rejoué ne re-notifie pas le staff).
        if (cancelled.count > 0) {
          this.notifierAnnulationTurbo(
            course.id,
            course.deliveries.map((d) => d.order.reference),
            raison,
          );
        }
        return this.ack(WebhookEvent.DELIVERY_CANCELLED);
      }
    }

    // ── Legacy : commande envoyée à Turbo SANS course interne (ancien flux
    // direct). La commande reste vivante aussi — on alerte le staff pour
    // qu'un humain tranche.
    const order = await this.resolveOrder(data?.numero);
    if (order) {
      this.logger.warn(
        `Webhook Turbo cancelled (flux direct, sans course) — commande ${order.reference} : ${raison}. Commande laissée intacte.`,
      );
      this.notificationsSender
        .sendTurboCourseCancelledBell({
          courseReference: null,
          restaurantId: order.restaurant_id,
          orderReferences: [order.reference],
          raison,
        })
        .catch(() => undefined);
      return this.ack(WebhookEvent.DELIVERY_CANCELLED);
    }

    this.logger.warn(
      `Webhook Turbo cancelled : cible introuvable (numero=${data?.numero ?? '—'}, referenceCourse=${referenceCourse ?? '—'}).`,
    );
    return this.ack(WebhookEvent.DELIVERY_CANCELLED, false);
  }

  /**
   * Passe la Course CN en CANCELLED (raison Turbo) s'il ne lui reste plus
   * aucune livraison active. Claim conditionné : jamais de régression depuis
   * COMPLETED, idempotent, sûr avec 2 backends.
   */
  private async cancelCourseIfNoDeliveryLeft(courseId: string, raison: string): Promise<void> {
    const actives = await this.prisma.delivery.count({
      where: {
        course_id: courseId,
        statut: { notIn: [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED, DeliveryStatut.CANCELLED] },
      },
    });
    if (actives > 0) return;

    const claim = await this.prisma.course.updateMany({
      where: {
        id: courseId,
        statut: { notIn: [CourseStatut.COMPLETED, CourseStatut.CANCELLED, CourseStatut.EXPIRED] },
      },
      data: {
        statut: CourseStatut.CANCELLED,
        cancelled_at: new Date(),
        cancelled_by: 'turbo',
        cancelled_reason: raison,
      },
    });
    if (claim.count === 1) {
      this.appGateway.emitToBackoffice(CourseChannels.COURSE_STATUT_CHANGED, {
        course_id: courseId,
        statut: CourseStatut.CANCELLED,
        source: 'turbo',
        raison,
      });
    }
  }

  /** Cloche staff « Turbo a annulé » — les commandes restent actives. */
  private notifierAnnulationTurbo(
    courseId: string,
    orderReferences: string[],
    raison: string,
  ): void {
    this.prisma.course
      .findUnique({
        where: { id: courseId },
        select: { reference: true, restaurant_id: true },
      })
      .then((course) => {
        if (!course) return;
        return this.notificationsSender.sendTurboCourseCancelledBell({
          courseReference: course.reference,
          restaurantId: course.restaurant_id,
          orderReferences,
          raison,
        });
      })
      .catch(() => undefined);
  }

  /**
   * Position du livreur Turbo : persistée sur la livraison ET relayée au client
   * sur le MÊME canal que le suivi interne (`delivery:location`) → l'app cliente
   * affiche le livreur Turbo sur sa carte sans aucune modification.
   *
   * Lecture tolérante des coordonnées (le contrat Turbo peut varier).
   */
  async handleLocationUpdated(data: any): Promise<WebhookResponseDto> {
    const lat = Number(data?.latitude ?? data?.lat ?? data?.position?.latitude);
    const lng = Number(data?.longitude ?? data?.lng ?? data?.position?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return this.ack(WebhookEvent.COURIER_LOCATION_UPDATED, false);
    }

    const delivery = await this.resolveDelivery(data?.numero);
    if (!delivery) return this.ack(WebhookEvent.COURIER_LOCATION_UPDATED, false);

    const now = new Date();
    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        turbo_courier_lat: lat,
        turbo_courier_lng: lng,
        turbo_courier_location_at: now,
      },
    });

    if (delivery.order?.customer_id) {
      this.appGateway.emitToUser(
        delivery.order.customer_id,
        'customer',
        CourseChannels.CUSTOMER_DELIVERY_LOCATION,
        {
          orderId: delivery.order_id,
          delivererId: delivery.turbo_courier_id ?? 'turbo',
          lat,
          lng,
          deliveryStatut: delivery.statut,
          source: 'turbo',
          ts: now.toISOString(),
        },
      );
    }
    return this.ack(WebhookEvent.COURIER_LOCATION_UPDATED);
  }

  /**
   * VALIDATION DU CODE CLIENT par un livreur Turbo (Turbo → CN).
   *
   * Le code à 4 chiffres que le client communique au livreur NE QUITTE JAMAIS
   * nos serveurs : l'application Turbo nous envoie le code saisi, nous répondons
   * valide / invalide. Si valide, la livraison est clôturée exactement comme
   * pour un livreur interne (même transition, mêmes effets métier).
   *
   * 🔒 Sécurité : la clé API doit être celle DU RESTAURANT de la commande — une
   * clé valide d'un autre restaurant ne permet pas de clore ses livraisons.
   */
  async validerCodeClient(params: {
    numero: string;
    code: string;
    apiKey: string;
    /** Moyen de paiement encaissé par le livreur (code fermé du contrat). */
    moyenPaiement?: string;
    /** Montant réellement encaissé (défaut : montant TTC de la commande). */
    montantEncaisse?: number;
  }): Promise<{ valid: boolean; message: string }> {
    const { numero, code, apiKey } = params;
    if (!numero || !code) {
      return { valid: false, message: 'Référence et code requis.' };
    }

    const delivery = await this.prisma.delivery.findFirst({
      where: { order: { reference: numero } },
      include: {
        order: {
          select: {
            id: true,
            reference: true,
            amount: true,
            paied: true,
            status: true,
            customer_id: true,
            restaurant_id: true,
            restaurant: { select: { apikey: true } },
          },
        },
      },
    });
    if (!delivery) {
      return { valid: false, message: 'Livraison introuvable.' };
    }

    // Commande annulée côté CN pendant que le livreur roulait : il ne doit PAS
    // livrer (ni encaisser). Message explicite plutôt qu'un « code invalide ».
    if (delivery.order.status === OrderStatus.CANCELLED) {
      return {
        valid: false,
        message:
          'Commande annulée côté Chicken Nation — ne pas livrer. Contactez le restaurant.',
      };
    }
    if (delivery.order.status === OrderStatus.COMPLETED) {
      return { valid: true, message: 'Livraison déjà confirmée.' }; // idempotent
    }

    // Cloisonnement : la clé doit être celle du restaurant de la commande.
    if (!apiKey || delivery.order.restaurant?.apikey !== apiKey) {
      this.logger.warn(`Validation code client refusée (clé invalide) — commande ${numero}.`);
      return { valid: false, message: 'Clé API non autorisée pour cette commande.' };
    }

    if (delivery.statut === DeliveryStatut.DELIVERED) {
      return { valid: true, message: 'Livraison déjà confirmée.' }; // idempotent
    }

    // 🔒 Anti-brute-force : le code fait 4 chiffres (10 000 combinaisons), donc
    // quelques minutes suffiraient avec une clé valide. Au-delà du plafond, la
    // validation est BLOQUÉE — le livreur doit passer par le staff.
    if (delivery.turbo_code_attempts >= TurboWebhookService.MAX_CODE_ATTEMPTS) {
      return {
        valid: false,
        message:
          'Trop de tentatives. Validation bloquée — contactez le restaurant pour confirmer la livraison.',
      };
    }

    if (delivery.delivery_pin !== code) {
      const attempts = delivery.turbo_code_attempts + 1;
      await this.prisma.delivery.update({
        where: { id: delivery.id },
        data: { turbo_code_attempts: attempts },
      });
      this.logger.warn(
        `Code client invalide pour la commande ${numero} (${attempts}/${TurboWebhookService.MAX_CODE_ATTEMPTS}).`,
      );

      // Seuil atteint → alerte staff : soit le livreur se trompe de commande,
      // soit quelqu'un essaie de forcer un code. Dans les deux cas, un humain doit voir.
      if (attempts >= TurboWebhookService.MAX_CODE_ATTEMPTS) {
        this.logger.error(
          `🚨 Code client BLOQUÉ après ${attempts} tentatives — commande ${numero} (livreur Turbo).`,
        );
        this.notificationsSender
          .sendTurboCodeBlockedBell({
            reference: numero,
            restaurantId: delivery.order.restaurant_id,
            attempts,
          })
          .catch(() => undefined);
      }

      return {
        valid: false,
        message: `Code invalide (${attempts}/${TurboWebhookService.MAX_CODE_ATTEMPTS} tentatives).`,
      };
    }

    // Code correct → clôture identique au flux interne. La transition de la
    // COMMANDE passe par `syncStatus` (mêmes sockets et effets métier que les
    // webhooks) : COMPLETED si déjà payée, sinon COLLECTED + encaissement
    // livreur enregistré EN ATTENTE (confirmation backoffice → COMPLETED).
    const now = new Date();
    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { statut: DeliveryStatut.DELIVERED, delivered_at: now },
    });

    if (delivery.order.paied) {
      await this.syncStatus(numero, OrderStatus.COMPLETED, WebhookEvent.DELIVERY_DELIVERED);
    } else {
      await this.enregistrerEncaissementLivreur(delivery.order, {
        moyenPaiement: params.moyenPaiement,
        montantEncaisse: params.montantEncaisse,
      });
      await this.syncStatus(numero, OrderStatus.COLLECTED, WebhookEvent.DELIVERY_DELIVERED);
    }

    if (delivery.order.customer_id) {
      this.appGateway.emitToUser(
        delivery.order.customer_id,
        'customer',
        CourseChannels.CUSTOMER_DELIVERY_STATUT_CHANGED,
        { orderId: delivery.order_id, deliveryStatut: DeliveryStatut.DELIVERED, source: 'turbo' },
      );
    }

    // Course terminée si plus aucune livraison en cours.
    if (delivery.course_id) {
      const restantes = await this.prisma.delivery.count({
        where: {
          course_id: delivery.course_id,
          statut: { notIn: [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED, DeliveryStatut.CANCELLED] },
        },
      });
      if (restantes === 0) {
        await this.advanceCourse(delivery.course_id, CourseStatut.COMPLETED);
      }
    }

    this.logger.log(`Code client validé (Turbo) — commande ${numero} livrée.`);
    return { valid: true, message: 'Livraison confirmée.' };
  }

  /**
   * Incident déclaré par un livreur Turbo (accident, agression, panne…).
   * Auparavant simplement loggé : personne ne le voyait. Le staff est désormais
   * ALERTÉ — un incident sur une livraison en cours demande une réaction humaine
   * immédiate (rappeler le client, relancer la commande, prévenir Turbo).
   */
  async handleEmergency(data: any): Promise<WebhookResponseDto> {
    this.logger.error(`🚨 Urgence Turbo (commande ${data?.numero}): ${JSON.stringify(data)}`);

    const order = await this.resolveOrder(data?.numero);
    if (order) {
      const motif =
        data?.motif ?? data?.reason ?? data?.message ?? 'incident non précisé';
      this.notificationsSender
        .sendTurboEmergencyBell({
          reference: order.reference,
          restaurantId: order.restaurant_id,
          motif: String(motif).slice(0, 200),
        })
        .catch(() => undefined);
    }
    return this.ack(WebhookEvent.DELIVERY_EMERGENCY);
  }
}
