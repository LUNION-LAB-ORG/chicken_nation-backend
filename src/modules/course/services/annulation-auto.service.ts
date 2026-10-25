import { Injectable, Logger } from '@nestjs/common';
import { CourseStatut, DeliveryStatut } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';

import { CourseEvent } from '../events/course.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { recalculerFraisCourse } from '../helpers/frais-course';
import {
  STATUTS_COURSE_AVANT_DEPART,
  STATUTS_LIVRAISON_TERMINEE,
  issueAnnulationAuto,
  trierCommandesAnnulationAuto,
} from '../helpers/remise-course.rules';
import { CourseEnLivraisonService } from './course-en-livraison.service';
import { CourseOfferService } from './course-offer.service';
import { DispatchJournalService } from './dispatch-journal.service';

/** La course a changé entre la lecture et l'écriture : rien n'est fait. */
class CourseDejaChangee extends Error {}

export interface ResultatAnnulationAuto {
  /** `EN_LIVRAISON` : partie avec les commandes remises ; `ANNULEE` : annulée, sans ses commandes. */
  issue: 'EN_LIVRAISON' | 'ANNULEE';
  commandes_remises: string[];
  commandes_relancees: string[];
  /** Nouvelle course des commandes encore au restaurant. */
  nouvelle_course_id: string | null;
}

/**
 * ANNULATION AUTOMATIQUE d'une course bloquée (tâche `autoCancelStuckCourses` :
 * acceptée sans livreur arrivé, ou au restaurant sans retrait validé, depuis
 * trop longtemps), SANS JAMAIS annuler une commande de client. Principe du
 * projet : « une commande ne s'annule que manuellement ».
 *
 *  - commandes déjà remises (PICKED_UP et au-delà) : elles restent telles
 *    quelles et la course part EN LIVRAISON au lieu d'être annulée (cas du
 *    bouton « Livreur a récupéré » utilisé avant son raccordement à la course) ;
 *  - rien de remis : la course est annulée (`cancelled_by` = `system`), ses
 *    livraisons aussi, ses commandes NON ;
 *  - commandes encore au restaurant (READY) : détachées puis remises en
 *    recherche de livreur dans une NOUVELLE course, à référence neuve, par le
 *    mécanisme de relance du backoffice (`PATCH /courses/:id/relancer`,
 *    réservation atomique).
 *
 * Journal `ANNULATION_AUTO_COMMANDES_GARDEES`. L'annulation MANUELLE
 * (administration, livreur) passe par `cancelCourse` : elle n'annule pas non
 * plus les commandes et relance celles qui ne sont pas livrées.
 */
@Injectable()
export class AnnulationAutoService {
  private readonly logger = new Logger(AnnulationAutoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseEvent: CourseEvent,
    private readonly pushService: DelivererPushService,
    private readonly enLivraison: CourseEnLivraisonService,
    private readonly offres: CourseOfferService,
    private readonly journal: DispatchJournalService,
  ) {}

  /** @returns ce qui a été fait, ou null si la course a changé entre-temps (rien n'est fait). */
  async annulerAutomatiquement(
    courseId: string,
    raison: string,
    maintenant = new Date(),
  ): Promise<ResultatAnnulationAuto | null> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        reference: true,
        restaurant_id: true,
        statut: true,
        deliverer_id: true,
        turbo_escalated_at: true,
        deliveries: {
          select: { id: true, statut: true, order: { select: { id: true, reference: true, status: true } } },
        },
      },
    });
    if (!course || course.turbo_escalated_at || !STATUTS_COURSE_AVANT_DEPART.includes(course.statut)) {
      return null;
    }

    const tri = trierCommandesAnnulationAuto(course.deliveries);
    const issue = issueAnnulationAuto(tri);

    if (issue === 'EN_LIVRAISON') {
      const depart = await this.enLivraison.passerEnLivraison(course.id, {
        detacherCommandesAuRestaurant: true,
        maintenant,
      });
      if (!depart.passee) return null;
    } else if (!(await this.annulerSansLesCommandes(course.id, raison, maintenant))) {
      return null;
    }

    // Commandes encore au restaurant : nouvelle course, nouvelle référence.
    let nouvelleCourseId: string | null = null;
    let messageRelance: string | null = null;
    if (tri.auRestaurant.length > 0) {
      try {
        const relance = await this.offres.relancerCourseAnnulee(course.id);
        nouvelleCourseId = relance.newCourseId ?? null;
        messageRelance = relance.message;
      } catch (err) {
        messageRelance = (err as Error)?.message ?? 'erreur';
        this.logger.error(
          `Relance des commandes de la course ${course.reference} impossible : ${messageRelance}`,
        );
      }
      // Les livraisons relancées ont quitté la course : ses frais suivent.
      await recalculerFraisCourse(this.prisma, course.id).catch(() => undefined);
    }

    const resultat: ResultatAnnulationAuto = {
      issue,
      commandes_remises: tri.remises.map((l) => l.order.reference),
      commandes_relancees: tri.auRestaurant.map((l) => l.order.reference),
      nouvelle_course_id: nouvelleCourseId,
    };
    await this.journal.ecrire({
      type: 'ANNULATION_AUTO_COMMANDES_GARDEES',
      motif: issue,
      source: 'serveur',
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer_id,
      details: {
        course: course.reference,
        raison,
        statut_avant: course.statut,
        ...resultat,
        relance: messageRelance,
      },
    });
    this.logger.warn(
      `Course ${course.reference} bloquée en ${course.statut} : ${
        issue === 'EN_LIVRAISON' ? 'partie en livraison' : 'annulée'
      }, aucune commande annulée (${resultat.commandes_remises.length} remise(s), ${resultat.commandes_relancees.length} relancée(s)).`,
    );
    return resultat;
  }

  /**
   * Annule la course et ses livraisons, jamais ses commandes. Écriture
   * conditionnée au statut lu (acceptée ou au restaurant, pas chez Turbo) :
   * un retrait validé au même instant l'emporte.
   */
  private async annulerSansLesCommandes(courseId: string, raison: string, maintenant: Date): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const annulee = await tx.course.updateMany({
          where: { id: courseId, statut: { in: STATUTS_COURSE_AVANT_DEPART }, turbo_escalated_at: null },
          data: {
            statut: CourseStatut.CANCELLED,
            cancelled_at: maintenant,
            cancelled_by: 'system',
            cancelled_reason: raison,
          },
        });
        if (annulee.count !== 1) throw new CourseDejaChangee();
        await tx.delivery.updateMany({
          where: { course_id: courseId, statut: { notIn: STATUTS_LIVRAISON_TERMINEE } },
          data: { statut: DeliveryStatut.CANCELLED },
        });
      });
    } catch (err) {
      if (err instanceof CourseDejaChangee) return false;
      throw err;
    }

    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: COURSE_FULL_INCLUDE,
    });
    if (!course) return true;
    // Socket (livreur, backoffice, restaurant) ; DispatchListener clôt les
    // offres et remet le livreur dans la file.
    await this.courseEvent.courseCancelled({ course, cancelled_by: 'system', reason: raison });
    if (course.deliverer_id) {
      this.pushService.notifyCourseCancelled({
        delivererId: course.deliverer_id,
        courseReference: course.reference,
        cancelledBy: 'le système',
        courseId: course.id,
      });
    }
    return true;
  }
}
