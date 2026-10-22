import { Injectable, Logger } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';

import { CourseEvent } from '../events/course.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { STATUTS_COURSE_AVANT_DEPART, STATUTS_LIVRAISON_TERMINEE } from '../helpers/remise-course.rules';
import { CourseActionService } from './course-action.service';
import { DispatchJournalService, SourceDispatch } from './dispatch-journal.service';

/** La course n'est plus acceptée ni au restaurant : un autre chemin l'a déjà fait partir. */
class CourseDejaPartie extends Error {}

export interface ResultatPassageEnLivraison {
  /** Vrai si CET appel a fait partir la course (un seul gagnant, même à deux serveurs). */
  passee: boolean;
  statut_avant?: CourseStatut;
  /** Livraisons détachées (commandes encore au restaurant), à relancer. */
  detachees: string[];
}

/**
 * DÉPART D'UNE COURSE INTERNE PAR UN AUTRE CHEMIN QUE LE CODE DE RETRAIT.
 *
 * Le bouton « Livreur a récupéré » de la caisse Sunmi (et du backoffice) fait
 * passer UNE commande PICKED_UP par `PATCH /orders/:id/status`, sans toucher
 * la course. Celle-ci restait acceptée ou « au restaurant », et la tâche
 * d'annulation automatique l'annulait au bout de 30 min, commandes des
 * clients comprises.
 *
 * Désormais la remise d'une commande d'une course interne acceptée fait
 * partir la course EN LIVRAISON, avec les effets de la validation par code
 * (`CourseActionService.validatePickupByCashier`) : heure de retrait (et
 * d'arrivée au restaurant si le GPS ne l'a pas vue), `course:statut:changed`
 * au livreur, au backoffice et au restaurant, notification « tu peux
 * partir », estimation de la tournée. Les autres commandes de la course
 * restent telles quelles : chacune est remise par le même bouton.
 *
 * Écriture CONDITIONNÉE au statut (acceptée ou au restaurant) : si la
 * caissière valide le code au même moment, un seul des deux chemins fait
 * partir la course, l'autre ne fait rien (bouton) ou reçoit 409 (code).
 */
@Injectable()
export class CourseEnLivraisonService {
  private readonly logger = new Logger(CourseEnLivraisonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseEvent: CourseEvent,
    private readonly pushService: DelivererPushService,
    private readonly actions: CourseActionService,
    private readonly journal: DispatchJournalService,
  ) {}

  /**
   * Fait partir en livraison une course interne acceptée par un livreur
   * (ACCEPTED ou AT_RESTAURANT, pas chez Turbo).
   *
   * @param options.detacherCommandesAuRestaurant  Dans la même transaction,
   *   détache les livraisons dont la commande est encore READY (annulation
   *   automatique : elles repartent dans une nouvelle course).
   */
  async passerEnLivraison(
    courseId: string,
    options: { detacherCommandesAuRestaurant?: boolean; maintenant?: Date } = {},
  ): Promise<ResultatPassageEnLivraison> {
    const maintenant = options.maintenant ?? new Date();
    const avant = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { statut: true, deliverer_id: true, turbo_escalated_at: true },
    });
    if (
      !avant ||
      !avant.deliverer_id ||
      avant.turbo_escalated_at ||
      !STATUTS_COURSE_AVANT_DEPART.includes(avant.statut)
    ) {
      return { passee: false, detachees: [] };
    }

    let detachees: string[] = [];
    try {
      await this.prisma.$transaction(async (tx) => {
        const partie = await tx.course.updateMany({
          where: {
            id: courseId,
            statut: { in: STATUTS_COURSE_AVANT_DEPART },
            turbo_escalated_at: null,
            deliverer_id: { not: null },
          },
          data: { statut: CourseStatut.IN_DELIVERY, picked_up_at: maintenant },
        });
        if (partie.count !== 1) throw new CourseDejaPartie();

        // Comme la validation par code : arrivée au restaurant tracée si le GPS ne l'a pas vue.
        await tx.course.updateMany({
          where: { id: courseId, at_restaurant_at: null },
          data: { at_restaurant_at: maintenant },
        });

        if (options.detacherCommandesAuRestaurant) {
          const aDetacher = await tx.delivery.findMany({
            where: {
              course_id: courseId,
              statut: { notIn: STATUTS_LIVRAISON_TERMINEE },
              order: { status: OrderStatus.READY },
            },
            select: { id: true },
          });
          detachees = aDetacher.map((d) => d.id);
          if (detachees.length > 0) {
            await tx.delivery.updateMany({
              where: { id: { in: detachees }, statut: { notIn: STATUTS_LIVRAISON_TERMINEE } },
              data: { statut: DeliveryStatut.CANCELLED },
            });
          }
        }
      });
    } catch (err) {
      if (err instanceof CourseDejaPartie) return { passee: false, detachees: [] };
      throw err;
    }

    // Mêmes effets que la validation par code.
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: COURSE_FULL_INCLUDE,
    });
    if (course) {
      await this.courseEvent.courseStatutChanged({
        course,
        previous_statut: avant.statut,
        new_statut: CourseStatut.IN_DELIVERY,
      });
      this.pushService.notifyPickupValidated({
        delivererId: avant.deliverer_id,
        courseReference: course.reference,
        courseId,
      });
    }
    void this.actions.estimerDureeTournee(courseId).catch(() => undefined);

    return { passee: true, statut_avant: avant.statut, detachees };
  }

  /**
   * Une commande vient de passer PICKED_UP hors du code de retrait (bouton
   * « Livreur a récupéré »). Course interne acceptée : elle part en livraison.
   * Course Turbo : rien (ses webhooks la font avancer). Course encore sans
   * livreur : rien ne change, l'anomalie est journalisée.
   *
   * @returns vrai si la course est partie en livraison.
   */
  async surCommandeRemise(
    commande: { id: string; reference?: string | null },
    source: SourceDispatch = 'caisse',
  ): Promise<boolean> {
    const livraison = await this.prisma.delivery.findUnique({
      where: { order_id: commande.id },
      select: {
        course: {
          select: {
            id: true,
            reference: true,
            restaurant_id: true,
            statut: true,
            deliverer_id: true,
            turbo_escalated_at: true,
          },
        },
      },
    });
    const course = livraison?.course;
    if (!course || course.turbo_escalated_at) return false;

    if (course.statut === CourseStatut.PENDING_ASSIGNMENT) {
      this.logger.warn(
        `Commande ${commande.reference ?? commande.id} remise alors que la course ${course.reference} cherche encore un livreur : course inchangée.`,
      );
      await this.journal.ecrire({
        type: 'REMISE_CAISSE_SANS_LIVREUR',
        source,
        restaurant_id: course.restaurant_id,
        course_id: course.id,
        order_id: commande.id,
        details: { course: course.reference, commande: commande.reference ?? null },
      });
      return false;
    }
    if (!STATUTS_COURSE_AVANT_DEPART.includes(course.statut)) return false; // déjà partie ou terminée

    const resultat = await this.passerEnLivraison(course.id);
    if (!resultat.passee) return false;

    await this.journal.ecrire({
      type: 'COURSE_EN_LIVRAISON_PAR_CAISSE',
      source,
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer_id,
      order_id: commande.id,
      details: {
        course: course.reference,
        commande: commande.reference ?? null,
        statut_avant: resultat.statut_avant,
      },
    });
    this.logger.log(
      `Course ${course.reference} partie en livraison : commande ${commande.reference ?? commande.id} remise au livreur (bouton « Livreur a récupéré »).`,
    );
    return true;
  }
}
