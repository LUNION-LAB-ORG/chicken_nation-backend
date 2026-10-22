import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererQueueService } from 'src/modules/deliverers/services/deliverer-queue.service';
import { DisponibiliteLivreurService } from 'src/modules/deliverers/services/disponibilite-livreur.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { EVENEMENT_LIVREUR_CONNECTE } from 'src/socket-io/utils/evenements-connexion.util';

import { CourseChannels } from '../enums/course-channels';
import { DispatchEvenements } from '../enums/dispatch-evenements';
import type {
  CourseAssignedPayload,
  CourseCancelledPayload,
  CourseOfferNewPayload,
} from '../interfaces/course-event.interface';
import { CourseOfferService } from '../services/course-offer.service';
import { DispatchJournalService, SourceDispatch } from '../services/dispatch-journal.service';
import { OffreEnAttenteService } from '../services/offre-en-attente.service';
import { OffresClotureService, type OffreExpireePayload } from '../services/offres-cloture.service';

/** Qui a annulé la course (`Course.cancelled_by`), pour le journal. */
const SOURCE_ANNULATION: Record<string, SourceDispatch> = {
  admin: 'admin',
  restaurant: 'restaurant',
  deliverer: 'appli',
  system: 'serveur',
};

/**
 * Diffusion des offres, côté bus interne :
 *  - journal des offres proposées, acceptées, refusées et expirées ;
 *  - filet « hors service sans signal » quand une offre expire ;
 *  - relance de la recherche après la clôture d'une offre (OffresClotureService,
 *    fourni à tous les modules, ne dépend pas de CourseOfferService) ;
 *  - renvoi de l'offre en attente au livreur qui ouvre un socket ;
 *  - course annulée : ses offres en attente closes, son livreur remis en file.
 *
 * Toutes les erreurs sont avalées et journalisées : un écouteur ne doit
 * jamais faire échouer l'action qui a émis l'événement.
 */
@Injectable()
export class DispatchListener {
  private readonly logger = new Logger(DispatchListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly offres: CourseOfferService,
    private readonly offreEnAttente: OffreEnAttenteService,
    private readonly journal: DispatchJournalService,
    private readonly disponibilite: DisponibiliteLivreurService,
    private readonly gateway: AppGateway,
    private readonly cloture: OffresClotureService,
    private readonly queue: DelivererQueueService,
  ) {}

  @OnEvent(CourseChannels.COURSE_OFFER_NEW)
  async onOffreProposee(payload: CourseOfferNewPayload) {
    // Nouvel envoi d'une offre déjà en attente (affectation forcée répétée) : déjà comptée.
    if (payload.renvoi) return;
    await this.journal.ecrire({
      type: 'OFFRE_PROPOSEE',
      source: 'serveur',
      restaurant_id: payload.course.restaurant_id,
      course_id: payload.course.id,
      deliverer_id: payload.deliverer_id,
      details: {
        course: payload.course.reference,
        expire: new Date(payload.expires_at).toISOString(),
        livraisons: payload.course.deliveries?.length ?? null,
      },
    });
  }

  @OnEvent(CourseChannels.COURSE_ASSIGNED)
  async onOffreAcceptee(payload: CourseAssignedPayload) {
    const { course } = payload;
    await this.journal.ecrire({
      type: 'OFFRE_ACCEPTEE',
      source: 'appli',
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer_id,
      details: { course: course.reference },
    });
  }

  @OnEvent(CourseChannels.COURSE_OFFER_REFUSED)
  async onOffreRefusee(payload: { course_id: string; deliverer_id: string; raison?: string | null }) {
    const course = await this.lireCourse(payload.course_id);
    await this.journal.ecrire({
      type: 'OFFRE_REFUSEE',
      source: 'appli',
      restaurant_id: course?.restaurant_id ?? null,
      course_id: payload.course_id,
      deliverer_id: payload.deliverer_id,
      details: { course: course?.reference ?? null, raison: payload.raison ?? null },
    });
  }

  /**
   * Offre laissée sans réponse (`motif: 'EXPIREE'`). Les clôtures du serveur
   * passent aussi par ce canal (pour l'appli) mais sont déjà journalisées par
   * OffresClotureService : ignorées ici.
   *
   * Expiration sans pénalité (`penalite: false` : course plus en recherche,
   * livreur en pause) : journalisée, mais pas de filet « hors service ».
   */
  @OnEvent(CourseChannels.COURSE_OFFER_EXPIRED)
  async onOffreExpiree(payload: OffreExpireePayload) {
    if (payload.motif !== 'EXPIREE') return;
    const penalite = payload.penalite !== false;
    const course = await this.lireCourse(payload.course_id);
    await this.journal.ecrire({
      type: 'OFFRE_EXPIREE',
      motif: penalite ? null : (payload.sans_penalite ?? null),
      source: 'serveur',
      restaurant_id: course?.restaurant_id ?? null,
      course_id: payload.course_id,
      deliverer_id: payload.deliverer_id,
      details: { course: course?.reference ?? null, penalite },
    });
    if (!penalite) return;
    try {
      await this.disponibilite.mettreHorsServiceSiSansSignal(payload.deliverer_id);
    } catch (err) {
      this.logger.warn(
        `Filet hors service pour ${payload.deliverer_id.slice(0, 8)} impossible : ${(err as Error)?.message}`,
      );
    }
  }

  @OnEvent(DispatchEvenements.RECHERCHE_A_RELANCER)
  async onRechercheARelancer(payload: { course_id: string }) {
    try {
      await this.offres.offerNextDeliverer(payload.course_id);
    } catch (err) {
      this.logger.warn(
        `Relance de la recherche pour la course ${payload.course_id.slice(0, 8)} impossible : ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * Course annulée (administration, restaurant, livreur, tâche automatique) :
   *  - ses offres en attente sont closes, sans pénalité (l'appli du livreur
   *    sollicité les ferme) ;
   *  - son livreur revient dans la file, sauf en pause. Annulée par
   *    l'administration ou le restaurant, il n'y est pour rien : il reprend la
   *    place de son acceptation. Sinon, fin de file.
   */
  @OnEvent(CourseChannels.COURSE_CANCELLED)
  async onCourseAnnulee(payload: CourseCancelledPayload) {
    const { course, cancelled_by } = payload;
    const source = SOURCE_ANNULATION[cancelled_by] ?? 'serveur';
    try {
      await this.cloture.clorePourCourse(course.id, 'COURSE_ANNULEE', { relancerRecherche: false, source });
    } catch (err) {
      this.logger.warn(
        `Clôture des offres de la course annulée ${course.id.slice(0, 8)} impossible : ${(err as Error)?.message}`,
      );
    }
    if (!course.deliverer_id) return;

    const sansFaute = (cancelled_by === 'admin' || cancelled_by === 'restaurant') && course.assigned_at;
    const place = sansFaute ? new Date(course.assigned_at!) : new Date();
    try {
      if (await this.queue.remettreEnFile(course.deliverer_id, place)) {
        await this.journal.ecrire({
          type: 'REMIS_EN_FILE',
          motif: 'COURSE_ANNULEE',
          source,
          restaurant_id: course.restaurant_id,
          course_id: course.id,
          deliverer_id: course.deliverer_id,
          details: { course: course.reference, place: place.toISOString(), annulee_par: cancelled_by },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Remise en file de ${course.deliverer_id.slice(0, 8)} impossible : ${(err as Error)?.message}`,
      );
    }
  }

  /** Restaurant et référence d'une course, pour le journal (null si introuvable ou en cas d'erreur). */
  private lireCourse(courseId: string) {
    return this.prisma.course
      .findUnique({ where: { id: courseId }, select: { restaurant_id: true, reference: true } })
      .catch(() => null);
  }

  /** Le livreur ouvre un socket : on lui renvoie son offre en attente, s'il en a une. */
  @OnEvent(EVENEMENT_LIVREUR_CONNECTE)
  async onLivreurConnecte(payload: { delivererId: string }) {
    try {
      const offre = await this.offreEnAttente.pourLivreur(payload.delivererId);
      if (!offre) return;
      this.gateway.emitToDeliverer(payload.delivererId, CourseChannels.COURSE_OFFER_NEW, offre);
    } catch (err) {
      this.logger.warn(
        `Renvoi de l'offre en attente à ${payload.delivererId.slice(0, 8)} impossible : ${(err as Error)?.message}`,
      );
    }
  }
}
