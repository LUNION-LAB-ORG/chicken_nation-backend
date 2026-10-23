import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CourseStatut, Delivery, DeliveryStatut } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import type { DelivererLocationUpdatedPayload } from 'src/modules/deliverers/events/deliverer.event';

import { CourseEvent } from '../events/course.event';
import { estArrive, RAYON_ARRIVEE_CLIENT_M, RAYON_ARRIVEE_RESTAURANT_M } from '../helpers/arrivee-auto.rules';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { parseOrderLatLng } from '../helpers/geo.helper';
import { DispatchJournalService } from './dispatch-journal.service';

/**
 * ARRIVÉES DÉDUITES DES POSITIONS REÇUES (demande du 23/10, livreurs qui
 * lisent peu : le serveur déduit au lieu de demander).
 *
 * À chaque position du livreur (`deliverer:location:updated`, envoyée aussi
 * appli en arrière-plan) :
 *  - course ACCEPTÉE et livreur à 200 m du restaurant : course « au
 *    restaurant », comme `PATCH /courses/deliverer/:id/at-restaurant` ;
 *  - livraison EN ROUTE et livreur à 100 m de l'adresse du client :
 *    livraison « arrivée », comme `PATCH /courses/deliverer/deliveries/:id/arrived`.
 *
 * Mêmes événements que les routes du livreur (backoffice, caisse, client,
 * planificateur). Écritures CONDITIONNELLES : si l'appli déclare l'arrivée
 * au même instant, un seul des deux passe, l'autre ne fait rien (et les
 * routes du livreur répondent sans erreur à une arrivée déjà enregistrée).
 *
 * Planificateur v2 seulement : un restaurant repassé en v1
 * (`course.planificateur`) retrouve exactement le comportement d'avant, où
 * seule l'appli déclare ces arrivées.
 *
 * N'échoue jamais : le flux des positions ne doit pas être gêné.
 */
@Injectable()
export class ArriveeAutoService {
  private readonly logger = new Logger(ArriveeAutoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseEvent: CourseEvent,
    private readonly journal: DispatchJournalService,
    private readonly settings: CourseSettingsHelper,
  ) {}

  /** Restaurant en v2 ? Lu seulement quand une arrivée est sur le point d'être déclarée. */
  private async enV2(restaurantId: string): Promise<boolean> {
    return (await this.settings.versionPour(restaurantId).catch(() => 'v2' as const)) === 'v2';
  }

  @OnEvent(DelivererChannels.DELIVERER_LOCATION_UPDATED)
  async onPosition(payload: DelivererLocationUpdatedPayload): Promise<void> {
    if (!payload?.delivererId) return;
    try {
      await this.surPosition(payload);
    } catch (err) {
      this.logger.warn(`Arrivée automatique non évaluée : ${(err as Error)?.message ?? err}`);
    }
  }

  /** @returns ce qui a été déclaré (pour les tests), sinon `null`. */
  async surPosition(
    payload: Pick<DelivererLocationUpdatedPayload, 'delivererId' | 'lat' | 'lng' | 'accuracyM'>,
    maintenant = new Date(),
  ): Promise<'RESTAURANT' | 'CLIENT' | null> {
    const position = { lat: payload.lat, lng: payload.lng };
    const course = await this.prisma.course.findFirst({
      where: {
        deliverer_id: payload.delivererId,
        statut: { in: [CourseStatut.ACCEPTED, CourseStatut.IN_DELIVERY] },
      },
      orderBy: { assigned_at: 'desc' },
      select: {
        id: true,
        reference: true,
        statut: true,
        restaurant_id: true,
        restaurant: { select: { latitude: true, longitude: true } },
        deliveries: {
          where: { statut: DeliveryStatut.IN_ROUTE },
          orderBy: { sequence_order: 'asc' },
          take: 1,
          select: { id: true, order_id: true, order: { select: { reference: true, address: true } } },
        },
      },
    });
    if (!course) return null;

    if (course.statut === CourseStatut.ACCEPTED) {
      const restaurant = { lat: course.restaurant?.latitude ?? undefined, lng: course.restaurant?.longitude ?? undefined };
      if (!estArrive({ position, precisionM: payload.accuracyM, cible: restaurant, rayonM: RAYON_ARRIVEE_RESTAURANT_M })) {
        return null;
      }
      if (!(await this.enV2(course.restaurant_id))) return null;
      const { count } = await this.prisma.course.updateMany({
        where: { id: course.id, deliverer_id: payload.delivererId, statut: CourseStatut.ACCEPTED },
        data: { statut: CourseStatut.AT_RESTAURANT, at_restaurant_at: maintenant },
      });
      if (count !== 1) return null;
      await this.journal.ecrire({
        type: 'ARRIVEE_RESTAURANT_AUTO',
        source: 'serveur',
        restaurant_id: course.restaurant_id,
        course_id: course.id,
        deliverer_id: payload.delivererId,
        details: { course: course.reference, precision_m: payload.accuracyM ?? null },
      });
      const detaillee = await this.prisma.course.findUnique({ where: { id: course.id }, include: COURSE_FULL_INCLUDE });
      if (detaillee) {
        await this.courseEvent.courseStatutChanged({
          course: detaillee,
          previous_statut: CourseStatut.ACCEPTED,
          new_statut: CourseStatut.AT_RESTAURANT,
        });
      }
      return 'RESTAURANT';
    }

    const livraison = course.deliveries[0];
    if (!livraison) return null;
    const client = parseOrderLatLng(livraison.order.address);
    if (!estArrive({ position, precisionM: payload.accuracyM, cible: client, rayonM: RAYON_ARRIVEE_CLIENT_M })) {
      return null;
    }
    if (!(await this.enV2(course.restaurant_id))) return null;
    const { count } = await this.prisma.delivery.updateMany({
      where: {
        id: livraison.id,
        statut: DeliveryStatut.IN_ROUTE,
        course: { statut: CourseStatut.IN_DELIVERY, deliverer_id: payload.delivererId },
      },
      data: { statut: DeliveryStatut.ARRIVED, arrived_at: maintenant },
    });
    if (count !== 1) return null;
    await this.journal.ecrire({
      type: 'ARRIVEE_CLIENT_AUTO',
      source: 'serveur',
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: payload.delivererId,
      order_id: livraison.order_id,
      details: { commande: livraison.order.reference, precision_m: payload.accuracyM ?? null },
    });
    // Le livreur ne lit jamais le code du client (comme la route du livreur).
    const arrivee = await this.prisma.delivery.findUnique({ where: { id: livraison.id }, omit: { delivery_pin: true } });
    if (arrivee) {
      await this.courseEvent.deliveryStatutChanged({
        delivery: arrivee as unknown as Delivery,
        course_id: course.id,
        course_reference: course.reference,
        restaurant_id: course.restaurant_id,
        previous_statut: DeliveryStatut.IN_ROUTE,
        new_statut: DeliveryStatut.ARRIVED,
      });
    }
    return 'CLIENT';
  }
}
