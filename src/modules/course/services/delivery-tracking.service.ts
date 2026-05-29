import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CourseStatut, DeliveryStatut } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import type { DelivererLocationUpdatedPayload } from 'src/modules/deliverers/events/deliverer.event';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { CourseChannels } from '../enums/course-channels';
import type { DeliveryStatutChangedPayload } from '../interfaces/course-event.interface';

/**
 * Suivi de livraison TEMPS RÉEL côté CLIENT (app cliente).
 *
 * Ce service est le pont entre le monde "livreur/course" (interne) et le
 * monde "client". Il relaie deux choses vers la room `customer_{id}` :
 *
 *   1. `delivery:location` — la position GPS live du livreur, à haute fréquence
 *      pendant que la course est en cours (IN_DELIVERY). C'est ce qui anime la
 *      carte type Uber Eats / Yango côté client.
 *
 *   2. `delivery:statut:changed` — chaque transition de SA livraison
 *      (PENDING → IN_ROUTE → ARRIVED → DELIVERED…), pour que l'app rafraîchisse
 *      l'état (message "votre livreur arrive", bascule de la carte, etc.).
 *
 * POURQUOI ici (module course) et pas dans le module deliverers :
 *   La résolution "quel(s) client(s) doit recevoir cette position ?" dépend du
 *   graphe Course → Delivery → Order → Customer, qui appartient au domaine
 *   course. Le module deliverers se contente d'émettre l'event interne
 *   `deliverer:location:updated` (haute fréquence) ; on l'écoute ici.
 *
 * Le relais inter-instances est assuré par l'adaptateur Redis socket.io
 * (cf. RedisIoAdapter) : livreur et client peuvent être sur 2 instances
 * différentes, l'event traverse quand même.
 */
@Injectable()
export class DeliveryTrackingService {
  private readonly logger = new Logger(DeliveryTrackingService.name);

  /** Livraisons "vivantes" : le client doit voir le livreur tant qu'il n'a pas reçu sa commande. */
  private static readonly NON_TERMINAL: DeliveryStatut[] = [
    DeliveryStatut.PENDING,
    DeliveryStatut.IN_ROUTE,
    DeliveryStatut.ARRIVED,
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly appGateway: AppGateway,
  ) {}

  // ── 1. Position live livreur → client(s) ───────────────────────────────────

  /**
   * Reçoit chaque remontée GPS du livreur (haute fréquence pendant la livraison)
   * et la relaie au(x) client(s) dont la livraison est en cours dans la course
   * active de ce livreur.
   *
   * Robuste : un livreur en pause / sans course active ne déclenche aucune
   * émission (résolution = liste vide). Les erreurs sont loggées sans casser le
   * flux GPS (l'event est déjà fire-and-forget côté émetteur).
   */
  @OnEvent(DelivererChannels.DELIVERER_LOCATION_UPDATED)
  async onDelivererLocation(payload: DelivererLocationUpdatedPayload): Promise<void> {
    try {
      const targets = await this.resolveActiveCustomers(payload.delivererId);
      if (targets.length === 0) return;

      for (const t of targets) {
        this.appGateway.emitToUser(
          t.customerId,
          'customer',
          CourseChannels.CUSTOMER_DELIVERY_LOCATION,
          {
            orderId: t.orderId,
            delivererId: payload.delivererId,
            lat: payload.lat,
            lng: payload.lng,
            heading: payload.heading,
            speedKmh: payload.speedKmh,
            deliveryStatut: t.deliveryStatut,
            ts: payload.ts,
          },
        );
      }
    } catch (err) {
      this.logger.warn(
        `Relais position livreur ${payload.delivererId} échoué: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Résout les clients à notifier pour un livreur donné : course active
   * (IN_DELIVERY) → livraisons non terminales → client de chaque order.
   *
   * Requête indexée sur `Course(deliverer_id, statut)` + retour de quelques
   * lignes max (livraisons d'une seule course) ⇒ assez légère pour être appelée
   * à chaque ping GPS sans cache.
   */
  private async resolveActiveCustomers(
    delivererId: string,
  ): Promise<Array<{ customerId: string; orderId: string; deliveryStatut: DeliveryStatut }>> {
    const course = await this.prisma.course.findFirst({
      where: { deliverer_id: delivererId, statut: CourseStatut.IN_DELIVERY },
      select: {
        deliveries: {
          where: { statut: { in: DeliveryTrackingService.NON_TERMINAL } },
          select: {
            statut: true,
            order: { select: { id: true, customer_id: true } },
          },
        },
      },
    });

    return (course?.deliveries ?? [])
      .filter((d) => Boolean(d.order?.customer_id))
      .map((d) => ({
        customerId: d.order.customer_id,
        orderId: d.order.id,
        deliveryStatut: d.statut,
      }));
  }

  // ── 2. Statut de la livraison → client ─────────────────────────────────────

  /**
   * Relaie chaque transition de statut d'une Delivery vers SON client.
   * (Le backoffice reçoit déjà cet event via CourseListenerService ; ici on
   * cible le client concerné, room `customer_{id}`.)
   *
   * L'app cliente s'en sert pour : invalider/rafraîchir le détail commande,
   * afficher "votre livreur est en route / arrivé", basculer ou retirer la carte.
   */
  @OnEvent(CourseChannels.DELIVERY_STATUT_CHANGED)
  async onDeliveryStatutChanged(payload: DeliveryStatutChangedPayload): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: payload.delivery.order_id },
        select: { id: true, customer_id: true },
      });
      if (!order?.customer_id) return;

      this.appGateway.emitToUser(
        order.customer_id,
        'customer',
        CourseChannels.CUSTOMER_DELIVERY_STATUT_CHANGED,
        {
          orderId: order.id,
          statut: payload.new_statut,
          previousStatut: payload.previous_statut,
          courseId: payload.course_id,
          ts: new Date().toISOString(),
        },
      );
    } catch (err) {
      this.logger.warn(
        `Relais statut delivery ${payload.delivery.id} échoué: ${(err as Error).message}`,
      );
    }
  }
}
