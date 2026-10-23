import { Injectable } from '@nestjs/common';
import type { Delivery } from '@prisma/client';

import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { CourseChannels } from '../enums/course-channels';
import type {
  CourseAssignedPayload,
  CourseCancelledPayload,
  CourseCompletedPayload,
  CourseOfferNewPayload,
  CourseStatutChangedPayload,
  DeliveryStatutChangedPayload,
} from '../interfaces/course-event.interface';
import type { OffreExpireePayload } from '../services/offres-cloture.service';

/**
 * Wrapper WebSocket du module course.
 * Responsabilités :
 *  - Push `course:offer:new` uniquement au livreur ciblé (room `deliverer_{id}`)
 *  - Push `course:statut:changed`, `course:completed` à plusieurs rooms
 *    (le livreur, backoffice, restaurant affecté)
 */
@Injectable()
export class CourseWebSocketService {
  constructor(private readonly appGateway: AppGateway) {}

  emitOfferNew(payload: CourseOfferNewPayload) {
    this.appGateway.emitToDeliverer(
      payload.deliverer_id,
      CourseChannels.COURSE_OFFER_NEW,
      {
        offer_id: payload.offer_id,
        course: payload.course,
        expires_at: payload.expires_at,
        is_chain_bonus: payload.is_chain_bonus ?? false,
      },
    );
  }

  emitOfferExpired(payload: OffreExpireePayload) {
    this.appGateway.emitToDeliverer(
      payload.deliverer_id,
      CourseChannels.COURSE_OFFER_EXPIRED,
      payload,
    );
  }

  emitAssigned(payload: CourseAssignedPayload) {
    const { course } = payload;
    if (course.deliverer_id) {
      this.appGateway.emitToDeliverer(course.deliverer_id, CourseChannels.COURSE_ASSIGNED, { course });
    }
    this.appGateway.emitToBackoffice(CourseChannels.COURSE_ASSIGNED, { course });
    this.appGateway.emitToRestaurant(course.restaurant_id, CourseChannels.COURSE_ASSIGNED, { course });
  }

  emitStatutChanged(payload: CourseStatutChangedPayload) {
    const { course } = payload;
    if (course.deliverer_id) {
      this.appGateway.emitToDeliverer(course.deliverer_id, CourseChannels.COURSE_STATUT_CHANGED, payload);
    }
    this.appGateway.emitToBackoffice(CourseChannels.COURSE_STATUT_CHANGED, payload);
    this.appGateway.emitToRestaurant(course.restaurant_id, CourseChannels.COURSE_STATUT_CHANGED, payload);
  }

  /**
   * Suivi d'une offre (proposée, refusée, expirée, close) : écran Opérations
   * du siège et caisse du restaurant mis à jour en direct. `course:statut:changed`
   * (qu'ils écoutent déjà) avec la raison de l'offre, au siège et au
   * restaurant SEULEMENT : le livreur a ses propres événements d'offre.
   */
  emitSuiviOffre(payload: CourseStatutChangedPayload) {
    this.appGateway.emitToBackoffice(CourseChannels.COURSE_STATUT_CHANGED, payload);
    this.appGateway.emitToRestaurant(payload.course.restaurant_id, CourseChannels.COURSE_STATUT_CHANGED, payload);
  }

  emitDeliveryStatutChanged(payload: DeliveryStatutChangedPayload) {
    // Destinataires : backoffice + restaurant (le livreur s'en sert déjà via son action)
    this.appGateway.emitToBackoffice(CourseChannels.DELIVERY_STATUT_CHANGED, payload);
    // Salle du restaurant (écran Opérations d'un compte restaurant) : jamais
    // le code du client, comme les courses diffusées au restaurant.
    if (payload.restaurant_id) {
      const { delivery_pin: _code, ...delivery } = (payload.delivery ?? {}) as Delivery;
      this.appGateway.emitToRestaurant(payload.restaurant_id, CourseChannels.DELIVERY_STATUT_CHANGED, { ...payload, delivery });
    }
  }

  emitCompleted(payload: CourseCompletedPayload) {
    const { course } = payload;
    if (course.deliverer_id) {
      this.appGateway.emitToDeliverer(course.deliverer_id, CourseChannels.COURSE_COMPLETED, payload);
    }
    this.appGateway.emitToBackoffice(CourseChannels.COURSE_COMPLETED, payload);
    this.appGateway.emitToRestaurant(course.restaurant_id, CourseChannels.COURSE_COMPLETED, payload);
  }

  emitCancelled(payload: CourseCancelledPayload) {
    const { course } = payload;
    if (course.deliverer_id) {
      this.appGateway.emitToDeliverer(course.deliverer_id, CourseChannels.COURSE_CANCELLED, payload);
    }
    this.appGateway.emitToBackoffice(CourseChannels.COURSE_CANCELLED, payload);
    this.appGateway.emitToRestaurant(course.restaurant_id, CourseChannels.COURSE_CANCELLED, payload);
  }
}
