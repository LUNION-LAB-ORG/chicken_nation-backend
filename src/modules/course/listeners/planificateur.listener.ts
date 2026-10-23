import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DeliveryService, OrderStatus, OrderType } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import type {
  DelivererLocationUpdatedPayload,
  DelivererQueueChangedPayload,
} from 'src/modules/deliverers/events/deliverer.event';
import { OrderChannels } from 'src/modules/order/enums/order-channels';
import type { OrderCreatedEvent } from 'src/modules/order/interfaces/order-event.interface';
import { EVENEMENT_LIVREUR_CONNECTE } from 'src/socket-io/utils/evenements-connexion.util';

import { CourseChannels } from '../enums/course-channels';
import { DemandePlanification, DispatchEvenements } from '../enums/dispatch-evenements';
import { estRaisonDuPlanificateur } from '../helpers/application-plan.rules';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import type {
  CourseAssignedPayload,
  CourseCancelledPayload,
  CourseCompletedPayload,
  CourseStatutChangedPayload,
  DeliveryStatutChangedPayload,
} from '../interfaces/course-event.interface';
import { CoursePlanificateurService } from '../services/course-planificateur.service';
import { DepartCourseService } from '../services/depart-course.service';
import { EstimationPreparationService } from '../services/estimation-preparation.service';
import type { OffreExpireePayload } from '../services/offres-cloture.service';

/** Statuts d'une commande qui changent la donne du planificateur. */
const STATUTS_COMMANDE_UTILES: OrderStatus[] = [OrderStatus.READY, OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED];

/**
 * DÉCLENCHEMENT DU PLANIFICATEUR v2 par les événements (conception 3.12) :
 * chaque événement demande un passage pour le restaurant concerné ; les
 * demandes sont regroupées par restaurant pendant 500 ms
 * (`CoursePlanificateurService.demander`).
 *
 *  - commande à livrer prête, en préparation, annulée ;
 *  - course créée (via la recherche d'un livreur), acceptée, refusée,
 *    expirée ou close, au restaurant, retrait validé, partie, annulée,
 *    terminée (le livreur se libère : zéro temps mort) ;
 *  - livreur disponible, en pause, reprise (file d'attente), appli connectée ;
 *  - livraison démarrée ou arrivée (départ du restaurant) ;
 *  - position d'un livreur dont la course récupérée n'est pas encore partie
 *    (sortie du rayon de départ : départ enregistré aussitôt).
 *
 * Les `course:statut:changed` émis par le planificateur lui-même (raisons
 * `RaisonsPlanificateur`) sont ignorés : un passage n'en déclenche pas un
 * autre pour rien. En v1, le passage ne fait rien tant qu'il ne reste rien
 * de v2. N'échoue jamais : une erreur est journalisée et avalée.
 */
@Injectable()
export class PlanificateurListener {
  private readonly logger = new Logger(PlanificateurListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly planificateur: CoursePlanificateurService,
    private readonly settings: CourseSettingsHelper,
    private readonly preparation: EstimationPreparationService,
    private readonly depart: DepartCourseService,
  ) {}

  @OnEvent(DispatchEvenements.PLANIFIER_RESTAURANT)
  onDemande(payload: DemandePlanification) {
    this.planificateur.demander(payload?.restaurant_id, payload?.raison ?? 'DEMANDE');
  }

  @OnEvent(OrderChannels.ORDER_STATUS_UPDATED)
  async onCommande(payload: OrderCreatedEvent) {
    const order = payload?.order;
    if (!order || order.type !== OrderType.DELIVERY || !STATUTS_COMMANDE_UTILES.includes(order.status)) return;
    if (order.delivery_service !== DeliveryService.CHICKEN_NATION) return;
    this.planificateur.demander(order.restaurant_id, `COMMANDE_${order.status}`);

    // Commande prête : l'estimation qu'on en avait est comparée à la réalité (journal).
    if (order.status === OrderStatus.READY && order.prepared_at) {
      try {
        if ((await this.settings.versionPour(order.restaurant_id)) !== 'v2') return;
        const { preparation } = await this.settings.lirePlanification();
        await this.preparation.mesurer(
          {
            id: order.id,
            reference: order.reference,
            restaurant_id: order.restaurant_id,
            prepared_at: order.prepared_at,
            ready_at: order.ready_at,
            estimated_preparation_time: order.estimated_preparation_time,
          },
          preparation.reglages,
        );
      } catch (err) {
        this.logger.warn(`Mesure de la préparation de ${order.reference} impossible : ${(err as Error)?.message}`);
      }
    }
  }

  @OnEvent(CourseChannels.COURSE_ASSIGNED)
  onAcceptee(payload: CourseAssignedPayload) {
    this.planificateur.demander(payload?.course?.restaurant_id, 'COURSE_ACCEPTEE');
  }

  @OnEvent(CourseChannels.COURSE_STATUT_CHANGED)
  onStatut(payload: CourseStatutChangedPayload) {
    if (!payload?.course || estRaisonDuPlanificateur(payload.reason)) return;
    this.planificateur.demander(payload.course.restaurant_id, `COURSE_${payload.new_statut}`);
  }

  @OnEvent(CourseChannels.COURSE_CANCELLED)
  onAnnulee(payload: CourseCancelledPayload) {
    this.planificateur.demander(payload?.course?.restaurant_id, 'COURSE_ANNULEE');
  }

  @OnEvent(CourseChannels.COURSE_COMPLETED)
  onTerminee(payload: CourseCompletedPayload) {
    this.planificateur.demander(payload?.course?.restaurant_id, 'LIVREUR_LIBRE');
  }

  @OnEvent(CourseChannels.COURSE_OFFER_REFUSED)
  async onRefusee(payload: { course_id: string }) {
    await this.demanderPourCourse(payload?.course_id, 'OFFRE_REFUSEE');
  }

  @OnEvent(CourseChannels.COURSE_OFFER_EXPIRED)
  async onExpiree(payload: OffreExpireePayload) {
    await this.demanderPourCourse(payload?.course_id, payload?.motif === 'EXPIREE' ? 'OFFRE_EXPIREE' : 'OFFRE_CLOSE');
  }

  @OnEvent(CourseChannels.DELIVERY_STATUT_CHANGED)
  async onLivraison(payload: DeliveryStatutChangedPayload) {
    await this.demanderPourCourse(payload?.course_id, `LIVRAISON_${payload?.new_statut}`);
  }

  /** Pause, reprise, disponible, indisponible. */
  @OnEvent(DelivererChannels.DELIVERER_QUEUE_CHANGED)
  onFile(payload: DelivererQueueChangedPayload) {
    this.planificateur.demander(payload?.restaurantId, 'LIVREUR_FILE');
  }

  @OnEvent(EVENEMENT_LIVREUR_CONNECTE)
  async onConnecte(payload: { delivererId: string }) {
    try {
      const livreur = await this.prisma.deliverer.findUnique({
        where: { id: payload.delivererId },
        select: { restaurant_id: true },
      });
      this.planificateur.demander(livreur?.restaurant_id, 'LIVREUR_CONNECTE');
    } catch (err) {
      this.logger.warn(`Livreur connecté : passage non demandé (${(err as Error)?.message})`);
    }
  }

  /**
   * Position d'un livreur : utile seulement si sa course récupérée n'est pas
   * encore partie. Reçue hors du rayon de départ après le retrait : départ
   * enregistré tout de suite (le livreur n'a rien à toucher). Sinon le
   * passage décide (fenêtre écoulée).
   */
  @OnEvent(DelivererChannels.DELIVERER_LOCATION_UPDATED)
  async onPosition(payload: DelivererLocationUpdatedPayload) {
    if (!payload?.delivererId) return;
    try {
      const course = await this.depart.surPosition(payload);
      if (course) this.planificateur.demander(course.restaurant_id, course.parti ? 'DEPART_POSITION' : 'POSITION');
    } catch (err) {
      this.logger.warn(`Position du livreur : passage non demandé (${(err as Error)?.message})`);
    }
  }

  private async demanderPourCourse(courseId: string | null | undefined, raison: string) {
    if (!courseId) return;
    try {
      const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { restaurant_id: true } });
      this.planificateur.demander(course?.restaurant_id, raison);
    } catch (err) {
      this.logger.warn(`Passage non demandé (${raison}) : ${(err as Error)?.message}`);
    }
  }
}
