import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WebhookResponseDto } from '../dto/turbo-webhook.dto';
import { WebhookEvent } from '../enums/webhook-event.enum';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { PrismaService } from 'src/database/services/prisma.service';
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';
import { OrderChannels } from 'src/modules/order/enums/order-channels';
import { CourseChannels } from 'src/modules/course/enums/course-channels';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';

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

    const previousStatus = order.status;
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: newStatus,
        updated_at: new Date(),
        ...(newStatus === OrderStatus.PICKED_UP && { picked_up_at: new Date() }),
        ...(newStatus === OrderStatus.COMPLETED && { completed_at: new Date() }),
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
    if (delivery?.course_id) {
      await this.advanceCourse(delivery.course_id, CourseStatut.AT_RESTAURANT);
    }
    // La commande reste READY tant que les plats ne sont pas récupérés.
    return this.ack(WebhookEvent.DELIVERY_PICKUP_STARTED);
  }

  /** Plats récupérés au restaurant → la tournée démarre. */
  async handlePickedUp(data: any): Promise<WebhookResponseDto> {
    const delivery = await this.resolveDelivery(data?.numero);
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
   * Livrée : on clôt la livraison, puis la course SI toutes ses livraisons sont
   * terminées (une course peut avoir été partiellement sous-traitée).
   */
  async handleDelivered(data: any): Promise<WebhookResponseDto> {
    const delivery = await this.resolveDelivery(data?.numero);
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
    return this.syncStatus(data?.numero, OrderStatus.COMPLETED, WebhookEvent.DELIVERY_DELIVERED);
  }

  /** Annulée côté Turbo : la livraison CN est annulée avec elle. */
  async handleCancelled(data: any): Promise<WebhookResponseDto> {
    const delivery = await this.resolveDelivery(data?.numero);
    if (delivery) {
      await this.prisma.delivery.update({
        where: { id: delivery.id },
        data: { statut: DeliveryStatut.CANCELLED },
      });
    }
    return this.syncStatus(data?.numero, OrderStatus.CANCELLED, WebhookEvent.DELIVERY_CANCELLED);
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
            paied: true,
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

    // Code correct → clôture identique au flux interne (COMPLETED si déjà payée,
    // COLLECTED sinon : le paiement à la livraison reste à encaisser).
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.delivery.update({
        where: { id: delivery.id },
        data: { statut: DeliveryStatut.DELIVERED, delivered_at: now },
      }),
      this.prisma.order.update({
        where: { id: delivery.order_id },
        data: delivery.order.paied
          ? { status: OrderStatus.COMPLETED, collected_at: now, completed_at: now }
          : { status: OrderStatus.COLLECTED, collected_at: now },
      }),
    ]);

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
