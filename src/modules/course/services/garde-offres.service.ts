import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CourseOfferStatus, CourseStatut } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import {
  SELECT_ETAT_LIVREUR,
  etatLivreurDepuis,
  messageRefusOffre,
} from 'src/modules/deliverers/helpers/disponibilite.rules';

import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import {
  MESSAGE_COURSE_NE_CHERCHE_PLUS,
  MESSAGE_COURSE_PLUS_DISPONIBLE,
  courseChercheLivreur,
  decisionAcceptation,
  decisionAffectationForcee,
  decisionRelance,
} from '../helpers/offres.rules';
import { DispatchJournalService } from './dispatch-journal.service';
import { OffresClotureService } from './offres-cloture.service';

/** Acceptation refusée dans la transaction (rien n'est écrit). */
class AcceptationImpossible extends Error {
  constructor(readonly motif: 'OFFRE_PLUS_EN_ATTENTE' | 'COURSE_PLUS_EN_RECHERCHE') {
    super(motif);
  }
}

/**
 * GARDES DES OFFRES : la règle unique `peutRecevoirOffre` appliquée aux
 * sources d'offre qui ne passent pas par la sélection automatique.
 *
 *  - affectation forcée par l'administrateur : 409 avec la raison
 *    (« Ce livreur est en pause jusqu'à 14 h 32. ») ;
 *  - relances à 30 et 60 s : offre close si la course ou le livreur ne s'y
 *    prête plus ;
 *  - acceptation CONDITIONNELLE : la course doit encore chercher un livreur,
 *    ne pas être chez Turbo, et l'offre être encore en attente pour ce
 *    livreur ; sinon 409 « Cette course n'est plus disponible. » et offre
 *    close.
 *
 * Chaque refus est écrit au journal de la diffusion. Logique gardée hors de
 * `course-offer.service.ts` et `course-action.service.ts` (chantier du code
 * de retrait), qui ne font qu'appeler ces méthodes.
 */
@Injectable()
export class GardeOffresService {
  private readonly logger = new Logger(GardeOffresService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloture: OffresClotureService,
    private readonly journal: DispatchJournalService,
  ) {}

  // ============================================================
  // AFFECTATION FORCÉE (admin)
  // ============================================================

  /**
   * Le livreur peut-il recevoir cette course de force ? Même règle que la
   * sélection automatique, et la course doit encore chercher un livreur.
   *
   * @returns `renvoi` : le livreur a déjà l'offre de cette course, la
   *   notification est simplement renvoyée.
   * @throws ConflictException (409) avec la raison en français.
   */
  async verifierAffectationForcee(
    courseId: string,
    delivererId: string,
    maintenant = new Date(),
  ): Promise<{ renvoi: boolean }> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, reference: true, restaurant_id: true, statut: true, turbo_escalated_at: true },
    });
    if (!course) throw new NotFoundException('Course introuvable');

    const ligne = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: SELECT_ETAT_LIVREUR,
    });
    if (!ligne) throw new NotFoundException('Livreur non trouvé');

    const refuser = async (motif: string, message: string, details: Record<string, unknown> = {}) => {
      await this.journal.ecrire({
        type: 'AFFECTATION_FORCEE_REFUSEE',
        motif,
        source: 'admin',
        restaurant_id: course.restaurant_id,
        course_id: course.id,
        deliverer_id: delivererId,
        details: { course: course.reference, ...details },
      });
      return new ConflictException(message);
    };

    if (!courseChercheLivreur(course)) {
      throw await refuser('COURSE_PLUS_EN_RECHERCHE', MESSAGE_COURSE_NE_CHERCHE_PLUS, {
        statut: course.statut,
        chez_turbo: course.turbo_escalated_at !== null,
      });
    }

    const offres = await this.prisma.courseOfferAttempt.findMany({
      where: { deliverer_id: delivererId, status: CourseOfferStatus.PENDING },
      select: { course_id: true },
    });
    const etat = etatLivreurDepuis(ligne);
    const decision = decisionAffectationForcee(etat, offres, courseId, maintenant);
    if (!decision.ok) {
      throw await refuser(decision.motif, messageRefusOffre(decision.motif, etat, maintenant), {
        pause_until: etat.pause_until?.toISOString() ?? null,
        auto_pause_until: etat.auto_pause_until?.toISOString() ?? null,
      });
    }
    return { renvoi: decision.renvoi };
  }

  /**
   * Avant l'affectation forcée : les offres en attente d'AUTRES livreurs sur
   * cette course sont closes (sans pénalité). Jamais deux livreurs sollicités
   * pour la même course : le second à accepter aurait reçu un 409.
   */
  async cloreAutresOffres(courseId: string, delivererId: string): Promise<void> {
    const autres = await this.prisma.courseOfferAttempt.findMany({
      where: {
        course_id: courseId,
        status: CourseOfferStatus.PENDING,
        deliverer_id: { not: delivererId },
      },
      select: { id: true },
    });
    for (const o of autres) {
      await this.cloture.cloreOffre(o.id, 'AFFECTATION_FORCEE', {
        relancerRecherche: false,
        source: 'admin',
        details: { livreur_choisi: delivererId },
      });
    }
  }

  // ============================================================
  // RELANCES (30 et 60 s)
  // ============================================================

  /**
   * La relance de cette offre peut-elle partir ? Sinon l'offre est close sans
   * pénalité (`course:offer:expired` au livreur, recherche relancée si la
   * course cherche encore) et la relance n'est pas envoyée.
   */
  async relanceAutorisee(offreId: string, maintenant = new Date()): Promise<boolean> {
    const offre = await this.prisma.courseOfferAttempt.findUnique({
      where: { id: offreId },
      select: {
        id: true,
        status: true,
        course: { select: { statut: true, turbo_escalated_at: true } },
        deliverer: { select: SELECT_ETAT_LIVREUR },
      },
    });
    if (!offre || offre.status !== CourseOfferStatus.PENDING) return false;

    const decision = decisionRelance(
      offre.course,
      offre.deliverer ? etatLivreurDepuis(offre.deliverer) : null,
      maintenant,
    );
    if (decision.relancer) return true;

    await this.cloture.cloreOffre(offreId, decision.motif, {
      maintenant,
      details: decision.motif_livreur ? { motif_livreur: decision.motif_livreur } : undefined,
    });
    return false;
  }

  /**
   * Course confiée à Turbo (bascule automatique ou manuelle) : ses offres en
   * attente sont closes AVANT l'envoi. L'appli ferme l'offre ; l'acceptation
   * serait de toute façon refusée (`turbo_escalated_at` posé).
   */
  async cloreAvantTurbo(courseId: string): Promise<void> {
    await this.cloture.clorePourCourse(courseId, 'COURSE_CONFIEE_A_TURBO', { relancerRecherche: false });
  }

  // ============================================================
  // ACCEPTATION
  // ============================================================

  /**
   * Acceptation CONDITIONNELLE d'une offre, dans une transaction :
   *  1. l'offre doit être encore en attente (et pas échue) pour CE livreur ;
   *  2. la course doit encore chercher un livreur (PENDING_ASSIGNMENT) et ne
   *     pas être confiée à Turbo.
   * Sinon rien n'est écrit, l'offre est close si elle était encore valable,
   * et 409 « Cette course n'est plus disponible. ». Avant tout, le livreur
   * doit pouvoir prendre une course (pas en pause, pas déjà en course).
   *
   * Après l'acceptation, les autres offres en attente de la course (affectation
   * forcée) et du livreur sont closes : jamais deux offres en attente.
   *
   * @returns la course acceptée (`COURSE_FULL_INCLUDE`).
   */
  async reserverAcceptation(courseId: string, delivererId: string, maintenant = new Date()) {
    const refuser = async (motif: string, message: string, restaurantId: string | null = null) => {
      await this.journal.ecrire({
        type: 'ACCEPTATION_REFUSEE',
        motif,
        source: 'appli',
        restaurant_id: restaurantId,
        course_id: courseId,
        deliverer_id: delivererId,
      });
      return new ConflictException(message);
    };

    const offre = await this.prisma.courseOfferAttempt.findFirst({
      where: { course_id: courseId, deliverer_id: delivererId, status: CourseOfferStatus.PENDING },
      select: { id: true, expires_at: true, course: { select: { restaurant_id: true } } },
    });
    // Offre close, refusée, expirée : l'expiration d'une offre échue reste à
    // la tâche d'expiration (elle compte comme une offre ignorée).
    if (!offre || offre.expires_at.getTime() <= maintenant.getTime()) {
      throw await refuser('OFFRE_PLUS_EN_ATTENTE', MESSAGE_COURSE_PLUS_DISPONIBLE);
    }
    const restaurantId = offre.course?.restaurant_id ?? null;

    const ligne = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: SELECT_ETAT_LIVREUR,
    });
    const decision = ligne
      ? decisionAcceptation(etatLivreurDepuis(ligne), maintenant)
      : ({ ok: false, motif: 'INACTIF', message: "Ton compte livreur n'est pas actif." } as const);
    if (!decision.ok) {
      await this.cloture.cloreOffre(offre.id, 'LIVREUR_INDISPONIBLE', {
        source: 'appli',
        details: { motif_livreur: decision.motif },
      });
      throw await refuser(decision.motif, decision.message, restaurantId);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const acceptee = await tx.courseOfferAttempt.updateMany({
          where: {
            id: offre.id,
            deliverer_id: delivererId,
            status: CourseOfferStatus.PENDING,
            expires_at: { gt: maintenant },
          },
          data: { status: CourseOfferStatus.ACCEPTED, responded_at: maintenant },
        });
        if (acceptee.count !== 1) throw new AcceptationImpossible('OFFRE_PLUS_EN_ATTENTE');

        const affectee = await tx.course.updateMany({
          where: {
            id: courseId,
            statut: CourseStatut.PENDING_ASSIGNMENT,
            turbo_escalated_at: null,
          },
          data: {
            deliverer_id: delivererId,
            statut: CourseStatut.ACCEPTED,
            assigned_at: maintenant,
            offer_expires_at: null,
          },
        });
        if (affectee.count !== 1) throw new AcceptationImpossible('COURSE_PLUS_EN_RECHERCHE');
      });
    } catch (err) {
      if (!(err instanceof AcceptationImpossible)) throw err;
      // La transaction a tout annulé : l'offre est encore en attente si la
      // course a disparu. Elle est close (l'appli la ferme), sans pénalité.
      if (err.motif === 'COURSE_PLUS_EN_RECHERCHE') {
        await this.cloture.cloreOffre(offre.id, 'COURSE_PLUS_EN_RECHERCHE', { source: 'appli' });
      }
      throw await refuser(err.motif, MESSAGE_COURSE_PLUS_DISPONIBLE, restaurantId);
    }

    await this.cloture
      .clorePourCourse(courseId, 'COURSE_PLUS_EN_RECHERCHE', { relancerRecherche: false })
      .catch((e) => this.logger.warn(`Clôture des autres offres de la course impossible : ${e?.message}`));
    await this.cloture
      .clorePourLivreur(delivererId, 'LIVREUR_INDISPONIBLE')
      .catch((e) => this.logger.warn(`Clôture des autres offres du livreur impossible : ${e?.message}`));

    return this.prisma.course.findUniqueOrThrow({
      where: { id: courseId },
      include: COURSE_FULL_INCLUDE,
    });
  }
}
