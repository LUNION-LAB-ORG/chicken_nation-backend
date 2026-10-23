import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { PrismaService } from 'src/database/services/prisma.service';

import { CourseChannels } from '../enums/course-channels';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import type { CourseOfferNewPayload, CourseStatutChangedPayload, CourseWithDetails } from '../interfaces/course-event.interface';
import type { OffreExpireePayload } from '../services/offres-cloture.service';
import { CourseWebSocketService } from '../websockets/course-websocket.service';

/** Raisons de `course:statut:changed` pour le suivi des offres (siège et restaurant). */
export const RaisonsSuiviOffre = {
  OFFRE_PROPOSEE: 'OFFRE_PROPOSEE',
  OFFRE_REFUSEE: 'OFFRE_REFUSEE',
  /** Laissée sans réponse jusqu'à son échéance. */
  OFFRE_EXPIREE: 'OFFRE_EXPIREE',
  /** Close par le serveur, sans pénalité (fusion, pause, Turbo, reprise…). */
  OFFRE_CLOSE: 'OFFRE_CLOSE',
} as const;

/**
 * ÉCRAN OPÉRATIONS ET CAISSE À JOUR EN DIRECT QUAND UNE OFFRE CHANGE
 * (relecture du 23/10).
 *
 * Les événements d'offre (`course:offer:new`, `course:offer:expired`) ne
 * partent qu'au livreur sollicité, et le refus n'est qu'un événement interne :
 * « Proposée à Koffi, réponse avant 12 h 36 » n'apparaissait au siège et au
 * restaurant qu'au rechargement suivant. Chaque offre proposée (hors renvoi
 * d'une offre déjà affichée), refusée, expirée ou close envoie désormais
 * `course:statut:changed`, avec la raison de l'offre, au siège et au
 * restaurant (jamais au livreur) : les écrans rechargent la course.
 *
 * Fusion : la course cible annonce `COURSES_FUSIONNEES` et la course absorbée
 * `course:cancelled` (ApplicationPlanService), déjà au siège et au restaurant.
 *
 * N'échoue jamais : un suivi manqué ne doit rien casser.
 */
@Injectable()
export class SuiviOffresListener {
  private readonly logger = new Logger(SuiviOffresListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ws: CourseWebSocketService,
  ) {}

  @OnEvent(CourseChannels.COURSE_OFFER_NEW)
  async onProposee(payload: CourseOfferNewPayload): Promise<void> {
    if (!payload?.course || payload.renvoi) return;
    this.annoncer(payload.course, RaisonsSuiviOffre.OFFRE_PROPOSEE, {
      deliverer_id: payload.deliverer_id,
      expires_at: payload.expires_at ?? null,
    });
  }

  @OnEvent(CourseChannels.COURSE_OFFER_REFUSED)
  async onRefusee(payload: { course_id: string; deliverer_id: string }): Promise<void> {
    await this.relireEtAnnoncer(payload?.course_id, RaisonsSuiviOffre.OFFRE_REFUSEE, { deliverer_id: payload?.deliverer_id });
  }

  @OnEvent(CourseChannels.COURSE_OFFER_EXPIRED)
  async onExpiree(payload: OffreExpireePayload): Promise<void> {
    const expiree = !payload?.motif || payload.motif === 'EXPIREE';
    await this.relireEtAnnoncer(payload?.course_id, expiree ? RaisonsSuiviOffre.OFFRE_EXPIREE : RaisonsSuiviOffre.OFFRE_CLOSE, {
      deliverer_id: payload?.deliverer_id,
      motif: payload?.motif ?? null,
    });
  }

  private async relireEtAnnoncer(courseId: string | null | undefined, raison: string, offre: CourseStatutChangedPayload['offre']) {
    if (!courseId) return;
    try {
      const course = await this.prisma.course.findUnique({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
      if (course) this.annoncer(course as unknown as CourseWithDetails, raison, offre);
    } catch (err) {
      this.logger.warn(`Suivi de l'offre non envoyé (${raison}) : ${(err as Error)?.message ?? err}`);
    }
  }

  private annoncer(course: CourseWithDetails, raison: string, offre: CourseStatutChangedPayload['offre']) {
    try {
      this.ws.emitSuiviOffre({
        course,
        previous_statut: course.statut,
        new_statut: course.statut,
        reason: raison,
        ...(offre?.deliverer_id ? { offre } : {}),
      });
    } catch (err) {
      this.logger.warn(`Suivi de l'offre non envoyé (${raison}) : ${(err as Error)?.message ?? err}`);
    }
  }
}
