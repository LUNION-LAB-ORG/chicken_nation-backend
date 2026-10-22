import { Injectable } from '@nestjs/common';
import { CourseOfferStatus, CourseStatut } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import type { CourseWithDetails } from '../interfaces/course-event.interface';

/** Même forme que l'événement socket `course:offer:new` : l'appli l'affiche telle quelle. */
export interface OffreEnAttente {
  /** Identifiant de la COURSE (même simplification que `course:offer:new`). */
  offer_id: string;
  course: CourseWithDetails;
  expires_at: Date;
  is_chain_bonus: boolean;
}

/**
 * L'OFFRE EN ATTENTE d'un livreur, pour une appli ouverte depuis une
 * notification ou reconnectée : le socket ne rejoue pas `course:offer:new`
 * émis pendant que l'appli était fermée, et le bouton « Accepter » de la
 * notification attendait une offre qui n'arrivait jamais.
 *
 * Servie par `GET /courses/deliverer/me/offre` et renvoyée par le socket à la
 * connexion du livreur (DispatchListener). Seulement une offre encore valable :
 * en attente, pas échue, course toujours en recherche et pas chez Turbo.
 */
@Injectable()
export class OffreEnAttenteService {
  constructor(private readonly prisma: PrismaService) {}

  async pourLivreur(delivererId: string, maintenant = new Date()): Promise<OffreEnAttente | null> {
    const offre = await this.prisma.courseOfferAttempt.findFirst({
      where: {
        deliverer_id: delivererId,
        status: CourseOfferStatus.PENDING,
        expires_at: { gt: maintenant },
        course: { statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: null },
      },
      orderBy: { offered_at: 'desc' },
      select: { course_id: true, expires_at: true },
    });
    if (!offre) return null;

    const course = await this.prisma.course.findUnique({
      where: { id: offre.course_id },
      include: COURSE_FULL_INCLUDE,
    });
    if (!course) return null;

    return {
      offer_id: course.id,
      course: course as unknown as CourseWithDetails,
      expires_at: offre.expires_at,
      // Chaînage suspendu (deliverer-scoring.service.ts) : jamais de badge.
      is_chain_bonus: false,
    };
  }
}
