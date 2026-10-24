import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CourseOfferStatus, CourseStatut, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { CourseChannels } from '../enums/course-channels';
import { DispatchEvenements } from '../enums/dispatch-evenements';
import { CLASSE_VERROU_OFFRE_LIVREUR } from '../helpers/offres.rules';
import { DispatchJournalService, SourceDispatch } from './dispatch-journal.service';

/** Pourquoi le serveur clôt une offre en attente. Jamais de pénalité pour le livreur. */
export type MotifClotureOffre =
  /** Le livreur s'est mis en pause. */
  | 'LIVREUR_EN_PAUSE'
  /** Le livreur s'est déconnecté de l'appli. */
  | 'LIVREUR_DECONNECTE'
  /** Le livreur a été mis hors service (offre ignorée sans aucun signal). */
  | 'LIVREUR_HORS_SERVICE'
  /** Le livreur ne peut plus recevoir d'offre (règle `peutRecevoirOffre`), vu à une relance. */
  | 'LIVREUR_INDISPONIBLE'
  /**
   * L'appli du livreur est fermée (ni socket ni signe de vie depuis
   * `deliverer.appli_fermee_apres_s`) : offre close par la tâche des
   * relances, ou à son échéance, sans pénalité ni exclusion de la course.
   */
  | 'APPLI_FERMEE'
  /** La course a été fusionnée dans une autre. */
  | 'COURSE_FUSIONNEE'
  /** La course a été confiée à Turbo. */
  | 'COURSE_CONFIEE_A_TURBO'
  /** La course a été annulée. */
  | 'COURSE_ANNULEE'
  /** La course ne cherche plus de livreur (acceptée par un autre, expirée…). */
  | 'COURSE_PLUS_EN_RECHERCHE'
  /** L'administrateur a forcé l'affectation de la course à un autre livreur. */
  | 'AFFECTATION_FORCEE'
  /**
   * Planificateur : course reprise pour un livreur libre qui serait au
   * restaurant bien plus tôt (zéro temps mort). Préfixe `COURSE_` : l'appli
   * du livreur (déjà installée) vibre et affiche « Course retirée ».
   */
  | 'COURSE_REPRISE';

export interface OptionsCloture {
  /**
   * Relancer la recherche d'un livreur pour chaque course qui en cherche
   * encore un (en recherche et pas chez Turbo). Défaut : oui.
   */
  relancerRecherche?: boolean;
  /** Qui déclenche la clôture (journal). Défaut : `serveur`. */
  source?: SourceDispatch;
  /** Ajouté à chaque ligne du journal. */
  details?: Record<string, unknown>;
  maintenant?: Date;
}

export interface OffreClose {
  offre_id: string;
  course_id: string;
  deliverer_id: string;
  /** La recherche d'un livreur a été relancée pour cette course. */
  recherche_relancee: boolean;
}

/** Charge utile de `course:offer:expired` (socket du livreur et bus interne). */
export interface OffreExpireePayload {
  course_id: string;
  deliverer_id: string;
  /** `EXPIREE` pour une offre laissée sans réponse, sinon le motif de clôture. */
  motif?: MotifClotureOffre | 'EXPIREE';
  /**
   * Offre expirée seulement : faux quand l'expiration n'a rien coûté au livreur
   * (course plus en recherche, livreur en pause). Ni pénalité ni filet alors.
   * Appli fermée : l'offre n'expire pas, elle est close (`APPLI_FERMEE`).
   */
  penalite?: boolean;
  /** Offre expirée sans pénalité : pourquoi (journal). */
  sans_penalite?: string;
}

const SELECT_OFFRE = {
  id: true,
  course_id: true,
  deliverer_id: true,
  expires_at: true,
  course: {
    select: { reference: true, restaurant_id: true, statut: true, turbo_escalated_at: true },
  },
} satisfies Prisma.CourseOfferAttemptSelect;

/**
 * CLÔTURE DES OFFRES EN ATTENTE, sans pénalité.
 *
 * Une offre en attente est close (statut `CANCELLED`) quand le livreur se met
 * en pause ou se déconnecte, ou quand sa course est fusionnée, part chez
 * Turbo, est annulée ou n'est plus en recherche. Pour chaque offre close :
 *  1. réservation ATOMIQUE (mise à jour conditionnée sur `PENDING`) : avec
 *     deux serveurs, une seule clôture compte, et une offre acceptée ou
 *     expirée entre-temps n'est pas touchée ;
 *  2. `course:offer:expired` au livreur : l'appli (ancienne comprise) ferme
 *     l'offre affichée ;
 *  3. la recherche d'un livreur est relancée si la course en cherche encore un
 *     (par le bus interne : `DispatchListener` appelle `offerNextDeliverer`) ;
 *  4. une ligne `OFFRE_CLOSE` au journal, avec le motif.
 *
 * Aucune pénalité, aucun refus compté : le livreur n'a rien refusé.
 *
 * Fourni par `DispatchCommunModule` (global) : utilisable depuis les modules
 * course, livreurs et authentification sans dépendance circulaire.
 */
@Injectable()
export class OffresClotureService {
  private readonly logger = new Logger(OffresClotureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly journal: DispatchJournalService,
  ) {}

  /** Clôt toutes les offres en attente d'un livreur (pause, déconnexion, hors service). */
  clorePourLivreur(
    delivererId: string,
    motif: MotifClotureOffre,
    options: OptionsCloture = {},
  ): Promise<OffreClose[]> {
    return this.clore({ deliverer_id: delivererId }, motif, options);
  }

  /** Clôt les offres en attente d'une course (fusion, Turbo, annulation). */
  clorePourCourse(
    courseId: string,
    motif: MotifClotureOffre,
    options: OptionsCloture = {},
  ): Promise<OffreClose[]> {
    return this.clore({ course_id: courseId }, motif, options);
  }

  /** Clôt une offre précise si elle est encore en attente. */
  cloreOffre(
    offreId: string,
    motif: MotifClotureOffre,
    options: OptionsCloture = {},
  ): Promise<OffreClose[]> {
    return this.clore({ id: offreId }, motif, options);
  }

  private async clore(
    ou: Prisma.CourseOfferAttemptWhereInput,
    motif: MotifClotureOffre,
    options: OptionsCloture,
  ): Promise<OffreClose[]> {
    const maintenant = options.maintenant ?? new Date();
    const relancer = options.relancerRecherche ?? true;

    const lire = (client: Pick<Prisma.TransactionClient, 'courseOfferAttempt'>) =>
      client.courseOfferAttempt.findMany({
        where: { ...ou, status: CourseOfferStatus.PENDING },
        select: SELECT_OFFRE,
      });
    // Offres d'un livreur (pause, déconnexion, hors service) : lues sous le
    // verrou que prend la création d'une offre (offerToDeliverer). Une offre
    // écrite avant est vue ici ; une offre écrite après relit l'état du
    // livreur (déjà en pause) et n'est pas créée. Rien ne passe entre les deux.
    const livreurId = typeof ou.deliverer_id === 'string' ? ou.deliverer_id : null;
    const offres = livreurId
      ? await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CLASSE_VERROU_OFFRE_LIVREUR}::int, hashtext(${livreurId}))`;
          return lire(tx);
        })
      : await lire(this.prisma);

    const closes: OffreClose[] = [];
    for (const offre of offres) {
      // 1. Réservation atomique : seule une offre encore en attente est close.
      const reservee = await this.prisma.courseOfferAttempt.updateMany({
        where: { id: offre.id, status: CourseOfferStatus.PENDING },
        data: { status: CourseOfferStatus.CANCELLED, responded_at: maintenant },
      });
      if (reservee.count !== 1) continue;

      // L'échéance affichée sur la course était celle de cette offre : on
      // l'efface, sans toucher à celle d'une offre plus récente ni au « pas
      // avant » d'un envoi Turbo.
      await this.prisma.course
        .updateMany({
          where: { id: offre.course_id, offer_expires_at: offre.expires_at },
          data: { offer_expires_at: null },
        })
        .catch(() => undefined);

      // 2. L'appli ferme l'offre affichée.
      this.eventEmitter.emit(CourseChannels.COURSE_OFFER_EXPIRED, {
        course_id: offre.course_id,
        deliverer_id: offre.deliverer_id,
        motif,
      } satisfies OffreExpireePayload);

      // 3. La course cherche encore un livreur : on relance la recherche.
      const chercheEncore =
        offre.course.statut === CourseStatut.PENDING_ASSIGNMENT &&
        offre.course.turbo_escalated_at === null;
      const rechercheRelancee = relancer && chercheEncore;
      if (rechercheRelancee) {
        this.eventEmitter.emit(DispatchEvenements.RECHERCHE_A_RELANCER, {
          course_id: offre.course_id,
        });
      }

      // 4. Journal.
      await this.journal.ecrire({
        type: 'OFFRE_CLOSE',
        motif,
        source: options.source ?? 'serveur',
        restaurant_id: offre.course.restaurant_id,
        course_id: offre.course_id,
        deliverer_id: offre.deliverer_id,
        offre_id: offre.id,
        details: {
          course: offre.course.reference,
          recherche_relancee: rechercheRelancee,
          ...options.details,
        },
      });

      closes.push({
        offre_id: offre.id,
        course_id: offre.course_id,
        deliverer_id: offre.deliverer_id,
        recherche_relancee: rechercheRelancee,
      });
    }

    if (closes.length > 0) {
      this.logger.log(
        `${closes.length} offre(s) close(s) sans pénalité (${motif}) : ${closes
          .map((c) => `course=${c.course_id.slice(0, 8)} livreur=${c.deliverer_id.slice(0, 8)}`)
          .join(' | ')}`,
      );
    }
    return closes;
  }
}
