import { Injectable, Logger, Optional } from '@nestjs/common';
import { CourseOfferStatus, CourseStatut, DeliveryStatut, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { ComptePersonnel } from 'src/modules/users/helpers/personnel-scope.helper';

import { CourseEvent } from '../events/course.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import {
  MOTIF_COURSE_ANCIENNE,
  fermetureDeCourseAncienne,
  messageFermetureAnciennes,
} from '../helpers/courses-anciennes.rules';
import { journeeDeService } from '../helpers/journee-service.rules';
import { STATUTS_LIVRAISON_TERMINEE } from '../helpers/remise-course.rules';
import { STATUTS_COURSE_NON_TERMINEE } from '../helpers/tableau-livraison.rules';
import { TableauLivraisonService } from './tableau-livraison.service';

/** Réponse de `POST /courses/anciennes/fermer`. */
export interface ReponseFermetureAnciennes {
  fermees: number;
  gardees: number;
  message: string;
}

/**
 * « Fermer les courses des jours passés » (demande du 10/11), réservé à
 * l'administrateur : règles dans `courses-anciennes.rules.ts`.
 *
 * Une seule écriture pour toutes les courses (il peut y en avoir des
 * centaines chez Turbo) : livraisons, courses, offres en attente, journal.
 * Ensuite, seuls les livreurs encore rattachés à l'une d'elles sont prévenus
 * par le temps réel (leur appli la retire, les écrans se mettent à jour) :
 * aucune notification sur le téléphone pour une course de la semaine passée,
 * et aucune remise en file (le livreur se remet disponible lui-même).
 */
@Injectable()
export class CoursesAnciennesService {
  private readonly logger = new Logger('Dispatch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseEvent: CourseEvent,
    // Le tableau gardé 10 s est oublié : la ligne disparaît dès la relecture.
    @Optional() private readonly tableau?: TableauLivraisonService,
  ) {}

  async fermer(
    restaurantId: string | undefined,
    compte: ComptePersonnel | undefined,
    maintenant: Date = new Date(),
  ): Promise<ReponseFermetureAnciennes> {
    const journee = journeeDeService(maintenant);
    const encoreOuvertes: Prisma.CourseWhereInput = {
      statut: { in: STATUTS_COURSE_NON_TERMINEE },
      created_at: { lt: journee.debut },
    };
    const lues = await this.prisma.course.findMany({
      where: { ...encoreOuvertes, ...(restaurantId ? { restaurant_id: restaurantId } : {}) },
      select: {
        id: true,
        reference: true,
        restaurant_id: true,
        deliverer_id: true,
        deliveries: {
          select: { id: true, statut: true, order: { select: { status: true, entity_status: true } } },
        },
      },
    });

    const parId = new Map(lues.map((c) => [c.id, c]));
    const fermetures = lues
      .map((c) => fermetureDeCourseAncienne(c))
      .filter((f): f is NonNullable<typeof f> => f !== null);
    const gardees = lues.length - fermetures.length;
    if (fermetures.length === 0) {
      return { fermees: 0, gardees, message: messageFermetureAnciennes(0, gardees) };
    }

    const terminees = fermetures.filter((f) => f.statut === CourseStatut.COMPLETED).map((f) => f.course_id);
    const annulees = fermetures.filter((f) => f.statut === CourseStatut.CANCELLED).map((f) => f.course_id);
    const toutes = fermetures.map((f) => f.course_id);

    await this.prisma.$transaction(
      async (tx) => {
        const pasTerminee = { notIn: STATUTS_LIVRAISON_TERMINEE };
        await tx.delivery.updateMany({
          where: { id: { in: fermetures.flatMap((f) => f.livrees) }, statut: pasTerminee },
          data: { statut: DeliveryStatut.DELIVERED },
        });
        await tx.delivery.updateMany({
          where: { id: { in: fermetures.flatMap((f) => f.annulees) }, statut: pasTerminee },
          data: { statut: DeliveryStatut.CANCELLED },
        });
        if (terminees.length > 0) {
          await tx.course.updateMany({
            where: { id: { in: terminees }, ...encoreOuvertes },
            data: { statut: CourseStatut.COMPLETED, completed_at: maintenant },
          });
        }
        if (annulees.length > 0) {
          await tx.course.updateMany({
            where: { id: { in: annulees }, ...encoreOuvertes },
            data: {
              statut: CourseStatut.CANCELLED,
              cancelled_at: maintenant,
              cancelled_by: 'admin',
              cancelled_reason: MOTIF_COURSE_ANCIENNE,
            },
          });
        }
        await tx.courseOfferAttempt.updateMany({
          where: { course_id: { in: toutes }, status: CourseOfferStatus.PENDING },
          data: { status: CourseOfferStatus.CANCELLED, responded_at: maintenant },
        });
        await tx.dispatchEvenement.createMany({
          data: fermetures.map((f) => {
            const c = parId.get(f.course_id)!;
            return {
              type: 'COURSE_ANCIENNE_FERMEE',
              motif: f.statut,
              source: 'admin',
              restaurant_id: c.restaurant_id,
              course_id: c.id,
              deliverer_id: c.deliverer_id,
              details: {
                course: c.reference,
                livrees: f.livrees.length,
                annulees: f.annulees.length,
                par: { id: compte?.id ?? null, role: compte?.role ?? null },
              },
            };
          }),
        });
      },
      { timeout: 30_000 },
    );

    this.tableau?.oublier();
    this.logger.log(
      JSON.stringify({
        type: 'COURSES_ANCIENNES_FERMEES',
        restaurant_id: restaurantId ?? null,
        fermees: fermetures.length,
        gardees,
        par: { id: compte?.id ?? null, role: compte?.role ?? null },
      }),
    );
    await this.annoncerAuxLivreurs(fermetures.filter((f) => parId.get(f.course_id)?.deliverer_id).map((f) => f.course_id));
    return { fermees: fermetures.length, gardees, message: messageFermetureAnciennes(fermetures.length, gardees) };
  }

  /** Livreurs encore rattachés : temps réel seulement. Ne lève jamais, la fermeture est écrite. */
  private async annoncerAuxLivreurs(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const courses = await this.prisma.course.findMany({ where: { id: { in: ids } }, include: COURSE_FULL_INCLUDE });
      for (const course of courses) {
        if (course.statut === CourseStatut.COMPLETED) {
          const livrees = course.deliveries.filter((d) => d.statut === DeliveryStatut.DELIVERED).length;
          await this.courseEvent.courseCompleted({
            course,
            success_count: livrees,
            fail_count: course.deliveries.length - livrees,
          });
        } else if (course.statut === CourseStatut.CANCELLED) {
          await this.courseEvent.courseCancelled({ course, cancelled_by: 'admin', reason: MOTIF_COURSE_ANCIENNE });
        }
      }
    } catch (err) {
      this.logger.warn(`Courses des jours passés fermées : annonce en échec (${(err as Error)?.message ?? err})`);
    }
  }
}
